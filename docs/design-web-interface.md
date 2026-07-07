# 設計: agvsr Web インタフェース

agvsr に Web インタフェースを追加するための要件・設計メモ。アイデア段階の合意事項を
次フェーズ（実装計画）に渡せる粒度でまとめる。

## 1. 目的とスコープ

3 つの価値を Web で提供する:

1. **リアルタイムタスク監視** — 全ジョブの状態と役割間メッセージの流れをブラウザで追える。
2. **作業完了時のプッシュ通知** — ブラウザを閉じていても終端状態を受け取れる。
3. **第三者に不正利用されないセキュリティ** — 後述の脅威モデルに耐える。

非対象（初版では扱わない）: team.yaml のGUI編集、課金/マルチテナント、外部公開SaaS化。

## 2. 最重要の前提（設計の背骨）

agvsr daemon は **シェルコマンドを実行しファイルを編集する AI エージェントをユーザー権限で
spawn する**。したがって Web から不正にジョブを投入できることは、**ユーザーのマシン上での
実質的なリモートコード実行 (RCE)** を意味する。

→ セキュリティは「機能の一つ」ではなく、**監視・通知を含む他の全機能を通すゲート**である。
本ドキュメントはこの前提を全体に貫く。

## 3. アクセス方針と操作権限（合意済み）

- **アクセス範囲**: localhost バインドのみ。リモートアクセスは Tailscale / Cloudflare
  Access / SSH トンネルなど、認証・TLS を実績ある層に外出しして実現する。直接インターネット
  公開はしない。
- **操作権限**: フル操作（監視 + tell/stop/kill + 新規ジョブ投入）。ただし「localhost に
  限ること」を唯一の防壁にはしない（§7 参照）。新規ジョブ投入＝任意エージェント実行であり、
  被害最大化点なので、アプリ層の防御を必須とする。

### 「localhost だけで十分」が成り立たない理由（要件化済みの盲点）

| 想定                                         | 実際                            |
| -------------------------------------------- | ------------------------------- |
| localhost に限ればネットワーク攻撃者は消える | ✅ 正しい（最大の脅威は消える） |
| だからフル操作でも無認証で安全               | ❌ 以下の経路が残る             |

1. **DNS リバインディング / ブラウザ駆動 CSRF**: 閲覧中の悪意あるページが
   `http://127.0.0.1:<port>` へリクエストでき、`Host`/`Origin` 未検証・無認証なら罠サイトを
   開いただけでジョブ投入＝RCE。localhost バインドでは防げない。
2. **同一マシンの他プロセス/他ユーザー**: TCP localhost に bind すると任意のローカルプロセス
   （怪しい依存・別ユーザー）が到達。
3. **トンネル層の設定ミス**: Cloudflare Tunnel は Access ポリシー無しだと既定で全世界公開。
   Tailscale も ACL 次第。「トンネル＝認証済み」ではない。
4. **信頼できない内容による XSS**: 監査ログはエージェント出力やリポジトリ内容であり攻撃者の
   影響下にある。生描画するとセッションを乗っ取られフル操作を奪われる。
5. **プッシュ通知は必ず外部に egress**: Web Push はブラウザベンダの push サービス経由。

→ 方針は **「localhost は外殻、認証は中身」の多層防御**。穴1つの失敗が即 RCE になる構造を避ける。

## 4. 全体構成

```
ブラウザ ──HTTP/WebSocket──> agvsr web (Bun.serve) ──IPC(Unix socket)──> agvsrd (daemon)
                                  │                                         │
                              push購読/通知                          既存 store / hooks
```

- `agvsr web [--host 127.0.0.1] [--port N] [--socket PATH]` という**別プロセス**として起動。
  Bun 内蔵 `Bun.serve`（HTTP + WebSocket）で実装し、依存を増やさない。
- Web 層は**既存 IPC のゲートウェイ**。daemon 本体のプロトコルを再利用し、daemon を作り直さない。
- daemon と疎結合（一方が落ちても他方は無事）。daemon 未起動時は明示エラー（自動起動は任意）。
- **フロントエンド: 軽量 SPA フレームワーク**（決定）。リッチな状態管理・画面遷移を取る。
  具体ライブラリは Preact / Svelte など小型ランタイムを第一候補とし、ビルドステップと依存は
  最小限に抑える（`oxlint`/`oxfmt`/`bun test` の既存規約に整合させる）。

### 活かせる既存資産

- **IPC トランスポート**: Unix domain socket / named pipe（`src/ipc/transport.ts`, `src/paths.ts`）。
- **サーバープッシュ**: `msg.watch → msg.new`（`src/protocol.ts`）。`watch` コマンドで多ジョブ
  横断購読が実証済み。
- **実行状態**: `JobRuntime`（in_flight / active_roles / idle_ms）を `job.get` から取得可能。
- **フック**: `src/hooks.ts`（`on_job_stalled`, `on_supervisor_message`）を通知トリガに転用可能。
- **RPC メソッド**: `job.create/list/get`, `msg.list/send/escalate/watch`, `job.tell/stop/kill`,
  `team.get`, `reload` など（`src/protocol.ts`）。

## 5. 機能要件: リアルタイム監視

- **ジョブ一覧**: status（running/done/failed/interrupted/stalled）・goal・作成/更新時刻・
  実行状態（in_flight / 稼働ロール / idle・possibly stalled）。
- **ジョブ詳細**: 役割間メッセージ（message/escalation/note/failure）のライブストリーム。
  `msg.watch` を WebSocket にブリッジ。
