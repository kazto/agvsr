# agvsr 使いやすさ改善アクションプラン

agvsr（supervisor をハブにした star-topology で Claude / Codex / Gemini を協調させる
daemon + 薄い CLI）の使いやすさを上げるための施策案。実装コードの実態に紐づけて、
「導入の摩擦」「日々の運用」「観測性」「安全性」の 4 軸で整理する。

## 1. 導入・オンボーディングの摩擦を減らす

### `agvsr init`（対話ウィザード） ✅ 非対話形式で実装済み

- 現状 `team.yaml` は手書きが必要で、`examples/team.yaml` をコピーするしかない。
- `charters/scaffold.md` という雛形資産があるのにスキャフォルドコマンドが無い。
- `agvsr init` で「どの役割を、どの adapter/model で」を対話選択して `team.yaml` を生成。

実装内容（`docs/design-init-command.md` に基づく非対話形式）:

- `src/config/init.ts`: `buildTeamYaml(spec)` — 純粋関数。フラグ入力を YAML 文字列に変換し、
  `parseTeam()` による自己検査で常に valid な出力を保証する。
- `src/cli/agvsr.ts`: `case "init"` — フラグ解析・ファイル書き込み・上書き保護を担う CLI ラッパー。
- `test/init.test.ts` / `test/cli-init.test.ts`: ユニットテストと E2E テスト。
- 対話ウィザードは同じ `buildTeamYaml` を呼ぶ薄いフロントエンドとして後から追加できる。

### `agvsr doctor` ✅ 実装済み

- `defaultTurnRunner` は `claude` / `codex` / `agy` バイナリを spawn するが、未インストール時は
  実ジョブを投げて初めて失敗する（`src/adapters/run.ts:36` の spawn エラー）。
- `team.yaml` に書かれた adapter の CLI 存在・認証・PATH（`resolveUserPath` でログインシェル
  PATH を解決済み）を起動前に検査する `doctor` があると詰まりにくい。

## 2. 日々の運用（daemon ライフサイクル）

### `agvsr daemon start`（バックグラウンド起動）/ 自動起動

- 現状 `daemon` はフォアグラウンドのみ。`stop` / `restart` はあるのに `start`（detached）が無い。
- `agvsr job` は daemon 未起動だと `withClient` が即 `process.exit(1)`。
- `job` 実行時に daemon が居なければ自動 spawn するか、`daemon start` を足すだけで
  「端末 2 枚問題」が消える。`restart` 内で既に detached spawn しているので転用は容易。

### 短いジョブ ID / 名前参照

- `status` は UUID 全体を表示し、`logs` / `tell` / `stop` は毎回 UUID コピーが必要。
- `--id` で任意名は付けられるが、デフォルトでも先頭 8 桁（branch には既に使っている
  `id.slice(0, 8)`）や `last` エイリアス（直近ジョブ）を受け付けると操作が軽くなる。

## 3. 観測性（今いちばん弱いところ）

### `agvsr watch` ライブダッシュボード ✅ 実装済み

- `status` は一回限りのスナップショット、`logs -f` は単一ジョブのみ。
- daemon には既に `msg.watch` のサーバープッシュ機構があるので、全ジョブ横断で
  「役割間メッセージの流れ」をリアルタイム表示する TUI が低コストで作れる。
- supervisor → implementation → qa の往復が見えると安心感が段違い。

実装内容:

- `src/cli/agvsr.ts`: `agvsr watch [--all] [--poll N]` を追加。
  - 起動時に全 running ジョブを列挙し、ジョブごとに `msg.watch` で購読登録する。
  - 購読時にそのジョブの既存メッセージ（`msg.list`）を表示してから live 購読に入るため、
    開始直後から文脈が見える。
  - `setInterval` で N ms（デフォルト 2000ms）ごとに `job.list` を再取得し、
    途中で追加されたジョブも自動購読する。
  - 複数ジョブのフレームはすべて単一の `c.onPush` ハンドラで受信し、
    `job_id` 短縮形（先頭 8 桁）を行頭に付けてストリーム表示する。
  - `--all` で done/failed ジョブも含めて購読、`--poll N` でポーリング間隔を上書き。
  - TTY では dim ANSI でジョブ登録ヘッダ・`[note]` を薄色表示。
