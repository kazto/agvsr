# agvsr 使いやすさ改善アクションプラン

agvsr（supervisor をハブにした star-topology で Claude / Codex / Gemini を協調させる
daemon + 薄い CLI）の使いやすさを上げるための施策案。実装コードの実態に紐づけて、
「導入の摩擦」「日々の運用」「観測性」「安全性」の 4 軸で整理する。

## 1. 導入・オンボーディングの摩擦を減らす

### `agvsr init`（対話ウィザード）
- 現状 `team.yaml` は手書きが必要で、`examples/team.yaml` をコピーするしかない。
- `charters/scaffold.md` という雛形資産があるのにスキャフォルドコマンドが無い。
- `agvsr init` で「どの役割を、どの adapter/model で」を対話選択して `team.yaml` を生成。

### `agvsr doctor`
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

### `agvsr watch` ライブダッシュボード
- `status` は一回限りのスナップショット、`logs -f` は単一ジョブのみ。
- daemon には既に `msg.watch` のサーバープッシュ機構があるので、全ジョブ横断で
  「役割間メッセージの流れ」をリアルタイム表示する TUI が低コストで作れる。
- supervisor → implementation → qa の往復が見えると安心感が段違い。

### ターンのコスト / 所要時間 / トークンの可視化
- `TurnResult` は `events`（tool_use 含む）と `exitCode` を持つのに、監査ログには最終テキスト
  しか残らない。
- turn ごとの所要時間・tool 呼び出し数・（取れるなら）トークン / コストを記録・表示すると、
  ループ検知（`checkLoopSignal`）の挙動も人間が追えるようになる。

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

| 優先 | 案 | 効果 / コスト |
|---|---|---|
| ★ 最優先 | daemon 自動起動 + `daemon start` | 体験の摩擦が即消える / 低 |
| ★ 最優先 | `agvsr init` | 初回到達率が上がる / 低〜中 |
| ◎ | `agvsr watch` ダッシュボード | 観測性が大幅改善・既存 push 機構を流用 / 中 |
| ◎ | git worktree 隔離 | 並列化と安全性の構造的解決 / 中〜高 |
| ○ | `doctor` / 短い job id | 細かい詰まりを解消 / 低 |

いずれも既存の構造（IPC push、`resolveUserPath`、branch カラム、detached spawn）を活かせるため
追加コストは小さめ。最初の 1 つを実装するなら、効果と難易度のバランスから
「daemon 自動起動 + `daemon start`」または「`agvsr init`」を推奨。