- **入室時の文脈復元**: 購読開始時に `msg.list` で既存履歴を流してから live に入る（`watch` と同作法）。
- **フィルタ**: status・ロール・all/running。
- **ストール可視化**: `JobRuntime.idle_ms` をバッジ/色で表示（possibly stalled を明示）。
- **履歴閲覧**: 完了ジョブの全監査ログ。
- **(将来) ターンのコスト/所要時間/トークン**: action-plan の未実装項目と連動。

### プロトコルのギャップと移行方針（決定）

現状 push は `msg.new`（メッセージ）のみで、**ジョブ status 遷移・新規ジョブ作成の push が無い**。

- **初版は `job.list` ポーリング**（2 秒間隔程度、`watch` と同等）で実装する。実用上十分。
- ジョブ数増加でポーリング負荷/遅延が問題化したら、**daemon に lifecycle push `job.update` を
  追加**（フェーズ5）。それまでは追加しない。

## 6. 機能要件: プッシュ通知

- **トリガ（既定値・決定）**: 終端状態への遷移（done/failed/interrupted/stalled）に加え、
  **escalation / 人間の入力待ち**も通知する。放置していても手を求められたら気づける粒度。
  `hooks.ts` を起点に転用。
- **配信路**: ブラウザを閉じていても届く必要があるため **Web Push（Service Worker + VAPID）が
  本命**。in-page 通知だけでは不十分。
- **付随要件**:
  - push subscription の登録/管理を store に永続化（§7 のシークレット保管と同一基盤）。
  - VAPID 鍵の生成・保管。
  - 重複排除、対象イベント遷移でのみ発火。
  - daemon が lifecycle イベントを emit できること（§5 ギャップと共通）。
- **プライバシー**: 通知本文は最小化（「ジョブ X が完了 / 対応待ち」程度）。詳細はクリックして
  localhost で取得（Web Push はベンダ push サービスを経由するため）。
- **代替/追加路（任意）**: OS ネイティブ通知、Slack/Discord webhook、メール。

## 7. セキュリティ要件（必須・他要件のゲート）

localhost バインドを前提にしても、以下は**すべて低コストかつ必須**。これにより「単一境界の失敗が
即 RCE」を避ける。

1. **アプリ層トークン認証（決定: 生成トークン → セッション cookie）**: 起動時に長いランダム
   トークンを表示し、ログインで **HttpOnly + Secure + SameSite セッション cookie** を発行する。
   トンネル側認証と二重化する。無認証にはしない。
2. **`Host` / `Origin` allowlist**: DNS リバインディング対策。許可ホスト以外は拒否。
3. **CSRF 対策**: 状態変更 API（job 投入/stop/kill/tell）に CSRF トークン。
4. **XSS 対策**: 監査ログ・エージェント出力は必ずエスケープ描画。CSP を設定。
5. **通知本文の最小化**: §6 のとおり。

### バインドとトランスポート

- 第一候補は **Unix domain socket（ファイル権限 0600）**。TCP が必要でも 127.0.0.1 限定 +
  トークン必須。
- 非 localhost 公開はしない方針だが、もし TCP を外に出す場合は TLS 必須（基本はトンネルに委譲）。

### シークレット保管（決定: 既存 store(SQLite) の専用テーブル）

- トークン（ハッシュ）・セッション・push subscription・VAPID 鍵は **既存 store(SQLite) の
  専用テーブル**に保管する。一元管理でバックアップ/マイグレーションが容易。store ファイルは
  `*.sqlite` として gitignore 済み。

### 多層防御の原則

- トンネルの認証を**唯一の防壁にしない**（Cloudflare Access / Tailscale ACL の設定ミスに備える）。
- 権限分離の余地: 将来、読み取り専用トークンと操作トークンを分けられる設計にしておく。
- **Web 操作の監査ログ**: 誰がいつ何を実行したか（特にジョブ投入/stop/kill）を記録。
- レート制限 / ブルートフォース対策（認証エンドポイント）。
- CORS は明示的に限定。

## 8. 非機能要件

- 複数ブラウザの同時接続（マルチクライアント購読）。
- 多数メッセージ流入時のバックプレッシャ処理。
- 単一バイナリ / サブコマンドとして同梱。設定は team.yaml もしくは別ファイル。
- クロスプラットフォーム（Unix socket / named pipe は既存 IPC が吸収済み）。
- テスト: ゲートウェイの RPC ブリッジ・認証・Host/Origin 検証・CSRF を `bun test` で網羅。
- 検証: `bun test` / `bun run typecheck` / `bunx oxlint src test` / `oxfmt`。

## 9. 段階的実装の想定（参考・別途実装計画で詳細化）

1. **最小ゲートウェイ**: `agvsr web`、Unix socket + トークン認証、`job.list` ポーリング、
   ジョブ一覧 + 詳細ログ（read-only）。Host/Origin/CSP/エスケープを最初から入れる。
2. **WebSocket ライブ購読**: `msg.watch` ブリッジで多ジョブ横断ストリーム。
3. **操作系**: tell/stop/kill/新規投入 + CSRF + Web 操作監査ログ。
4. **プッシュ通知**: Service Worker + VAPID + subscription 永続化 + lifecycle イベント
   （終端 + escalation/人間入力待ち）。
5. **(将来) daemon lifecycle push `job.update`**、ターンコスト可視化連動。

## 10. 決定事項（旧・未決事項）

