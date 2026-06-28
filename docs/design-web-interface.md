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

| 想定 | 実際 |
|---|---|
| localhost に限ればネットワーク攻撃者は消える | ✅ 正しい（最大の脅威は消える） |
| だからフル操作でも無認証で安全 | ❌ 以下の経路が残る |

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

| 論点 | 決定 |
|---|---|
| フロント実装方式 | **軽量 SPA フレームワーク**（Preact/Svelte 等、ビルド・依存は最小） |
| 認証 UX | **生成トークン → ログインで HttpOnly セッション cookie**、トンネル認証と二重化 |
| lifecycle push の移行 | **初版は `job.list` ポーリング**、負荷/遅延が問題化したら `job.update` push（フェーズ5） |
| 通知トリガ既定 | **終端状態 + escalation / 人間入力待ち** |
| 新規シークレット保管 | **既存 store(SQLite) の専用テーブル**（トークン/セッション/push購読/VAPID鍵） |

### 残る小論点（実装計画で確定）

- SPA の具体ライブラリ確定（Preact / Svelte / 他）とビルドツール構成。
- 認証 UX の細部（起動時トークン提示方法、トンネル認証との二重化の度合い）。
- 通知のクリック導線（localhost 詳細ページへのディープリンク設計）。
- Web 操作監査ログのスキーマ（store 内テーブル設計）。
