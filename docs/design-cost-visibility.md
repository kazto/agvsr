# agvsr: ターン単位のトークン/コスト計上

`docs/design.md` の D1〜D28、`docs/design-herdr-integration.md` の D29〜D31 に続く決定。

## 背景

agvsr は supervisor を星型トポロジのハブとして、ワーカーからのメッセージ・エスカレーション・
stall 検知のたびに再ディスパッチする。1ジョブあたりの LLM ターン数は対話利用より遥かに多く、
しかもそれは利用者の対話セッションと**同じサブスクリプション枠**を消費する。

一方で `claude -p` / `codex exec --json` は毎ターンの終端イベントでトークン数（claude はコストも）
を報告しているのに、agvsr のパーサはそれを捨てていた。結果として「どのロールが枠を食っているか」
を推測でしか語れず、team.yaml のモデル選択を根拠を持って調整できなかった。

なお `-p` / headless 実行そのものは課金経路を変えない。認証は対話起動時と同じ解決順
（`ANTHROPIC_API_KEY` があれば API 従量課金、無ければ OAuth = 定額プラン枠）であり、
本機能が可視化するのは**プラン枠の消費量**である。

## D32: ターン単位のトークン/コストを計上し、ロール別に集計する

各ターンの終端イベントからトークン/コストを抽出して SQLite に1行ずつ記録し、
ジョブ単位・ロール単位で集計して CLI に出す。

### 収集（アダプタ層）

`TurnParser` に optional な `usage()` を追加し、実装したドライバだけが値を返す。
`TurnOutcome.usage` として `run.ts` が拾い上げる。

| adapter | 終端イベント | 取れるもの |
| --- | --- | --- |
| claude-code | `result` | `total_cost_usd` + `usage.{input,output,cache_read_input,cache_creation_input}_tokens` |
| codex | `turn.completed` | `usage.{input,cached_input,cache_write_input,output,reasoning_output}_tokens`（コストなし） |
| agy | （プレーンテキスト） | なし — `usage()` 自体を実装しない |

- **正規化**: `TurnUsage.input_tokens` は常に**キャッシュを含まない入力**とする。claude は元から
  cache read を別建てで報告するが、codex の `input_tokens` はキャッシュ込みの合計なので、
  codex ドライバ側で `input_tokens - cached_input_tokens` に変換してから格納する。
  アダプタ間で合算した数字が意味を持つようにするための決定であり、変換はドライバの責務とする。
- **コストは claude-code のみ**。`total_cost_usd` は定価ベースの推定値であり、サブスク認証の
  ターンでも報告される。請求額ではなく**プラン枠の消費量の代理指標**として扱う。
- ターンが kill/timeout された場合、CLI は終端イベントに到達しないので usage は取れない。
  これは「0」ではなく「未計測」であり、行を作らないことで区別する。

### 保存（ストア層）

`turn_usage` テーブルに1ターン1行。`CREATE TABLE IF NOT EXISTS` で作られるため、D32 以前の
既存 DB もデーモン起動時に自動で追加され、`migrate()` の変更は不要。

集計は SQL 側の `SUM`/`GROUP BY` で行い、`cost_usd IS NULL` の行数を `missing_cost` として
同時に数える。これが 0 より大きいグループは `cost_partial: true` となる。

- **`cost_partial` は「コストが下限値である」ことのマーカー**。codex/agy のターンはトークンを
  計上しつつコストには寄与しないため、合計コストを裸の数字として出すのは誤り。CLI は `+` を
  付けて（`$4.20+`）下限であることを明示する。
- 記録は `dispatchRole` 内の kill チェック**より前**で行う。ジョブが途中で停止されても
  そのターンのトークンは実際に消費されているため、隠すと実コストを過小申告することになる。
- ロール/アダプタ/モデルはアダプタの自己申告ではなく、そのターンで使った team 設定の値を記録する。

### 公開（プロトコル/CLI）

- `job.get` のレスポンスに `usage: JobUsage`（totals + ロール別内訳）を追加 → `agvsr status <id>`。
- 新メソッド `usage.report`（optional `job_id`）→ 新サブコマンド `agvsr usage [job-id] [--json]`。
  totals・ロール別・ジョブ別の3表。ロール別/ジョブ別はコスト降順で並べ、**最も枠を食っている
  対象が先頭に来る**ようにする（この機能の主目的がそれの特定であるため）。

## 非ゴール

- 予算上限やスロットリング。本機能は計測と表示のみで、実行を止めることはしない。
- 請求額との突合。`cost_usd` は定価ベースの推定であり、サブスク枠の消費とも請求とも一致しない。
- codex/agy のコスト推定（モデル別価格表の内蔵）。報告されない値を agvsr 側で作らない。
- 過去ジョブの遡及計上。D32 以降に実行されたターンのみが記録される。
- Web UI への表示。CLI/プロトコル層までを対象とし、Web は別途。