| 論点                  | 決定                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------- |
| フロント実装方式      | **軽量 SPA フレームワーク**（Preact/Svelte 等、ビルド・依存は最小）                      |
| 認証 UX               | **生成トークン → ログインで HttpOnly セッション cookie**、トンネル認証と二重化           |
| lifecycle push の移行 | **初版は `job.list` ポーリング**、負荷/遅延が問題化したら `job.update` push（フェーズ5） |
| 通知トリガ既定        | **終端状態 + escalation / 人間入力待ち**                                                 |
| 新規シークレット保管  | **既存 store(SQLite) の専用テーブル**（トークン/セッション/push購読/VAPID鍵）            |

### 残る小論点（実装計画で確定）

- SPA の具体ライブラリ確定（Preact / Svelte / 他）とビルドツール構成。
- 認証 UX の細部（起動時トークン提示方法、トンネル認証との二重化の度合い）。
- 通知のクリック導線（localhost 詳細ページへのディープリンク設計）。
- Web 操作監査ログのスキーマ（store 内テーブル設計）。

## 11. Phase 3 実装設計: 操作 API + CSRF + Web 操作監査ログ

この節は §9-3 の実装承認用メモ。Phase 1/2 の `src/web/routes.ts` にある
Host/Origin allowlist、セッション cookie、CSRF cookie/header、CSP、read-only API、WebSocket
挙動を前提に、操作系だけを追加する。daemon IPC は既存の `job.tell` / `job.stop` /
`job.kill` / `job.create` をそのまま使い、daemon protocol は変更しない。Phase 4 push
notifications と Phase 5 lifecycle push は扱わない。

### 11.1 触るファイルと責務

- `src/web/routes.ts`
  - 既存の `handleWebRequest` に POST 操作ルートを追加する。
  - 既存の Host/Origin/session/CSRF 判定を共通化し、状態変更 API すべてで同じ順序で適用する。
  - request body の型・長さ・必須項目を検証し、`WebDaemonClient` に渡す。
  - 成功/失敗を `WebAuthStore` の web 操作監査ログへ記録する。
- `src/web/ipc.ts`
  - `createJob(goal, cwd, id?)`、`tellJob(jobId, body)`、`stopJob(jobId)`、`killJob(jobId)`
    を追加する薄いラッパー。
  - daemon error code/message を落とさず routes に返せるよう、必要なら `WebDaemonError`
    などの小さなエラー型を追加する。
- `src/web/auth-store.ts`
  - 既存 Web 用 SQLite store に `web_operation_audit` テーブルと `createWebOperationAudit` /
    `listWebOperationAudit`（テスト用・将来 UI 用）を追加する。
  - 認証 store と同じ DB 接続、WAL、migration 方針を使う。daemon store には書かない。
- `src/web/client/app.ts`
  - 既存 dependency-free DOM SPA のまま、job create フォーム、tell フォーム、stop/kill
    ボタンを追加する。
  - 既存 `api()` が `X-CSRF-Token` を付ける流れを再利用する。
  - すべて `textContent` / DOM node creation で描画し、`innerHTML` は使わない。
- `src/web/client/styles.css`
  - 既存レイアウトに操作フォームと危険操作ボタンの状態を足す。CSP を緩める inline style は使わない。
- `test/web-api.test.ts`
  - live daemon + live gateway + HTTP の操作 API 統合テストを追加する。
- `test/web-auth.test.ts` または `test/web-security.test.ts`
  - mutation endpoint の未認証、Origin 不正、CSRF 不正拒否を追加する。既存テストの重複が
    大きければ `test/web-api.test.ts` にまとめてもよい。
- `docs/progress.md`
  - 実装後に Phase 3 完了内容だけ追記する。

### 11.2 API contract、validation、error、CSRF/session

追加する HTTP API はすべて JSON POST とし、既存 read-only endpoint は変えない。

| Endpoint | Body | Success | daemon IPC |
| --- | --- | --- | --- |
| `POST /api/jobs` | `{ "goal": string, "cwd": string, "id"?: string }` | `201 { "job": JobView }` | `job.create` then `job.get` |
| `POST /api/jobs/:id/tell` | `{ "body": string }` | `200 { "queued": true, "message": Message }` | `job.tell` |
| `POST /api/jobs/:id/stop` | `{}` | `200 { "stopped": true }` | `job.stop` |
| `POST /api/jobs/:id/kill` | `{}` | `200 { "killed": true }` | `job.kill` |

Validation is deliberately web-local and conservative before IPC:

- All mutation requests must have an authenticated `__Host-agvsr_session` cookie.
- All mutation requests must pass the existing unsafe-method Origin allowlist.
- All mutation requests must pass double-submit CSRF: `X-CSRF-Token` header equals
  `__Host-agvsr_csrf` cookie and both are non-empty. Login keeps its existing startup-token special case;
  logout keeps current behavior.
- Invalid JSON is `400`.
- `goal`, `cwd`, and tell `body` must be strings after JSON parse and `trim()` non-empty.
- Max lengths: `goal` 8 KiB, tell `body` 64 KiB, `cwd` 4 KiB, optional `id` 128 bytes. These limits
  are only request guardrails; daemon remains source of truth for semantic validation such as cwd validity
  and custom id format.
- Unknown fields are ignored, not rejected.
- `:id` is `decodeURIComponent`-decoded; empty or malformed ids return `400`.

Error format should preserve existing web behavior for old endpoints: existing routes may continue returning
`{ "error": string }`. New mutation endpoints should return:

```json
{
  "error": {
    "code": "bad_request",
    "message": "message body must not be empty"
  }
}
```

Use HTTP status mapping:

