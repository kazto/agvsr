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