- `test/watch.test.ts`: 4 テストを追加し、以下を検証。
  - 1 クライアントで 2 ジョブを同時購読し、両方からのフレームを受信できること。
  - 購読外ジョブのメッセージは届かないこと（分離保証）。
  - ポーリングで後から追加したジョブの購読も機能すること。
  - `msg.list` → `msg.watch` の順で既存メッセージと新着フレームの両方が取得できること。
- 検証: `bun test`（96 pass / 0 fail）、`bun run typecheck`（clean）、
  `bunx oxlint src test`（clean）、`bunx oxfmt`（clean）すべて通過。

### ターンのコスト / 所要時間 / トークンの可視化

- `TurnResult` は `events`（tool_use 含む）と `exitCode` を持つのに、監査ログには最終テキスト
  しか残らない。
- turn ごとの所要時間・tool 呼び出し数・（取れるなら）トークン / コストを記録・表示すると、
  ループ検知（`checkLoopSignal`）の挙動も人間が追えるようになる。

### 進捗中ターンのタイムアウト制御

- 現状 `AGVSR_TURN_TIMEOUT_MS` は 1 エージェントの 1 ターンに対する固定上限で、デフォルトは
  10 分。ジョブ全体ではなく、supervisor / design / implementation / qa の各ターンごとに適用される。
- 実装や検証が進捗していても、1 ターン内で 10 分を超えると `turn failed by timeout` になり、
  作業成果が未コミットのままジョブが failed になる。長めの実装・テスト・lint 修正では使い勝手が悪い。
- 改善案: agent の stdout / tool_use / ファイル変更 / 監査メッセージなどの進捗シグナルで
  idle タイマーを延長する、role ごとにタイムアウトを設定する、または「hard timeout」と
  「no-progress timeout」を分離する。`status` には残り時間や最終進捗時刻を表示する。

## 4. 安全性・並列性（設計上の一番大きな穴）

### git worktree によるジョブ隔離

- `store.createJob` は `branch: agvsr/xxx` を記録するだけで実際にはブランチを作っていない。
- charter は「job branch で作業」「2 人同時に同じ workspace を触るな」と指示しているが、
  隔離は人間 / エージェント任せ。
- 各ジョブを git worktree に切る（`<cwd>/.agvsr/worktrees/<id>`）と、
  (a) 並列ジョブが安全に走り、
  (b) supervisor の「最後の merge は人間に」という方針が実体を持ち、
  (c) 役割間の workspace 競合（supervisor charter の Boundaries）も構造的に解消できる。

## 優先順位

| 優先     | 案                               | 効果 / コスト                               |
| -------- | -------------------------------- | ------------------------------------------- |
| ★ 最優先 | daemon 自動起動 + `daemon start` | 体験の摩擦が即消える / 低                   |
| ★ 最優先 | `agvsr init`                     | 初回到達率が上がる / 低〜中                 |
| ◎ ✅     | `agvsr watch` ダッシュボード     | 観測性が大幅改善・既存 push 機構を流用 / 中 |
| ◎        | git worktree 隔離                | 並列化と安全性の構造的解決 / 中〜高         |
| ○ ✅     | `doctor` / 短い job id           | 細かい詰まりを解消 / 低                     |

いずれも既存の構造（IPC push、`resolveUserPath`、branch カラム、detached spawn）を活かせるため
追加コストは小さめ。最初の 1 つを実装するなら、効果と難易度のバランスから
「daemon 自動起動 + `daemon start`」または「`agvsr init`」を推奨。

---

## 5. ジョブのストール検知・実行状態の可視化（観測性・最優先）

### 背景（実地調査で判明した問題）

ジョブ `2f80372d-97e2-4486-86bd-cc9cd1f6d493` が「動いているのか止まっているのか分からない」
という症状を調査したところ、`running` 表示のまま約 35 分間ストールしていた。