- `400`: local validation failure or daemon `bad_request` / `provisioning_failed`.
- `401`: missing/invalid session.
- `403`: Host/Origin/CSRF rejection or daemon `forbidden`.
- `404`: unknown route or daemon `not_found`.
- `503`: daemon unavailable / no team configured (`no_team`) for create/tell.
- `500`: unexpected errors.

For daemon IPC errors, keep daemon `code` and `message` in the JSON body. Do not expose stack traces.

### 11.3 Web 操作監査ログ

Add this table to `src/web/auth-store.ts`:

```sql
CREATE TABLE IF NOT EXISTS web_operation_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_hash TEXT,
  operation TEXT NOT NULL,
  job_id TEXT,
  status TEXT NOT NULL,
  error_code TEXT,
  request_summary TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_web_operation_audit_created
  ON web_operation_audit(created_at);
CREATE INDEX IF NOT EXISTS idx_web_operation_audit_job
  ON web_operation_audit(job_id, created_at);
```

Semantics:

- Write one row for every authenticated mutation attempt after session validation, including CSRF failures
  where a session cookie can be resolved. If the request has no valid session, return `401` without audit.
- `operation`: one of `job.create`, `job.tell`, `job.stop`, `job.kill`, `session.logout` only if logout is
  brought into the same helper; login remains outside this Phase 3 audit unless implementation can add it
  without changing auth behavior.
- `status`: `attempted`, `success`, or `failure`.
- `session_hash`: hashed session token only; never store raw session token or CSRF token.
- `job_id`: route id for tell/stop/kill; created job id on successful create; `NULL` for failed create before
  daemon returns a job.
- `request_summary`: JSON string with bounded, non-secret metadata:
  - `job.create`: `{ "goal_preview": first 160 chars, "goal_length": n, "cwd": cwd, "custom_id": id ?? null }`
  - `job.tell`: `{ "body_preview": first 160 chars, "body_length": n }`
  - `job.stop` / `job.kill`: `{}`
- Never store raw auth tokens, CSRF tokens, cookie headers, request headers, full tell body, full goal, agent
  output, environment variables, or stack traces.
- Audit write failure must not execute the operation silently. Flow:
  1. Validate session and parse enough request data to build a bounded summary.
  2. Insert an `attempted` audit row.
  3. If CSRF or local validation fails, update that row to `failure` and return the error without IPC.
  4. If the initial insert fails, return `500` and do not call daemon.
  5. Call daemon IPC.
  6. Update the same row to `success` or `failure`, setting the final `job_id` for successful create.
  If the final update fails after IPC, the row remains `attempted`, which is acceptable because the attempt is
  still visible.

### 11.4 Client UI approach

Keep the current no-dependency DOM SPA:

- Add a compact create-job form above the job list with `goal`, `cwd`, and optional `id`. Default `cwd` can be
  an empty input; do not guess HOME or remap auth.
- Add a tell textarea and send button in the selected job detail view. Disable it unless the job status is
  `running`.
- Add stop and kill buttons in the selected job detail. Disable them unless `running`; style kill as the
  strongest danger action. Use native `confirm()` for kill to avoid adding modal infrastructure in Phase 3.
- On operation success, immediately refresh job list/detail and keep the existing polling/WebSocket behavior.
- On error, render a plain text error banner using `textContent`.
- Preserve CSP: no inline scripts/styles, no new external assets, no `innerHTML`.

### 11.5 Test strategy

Use the existing real integration style: `startDaemon` + `startWebGateway` + real HTTP fetch against the
gateway, with temp files and no extra services.

Harness:

- `mkdtempSync(tmpdir(), "agvsr-web-ops-")`.
- temp `sock`, `store.sqlite`, `repo`, fake `bin/claude`.
- set/restore `AGVSR_STORE`, `AGVSR_SOCK`, `AGVSR_WORKTREES`, `PATH`, `AGVSR_TURN_TIMEOUT_MS`, and fake
  delay env vars in `try/finally`.
- start daemon with `parseTeam` and the fake claude runner script already used by web tests.
- start gateway with `{ daemonEndpoint: sock, storeFile: db }`.
- login through `/api/session/login` and keep both session and csrf cookies.
- Always close `web`, `daemon`, IPC clients, and remove only the temp directory created by the test.

Coverage:

- `POST /api/jobs` creates a job via HTTP, returns a job view, writes a web audit row, and the daemon audit
  contains the user-to-supervisor initial message.
- `POST /api/jobs/:id/tell` queues a message through `job.tell`, returns daemon message shape, and writes
  bounded audit metadata without full body.
- `POST /api/jobs/:id/stop` transitions running job to `failed`, returns `{ stopped: true }`, writes audit.
- `POST /api/jobs/:id/kill` transitions running job to `interrupted`, aborts a delayed fake turn if needed,
  returns `{ killed: true }`, writes audit.
- Missing session returns `401`; missing/bad Origin on POST returns `403`; missing/wrong CSRF header returns
  `403`; no daemon call occurs for these cases.
- Bad JSON and empty strings return `400`.
- Existing `web-auth`, `web-api`, `web-security`, and `web-ws` assertions keep passing, especially read-only
  detail not marking messages read and websocket auth behavior.

Timeout handling:

- Use `AGVSR_TURN_TIMEOUT_MS=5000` or lower only in tests that need it.
- For stop/kill tests, do not rely on arbitrary long sleeps. Poll `GET /api/jobs/:id` with a bounded helper
  until status is expected or a short deadline fails the test with the latest response body.
- Fake runner delay should be explicit and restored to avoid cross-test leakage.

Run before handoff:

```sh
bun test test/web-auth.test.ts test/web-api.test.ts test/web-security.test.ts test/web-ws.test.ts
bun run typecheck
bunx oxlint src test
```

### 11.6 Alternatives considered

- Add new daemon methods for web operations: rejected because existing `job.*` IPC methods already express the
  required operations and changing protocol is out of scope.
- Store web operation audit in daemon `messages`: rejected because web access metadata is not an agent message,
  should not be shown as job conversation content, and must not risk altering read/unread semantics.
- Store raw request bodies for audit completeness: rejected because tell bodies/goals can contain secrets or
  repository data. Bounded previews and lengths give enough forensic value without retaining full content.
- Add a client framework or modal library for forms/confirmation: rejected by the no-new-dependencies constraint
  and because the current DOM SPA is sufficient for Phase 3.
- Implement lifecycle push so create/stop/kill updates are instant everywhere: rejected as Phase 5. Phase 3 keeps
  the current polling plus per-job message WebSocket model.
- Trust SameSite cookies without CSRF header: rejected because the security design explicitly requires CSRF on
  state-changing APIs, and the existing double-submit machinery is already present.

## 12. Phase 4 実装設計: プッシュ通知 (Service Worker + VAPID + subscription 永続化 + lifecycle トリガ)

この節は §9-4 / §6 の実装承認用メモ。Phase 1/2/3 の `src/web/`（Host/Origin allowlist、セッション
cookie、CSRF、CSP、read-only + mutation API、WebSocket、`WebAuthStore` の SQLite/WAL/migration 規約）と、
`src/daemon/daemon.ts` の既存 D26 フックディスパッチ（`on_job_done` / `on_job_failed` /
`on_supervisor_message` / `on_job_stalled`）を前提に、その上に Web Push を積む。Phase 5 の daemon
lifecycle push (`job.update`) は扱わず、監視 UI は既存の `job.list` ポーリングのままにする。

### 12.0 背骨となる 3 つの事実（設計の前提）

1. **daemon store と web auth-store は既定で同一 SQLite ファイル**。`startDaemon` の `storeFile` と
   `startWebGateway` の `storeFile` はどちらも `storePath()`（既定 `inbox.sqlite`、`AGVSR_STORE` で上書き）に
   解決される。したがって subscription / VAPID 鍵を `WebAuthStore` の新テーブルに置けば、**daemon プロセスも
   同じファイルからそれを読める**。これが Phase 5 を持ち込まずに daemon 側から push を送れる根拠。
2. **フックは既に正しい瞬間・正しい回数で発火している**。`daemon.ts` の `hook()` ヘルパが
   終端遷移（`job.complete` → done、`job.fail`/`job.stop` → failed、`job.kill` → interrupted、
   stall 検出 → stalled）と supervisor→user メッセージ（escalation / 人間の入力待ち）で一度ずつ発火する。
   Phase 4 はこの発火点に push を相乗りさせるだけで、daemon プロトコルもフック契約も変えない。
3. **`on_job_failed` イベントだけでは failed と interrupted を区別できない**（kill は
   `event: "job_failed"` を出しつつ status を `interrupted` にする）。よって通知の `status` は
   イベント名からではなく `store.getJob(job_id).status`（daemon が保持する権威値）から解決する。

4. **Web Push の暗号は Bun 組み込みの WebCrypto + `Buffer` で完結する**（ECDH P-256 /
   HKDF-SHA256 / AES-128-GCM / ES256 JWT はすべて `crypto.subtle` にある）。`web-push` パッケージや
   ビルドツールは不要。もし実装中に組み込みだけでは満たせない箇所が判明したら、依存を足さずに
   **ブロッカーとしてエスカレーションする**（現時点の調査では不要と結論）。

### 12.1 触るファイルと責務

- `src/web/auth-store.ts`
  - `web_vapid_keys`（単一行、`web_bootstrap_tokens` と同じ `id = 1` 方式）と `web_push_subscriptions`
    テーブルを既存 `SCHEMA` に追加する。同じ DB 接続・WAL・冪等 `CREATE IF NOT EXISTS` 方式
    （Phase 3 `web_operation_audit` と同一規約）。
  - アクセサを追加: `getOrCreateVapidKeys()`（無ければ生成して永続化し返す）、`getVapidPublicKey()`、
    `addPushSubscription(sub)`、`listPushSubscriptions()`、`removePushSubscription(endpoint)`。
- `src/web/push.ts`（新規）
  - Web Push 暗号一式を自己完結で実装する: VAPID JWT 署名（ES256）、RFC 8291 aes128gcm ペイロード暗号化、
    `sendPush(subscription, vapidKeys, payloadBytes)`（`fetch` で購読 endpoint へ POST、201/200 成功、
    404/410 は失効とみなし呼び出し側へ通知）。
  - `createPushNotifier(storeFile: string): (payload: { job_id: string; status: string }) => void`
    を公開する。これは storeFile 上に自前の `WebAuthStore` ハンドルを開き、VAPID 鍵 + 全 subscription を
    読み、最小ペイロードを暗号化して各 endpoint へ送る。`fireHook` と同じく **fire-and-forget・例外は
    握り潰す**（push が daemon を止めない）。404/410 の subscription は `removePushSubscription` で掃除する。
- `src/hooks.ts`
  - 既存 `HookEvent` / `fireHook` の隣に push 通知の抽象を置く: `PushPayload`（`{ job_id, status }`）と
    `PushNotifier` 型、既定の no-op notifier。daemon はこの型を注入経由で受け取る（web 実装を daemon に
    import させず、テストでスパイ注入できるようにするため）。