- 原因: 最後の implementation ターンが exit 0 で完了報告を「ターンの最終テキスト」として
  書いたが、`agvsr_send(to="supervisor")` を呼ばずに終了した。
- daemon はその最終テキストを `implementation → daemon` の監査専用メッセージとして保存する
  だけで（`src/daemon/daemon.ts:417-425`）、どこにもルーティングしない。ワーカーは exit 0・
  ループ兆候なしのため `resetFailure` するのみで、何もキューに積まれず supervisor は実装完了を
  知らないまま静かに固まる。
- 設計上の非対称: supervisor には「テキストだけで終わり agvsr ツール未呼び出しなら fail」という
  ガードがある（`src/daemon/daemon.ts:427-447`）が、ワーカーには同等のガードが無い。
- さらに `status` の `running` は「daemon が running と記録している」だけで「処理中」を意味せず、
  `updated_at` も作成時のまま更新されないため、「実行中 / 入力待ち / ストール」の区別が CLI に
  一切出ない。これが「分からなさ」の正体。

実装は B → A → C の順で進める。

### B. 実行状態を見える化する（最優先・低コスト）✅ 実装済み

- daemon にジョブごとの「in-flight ディスパッチの有無」「最後にターンが回った時刻」を保持する。
  `inflight` Map は既に存在するため参照するだけで実装できる。
- `job.get` のレスポンスにこの実行状態を含め、`status` で `running` を実態とともに表示する。
- これにより「running だが実際は止まっている」を人間が即座に判別できる。

実装内容:

- `src/protocol.ts`: `JobRuntime`（`in_flight` / `active_roles` / `last_activity_at` / `idle_ms`）を追加。
- `src/daemon/daemon.ts`: `computeRuntime()` を追加し、`inflight` Map のキーから稼働中ロールを、
  最新監査メッセージから `idle_ms` を算出。`job.get` が `{ job, runtime }` を返すようにした。
- `src/cli/agvsr.ts`: `agvsr status <job-id>` の先頭行に実行状態を表示。
  稼働中は `running — working: implementation, idle 12s`、
  停止中は `running — no in-flight turn, idle 35m (possibly stalled)`。
- `test/runtime.test.ts`: ゲート付き turnRunner でターン中 `in_flight=true` → 完了後
  `in_flight=false` かつ `idle_ms` 設定を検証。
- 検証: `bun test`（72 pass / 0 fail）、`bunx oxfmt`、`bunx oxlint`（exit 0）すべて通過。

### A. ストールを検知して塞ぐ（再発防止）

- **ワーカー版 no-route ガード**: ワーカーのターンが exit 0 かつ
  `agvsr_send` / `agvsr_escalate` / `agvsr_complete` を一切呼ばずに終わった場合、daemon が
  `worker → supervisor` の escalation を自動生成し、「ワーカーがルーティングせずに終了。最終
  テキストを確認して継続判断を」と促す。supervisor 用ガードのワーカー版にあたる。
- **アイドル watchdog**: in-flight ディスパッチが無く、最後の活動から N 分（例: ターン
  タイムアウト相当）経過した `running` ジョブを `stalled` として検知し、ユーザーへ通知する
  （既存 `on_supervisor_message` フック経路を流用可）。

### C. 監査ログを区別する（仕上げ）

- `→ daemon` の最終テキストは現在ふつうの `message` と同じ見た目で、送信された報告と区別が
  つかない。これを `kind: "note"`（ルーティングされない独り言）として明示し、`logs` で
  淡色 / タグ表示する。「これは送信された報告ではない」と人間がすぐ分かるようにする。

### 優先順位

| 優先     | 案                                   | 効果 / コスト                         |
| -------- | ------------------------------------ | ------------------------------------- |
| ★ 最優先 | B. 実行状態の可視化（`status` 拡張） | 低コストで即「分かる」 / 低           |
| ◎        | A. ワーカー no-route ガード          | 今回のストールを構造的に再発防止 / 中 |
| ○        | A. アイドル watchdog                 | 取りこぼし検知の仕上げ / 中           |
| ○        | C. 監査ログの区別（`kind: "note"`）  | 誤読防止の仕上げ / 低                 |