- `src/daemon/daemon.ts`
  - `StartDaemonOptions` に `pushNotifier?: PushNotifier`（既定 no-op、`hookRunner` と同じ注入パターン）を追加。
  - `hook()` ヘルパ内で、対象 4 フックのときに `status` を導出して `pushNotifier({ job_id, status })` を呼ぶ:
    `on_job_done`→`"done"`、`on_job_stalled`→`"stalled"`、`on_supervisor_message`→`"attention"`、
    `on_job_failed`→`store.getJob(job_id)?.status`（`"failed"` か `"interrupted"`）。daemon は web を import しない。
- `src/cli/agvsr.ts`
  - 本番の daemon 起動経路で、既定の実 notifier（`createPushNotifier(storeFile)` from `src/web/push.ts`）を
    `startDaemon` に注入する。これで daemon 単体でも（web GUI プロセスが起動していなくても）push が届く
    ＝「ブラウザを閉じていても届く」を満たす。web import はこの CLI 配線点に閉じる。
- `src/web/security.ts`
  - CSP に `worker-src 'self'` を追加する（Service Worker スクリプト取得のため）。`connect-src 'self'` は
    据え置き。**外部 push サービスへの接続はブラウザ内部（PushManager）と daemon 側 `fetch` が行うため、
    ページ CSP を外向きに緩める必要はない**。
- `src/web/routes.ts`
  - `GET /sw.js`（Service Worker、ルートスコープ配信、`Service-Worker-Allowed: /`）を追加。
  - `GET /api/push/config`（要セッション）→ `{ vapidPublicKey: base64url, enabled: true }`。
  - `POST /api/push/subscribe` / `POST /api/push/unsubscribe`（session + Origin + CSRF、Phase 3 mutation と
    同じ順序・同じヘルパ `authenticatedSessionHash` / `touchSession` / `csrfMatches` / `errorJson`）。
- `src/web/server.ts`
  - `ctx.assets` に `swJs`（`src/web/client/sw.ts` を既存 `loadClientSource` で transpile）を追加。VAPID 公開鍵は
    起動時に `authStore.getOrCreateVapidKeys()` で確定させておく。
- `src/web/client/sw.ts`（新規）
  - Service Worker。`push` イベントで最小ペイロードから `showNotification("agvsr", { body, tag, data })`、
    `notificationclick` で `/#/jobs/<id>` を開く/フォーカスする。`tag` に job_id を使い重複表示を抑える。
- `src/web/client/app.ts`
  - 「通知を有効化 / 無効化」トグルを追加。フロー: capability 検出 → `/sw.js` 登録 →
    `Notification.requestPermission()` → `/api/push/config` から公開鍵取得 →
    `registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })` →
    購読 JSON を `/api/push/subscribe` へ POST（既存 `api()` の `X-CSRF-Token` 経路を再利用）。無効化は
    `unsubscribe()` + `/api/push/unsubscribe`。すべて `textContent` / DOM 生成、`innerHTML` 不使用。
- `src/web/client/styles.css`
  - トグルと権限状態（未対応 / 拒否 / 有効）の表示スタイルを追加。inline style は使わない。
- `test/web-push.test.ts`（新規）— 12.6 参照。
- `test/hooks.test.ts`（または `test/web-push.test.ts`）— `pushNotifier` スパイでフック発火を検証。
- `docs/progress.md` — 実装後に Phase 4 完了内容だけ追記（本設計では触らない）。

### 12.2 データモデル（`WebAuthStore` 追加テーブル）

```sql
CREATE TABLE IF NOT EXISTS web_vapid_keys (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  public_key  TEXT NOT NULL,   -- base64url, raw uncompressed EC point (65 bytes)
  private_key TEXT NOT NULL,   -- PKCS8 (or JWK) base64, never leaves the server
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS web_push_subscriptions (
  endpoint    TEXT PRIMARY KEY,
  p256dh      TEXT NOT NULL,   -- base64url, subscriber public key
  auth        TEXT NOT NULL,   -- base64url, subscriber auth secret (16 bytes)
  created_at  TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
```

- VAPID 鍵はプロセス横断で 1 組を共有（生成は初回 `getOrCreateVapidKeys()` 時、以降は読み出し）。
  `private_key` は API では絶対に返さない。`public_key` のみ `/api/push/config` で配る。
- subscription は endpoint を主キーに upsert（同一ブラウザの再購読を重複させない）。
- 掃除: daemon 側の送信で 404/410 を受けたら `removePushSubscription(endpoint)`。

### 12.3 HTTP API（追加）

| Endpoint | Method | Auth | Body | Success |
| --- | --- | --- | --- | --- |
| `/sw.js` | GET | 不要 | — | `200` JS（`Service-Worker-Allowed: /`, `Content-Type: application/javascript`） |
| `/api/push/config` | GET | session | — | `200 { "vapidPublicKey": string, "enabled": true }` |
| `/api/push/subscribe` | POST | session + Origin + CSRF | `{ "endpoint": string, "keys": { "p256dh": string, "auth": string } }` | `201 { "subscribed": true }` |
| `/api/push/unsubscribe` | POST | session + Origin + CSRF | `{ "endpoint": string }` | `200 { "unsubscribed": true }` |

Validation（IPC 前の web ローカル、Phase 3 と同方針で保守的に）:

- subscribe/unsubscribe は認証済み `__Host-agvsr_session` cookie 必須（無ければ `401`）。
- unsafe method の Origin allowlist と double-submit CSRF（`X-CSRF-Token` == `__Host-agvsr_csrf`）を通す。
- `endpoint` は非空文字列かつ `https:` の絶対 URL であること（それ以外は `400`）。`p256dh`/`auth` は非空
  base64url 文字列で長さ上限を課す（例: endpoint 2 KiB、p256dh 256 B、auth 64 B）。上限超過や型不一致は `400`。
- 不正 JSON は `400`。未知フィールドは無視。エラー本文は Phase 3 と同じ `{ "error": { "code", "message" } }`。
- subscribe/unsubscribe は job を動かさない設定操作なので **Phase 3 の `web_operation_audit` には記録しない**
  （必要なら将来 `push.subscribe` として同ヘルパで足せる余地は残す）。

### 12.4 通知トリガと最小ペイロード（daemon 側）

- 発火点は既存 `hook()` の 4 箇所のみ。追加の daemon イベントも IPC も無い（Phase 5 を持ち込まない）。
- `pushNotifier({ job_id, status })` に渡す `status` は:
  - `on_job_done` → `"done"`
  - `on_job_failed` → `store.getJob(job_id)?.status`（`"failed"` / `"interrupted"` を正しく反映）
  - `on_job_stalled` → `"stalled"`
  - `on_supervisor_message` → `"attention"`（escalation / 人間の入力待ち。supervisor→user メッセージでのみ発火）
- **ペイロードは `{ "job_id": <id>, "status": <上記> }` のみ**。goal 文言・メッセージ本文・エージェント出力・
  reason は一切含めない（§6 / §7 の本文最小化）。job_id はランダム UUID であり、push ベンダに egress しても
  内容漏洩にならない。詳細は通知クリックで localhost を開いて取得する。
- 重複排除: 終端フックはトランジションごとに一度だけ発火（stall は既存 `stallNotified` セットでガード）。
  SW 側でも `tag: job_id` で同一ジョブの通知を畳む。`on_supervisor_message` は毎メッセージ発火し得るので
  **過剰通知の可能性を残論点とする**（12.8）。
- 送信は fire-and-forget: 例外・ネットワーク失敗は握り潰し、404/410 のみ subscription を掃除する。

### 12.5 Web Push 暗号（`src/web/push.ts`、組み込みのみ）

依存を増やさないための核。すべて `crypto.subtle` + `Buffer`（base64url）で実装する。

- **VAPID (RFC 8292)**: `crypto.subtle.sign("ECDSA", {hash:"SHA-256"}, …)` で JWT（header `{alg:ES256,typ:JWT}`,
  payload `{aud: <endpoint origin>, exp: now + <12h 未満>, sub: "mailto:agvsr@localhost"}`）を署名。
  `Authorization: vapid t=<jwt>, k=<base64url public key>` を付す。
- **ペイロード暗号 (RFC 8291 / aes128gcm, RFC 8188)**:
  1. サーバ側 ephemeral ECDH P-256 鍵を `generateKey`。
  2. 購読者 `p256dh` を raw import し `deriveBits(ECDH)` で共有秘密。
  3. `IKM = HKDF-Extract(auth_secret, ecdh_secret)` → `HKDF-Expand(key_info, 32)`、
     `key_info = "WebPush: info\0" || ua_public(65) || as_public(65)`。
  4. `salt`（16 ランダム）で `CEK = HKDF(salt, IKM, "Content-Encoding: aes128gcm\0", 16)`、
     `NONCE = HKDF(salt, IKM, "Content-Encoding: nonce\0", 12)`。
  5. 本文に区切り `0x02`（+任意パディング）を付け AES-128-GCM で暗号化。
  6. ヘッダ `salt(16) || rs(4=4096) || idlen(1=65) || as_public(65)` に暗号文を連結して body に。
  - リクエストヘッダ: `Content-Encoding: aes128gcm`, `Content-Type: application/octet-stream`, `TTL`,
    `Content-Length`, `Authorization`（VAPID）。
- 送信は `fetch(endpoint, { method: "POST", headers, body })`。実装リスクの中心はこの暗号の正しさなので、
  12.6 の往復スモークテストで担保する。

### 12.6 テスト戦略（`bun test`）

Phase 3 と同じ実在統合スタイル（`startDaemon` + `startWebGateway` + 実 HTTP、temp ファイル、外部サービス無し）。

1. **subscribe/unsubscribe エンドポイント**（`web-ops` 系ハーネスを流用）
   - 認証無し → `401`、Origin 不正 → `403`、CSRF 不正 → `403`、いずれも副作用なし。
   - 正常 subscribe → `web_push_subscriptions` に 1 行、`GET /api/push/config` が公開鍵を返す。
   - unsubscribe → 行削除。不正 JSON / 非 https endpoint / 上限超過 → `400`。
2. **フック発火（daemon 配線）**: `hooks.test.ts` と同じく `pushNotifier` にスパイを注入し、
   `job.create` → `job.complete`/`job.fail`/`job.stop`/`job.kill`/stall、及び supervisor→user `msg.send` で、
   スパイが期待 `{ job_id, status }`（done / failed / interrupted / stalled / attention）で一度ずつ呼ばれることを検証。
   **暗号を経由しない配線テスト**。
3. **実クリプトのスモークテスト（必須・モックしない）**:
   - `getOrCreateVapidKeys()` で実鍵生成。
   - 疑似ブラウザ購読を生成（P-256 ECDH 鍵ペア + 16 バイト auth secret → `{endpoint, keys:{p256dh, auth}}`）。
   - `push.ts` の暗号関数で `{job_id, status}` を aes128gcm 本文に暗号化し、**テスト内で購読者秘密鍵を使って
     RFC 8291 の逆手順で復号**、平文がペイロードに一致することを assert（鍵生成 + 暗号を実経路で往復）。
   - さらに `Bun.serve` でローカルの偽 push endpoint を立て、それを `endpoint` にして `sendPush` を実行し、
     受信側で `Content-Encoding: aes128gcm` と `Authorization: vapid …` ヘッダと本文が届くことを assert。
     404/410 を返す偽 endpoint で subscription が掃除されることも確認。

Run before handoff:

```sh
bun test test/web-push.test.ts test/hooks.test.ts test/web-ops.test.ts
bun run typecheck
bunx oxlint src test
oxfmt
```

### 12.7 「end-to-end で動く」の定義

- **エントリポイント**: `agvsr web` を `http://localhost:<PORT>`（TCP loopback）で配信。Service Worker / Push は
  secure context を要求するため `http://localhost`・`http://127.0.0.1`・HTTPS トンネルで成立する。
  **Unix domain socket 経由や非 localhost の平文 HTTP ではブラウザが Push を許可しない**（12.8 リスク）。
- **ハッピーパス**: ログイン → 「通知を有効化」→ 権限付与 → subscription 永続化。以後、あるジョブが
  done に遷移 → daemon の `pushNotifier` が aes128gcm 暗号本文を購読 endpoint へ POST → ブラウザ SW が
  `push` を受け「agvsr / Job <id> done」を表示 → クリックで該当ジョブ詳細へ。
- **成功条件（自動検証で機械的に示せる部分）**: (a) subscribe が行を永続化し、(b) `job.complete` などが
  daemon notifier に正しい `{job_id, status}` を渡し、(c) 実鍵での暗号本文が偽 push endpoint に正しいヘッダ付きで
  到達し、購読者鍵で復号可能。実ブラウザ + 実 push サービスの通知表示は手動 e2e で確認する。

### 12.8 リスクと残論点

- **Secure context 制約**: Push は localhost TCP か HTTPS トンネル前提。Unix socket / 非 localhost 平文では
  不可。UI は capability 検出で「この接続経路では通知を利用できません」と degrade する必要がある。
- **`on_supervisor_message` の過剰通知**: supervisor→user の全メッセージで発火し得る。既定は「全メッセージ =
  attention」だが、`kind === "escalation"` のみに絞る選択肢もある。実装計画で確定（推奨: まず全メッセージ +
  SW 側 `tag` 集約、うるさければ escalation 限定へ）。
- **クロスプロセス SQLite**: daemon は `Store`（jobs/messages を書く）と push 用 `WebAuthStore`
  （subscription/VAPID を読む）の 2 ハンドルを同一 WAL ファイルに開き、加えて web GUI プロセスも同ファイルを開く。
  WAL は複数リーダ + 単一ライタ/行集合で成立するため整合は取れるが、subscription は web が書き daemon が読む
  結果整合であることを明記。
- **VAPID `sub` の値**: 一部 push サービスは有効な `mailto:`/`https:` を要求する。`mailto:agvsr@localhost` を
  既定にするが、実配送で弾かれる可能性は実装時に確認（設定可能にする余地）。
- **暗号の正しさ**が最大の実装リスク。12.6-3 の往復スモークで担保し、失敗時は「送信先を持たない単体復号」で
  切り分ける。
- **job_id の egress**: 最小ペイロードでも job UUID は push ベンダを通る（ディープリンクに必要）。ランダム UUID で
  内容を含まないため許容（§6 既定）。
- **依存ゼロの担保**: 現調査では `crypto.subtle` で全暗号が可能。実装中に組み込みで満たせない箇所が出たら
  依存追加でなく**ブロッカーとしてエスカレーション**する（プロトコル §5）。

### 12.9 検討した代替案

- **ゲートウェイ駆動 push（daemon 無改変）**: web GUI プロセスが既存の `msg.watch` ストリーム + `job.list`
  ポーリング差分で終端/待ち状態を検出し push する案。daemon を web から完全に切り離せる利点があるが、
  (a) 本タスクが指定する「src/hooks.ts のフックをトリガにする」に反し、(b) daemon が持つ権威 status を使えず
  ポーリング差分で failed/interrupted を再判定する必要があり、(c) GUI プロセス停止中は push が止まる
  （「ブラウザを閉じていても届く」を弱める）。よって **daemon 側発火を主案**とし、これは代替として記録。
- **daemon が `Store` から直接 push テーブルを読む**: 追加ハンドルを避けられるが、`Store` の SCHEMA に web 用
  テーブルを混ぜることになり層が崩れる。注入 notifier + 自前 `WebAuthStore` ハンドルの方が daemon を web から
  独立に保て、テストでスパイ注入できる。却下。
- **`web-push` npm パッケージ導入**: 実装は楽だが「新規ランタイム依存禁止」に反する。組み込みで代替可能なので却下
  （不可能と判明した場合のみブロッカー化）。
- **daemon lifecycle push (`job.update`) を足して GUI が送る**: Phase 5 スコープ。本 Phase では `job.list`
  ポーリング維持のため却下。
- **通知本文にジョブ内容を載せる**: プライバシー最小化（§6/§7）に反するため却下。job_id + status のみ。
- **フォーム/トグルに UI ライブラリ導入**: 依存ゼロ方針と現行 DOM SPA で十分なため却下。
