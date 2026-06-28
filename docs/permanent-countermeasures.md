# 恒久対策 詳細計画: ジョブ停止の根本原因への上流予防

対象: 停止ジョブ `2f80372d` / `23f916e1` の調査で判明した根本原因に対する恒久対策。
A（ワーカー no-route ガード）・stall watchdog・C（note kind）は既に実装済み（`6c4a621`）で、
これらは「止まった後に検知する安全網」。本メモは**止まる前に防ぐ上流の予防策**を計画する。

## 現状整理（恒久対策の進捗）

| 対策 | 状態 | 実体 |
|---|---|---|
| A: ワーカー no-route ガード | ✅ 実装済 `6c4a621` | `src/daemon/daemon.ts:468-490`（exit 0・未送信 → supervisor へ escalation 再投入） |
| A: stall watchdog → `on_job_stalled` | ✅ 実装済 `6c4a621` | `src/daemon/daemon.ts:674-692, 969-977` |
| C: `note` kind（監査ログ区別） | ✅ 実装済 `6c4a621` | `src/protocol.ts` MessageKind + `src/daemon/daemon.ts:441` |
| 予防① モデル名の事前検証 | ❌ 未 | 本メモ「恒久対策②」 |
| 予防② charter で「送信は MCP ツールのみ」明示 | ❌ 未 | 本メモ「恒久対策①」 |

A/C は安全網（停止後に検知）。残る 2 つは停止前に防ぐ上流策で、`23f916e1` の
①（design `opus-4.8` の不正モデル名）②（codex-mini が `agmsg`/シェルで送ろうとした）に
1 対 1 で対応する。

---

## 恒久対策① charter/プロトコルの硬化 — 「送信は MCP ツールのみ」

### 狙う根本原因
codex-mini が「`agvsr_send` に相当する実行手段はどれか」と推論し、**agmsg 登録やシェル送信**を
試みて失敗（届かないのに「送信した」と誤認）。現 `charters/scaffold.md §2` はツールを列挙する
だけで、「これは MCP ツールで、シェル / agmsg では届かない」と明示していない。

### 変更（`charters/scaffold.md` のみ。Layer1 = 全ロール・全アダプタ共通）
1. §2 冒頭に明示文を追加:
   - 「`agvsr_send` 等は**このターンで既に利用可能な MCP ツール**である。直接そのツールを呼ぶ。」
   - 「**シェルで `agvsr ...` / `agmsg ...` / その他 CLI を実行しても何も届かず黙って捨てられる**。
     唯一の送信手段は MCP ツール呼び出し。」
2. §1 の "Information only moves when you call an agvsr tool" に
   "tool = MCP tool call, not a shell command" を補強。
3. 否定例を 1 行追加（`Running "agvsr send ..." in a shell delivers nothing`）。

### 任意の構造的補強（中コスト）
A の no-route escalation 本文に**的を絞ったヒント**を足す。ワーカーの `tool_use`
（codex は `command_execution`）を走査し、`agvsr send` / `agmsg` を含むシェル実行を検知したら
escalation に「ワーカーがシェルで送信を試みた。MCP ツール `agvsr_send` を使うよう supervisor から
指示を」と付記する。`result.events` は既に手元にあるため追加コストは小さい。

### 限界と対処
プロンプト変更は小型モデルでは無視され得る。よって**A の no-route ガードを安全網**として
併用する前提（実装済み）。これで「無視されても静かには止まらない」を担保する。

---

## 恒久対策② 設定のプリフライト検証（モデル名・CLI 存在）

### 狙う根本原因
`design.model: opus-4.8` は Claude CLI の有効 ID でない（正: `claude-opus-4-8`）。毎ターン exit 1。
現状はハングこそしないが**毎回リトライしてターン / コストを浪費**する。`src/config/team.ts` は
構造のみ検証（コメントに「モデル可用性は Phase2 で検証」とあるが未実装）。

3 層で設計する。

### (a) 非リトライ分類（最優先・低コスト・即効）
- `runTurn` は現在 stderr を捨てている（`src/adapters/run.ts:66-70`）。これを**末尾数 KB だけ保持**し
  `TurnResult.outcome` に `stderrTail` を載せる。
- ワーカー失敗経路（`src/daemon/daemon.ts:504-528`）で、stderr / finalText が**モデル不正パターン**
  （例 `issue with the selected model`, `model .* not found`, `unknown model`）に一致したら、
  **リトライせず即 escalation +「設定エラーの可能性: team.yaml の `<role>.model=<value>` を確認」**。
  設定エラーは N 回リトライしても直らないため。
- 効果: ①のようなミスを「2 回失敗して再割当」ではなく**1 発で人間に投げる**。

### (b) `agvsr doctor`（中コスト・予防の本命）
- `team.yaml` を読み、各ロールについて:
  - アダプタ CLI バイナリが PATH 上に存在するか（`resolveUserPath` を流用）。← 高価値・確実。
  - `--probe` 指定時のみ、各 `(adapter, model)` を**最小プロンプトで実起動**してモデル妥当性を
    確認（API コスト発生のためデフォルト off）。
  - 認証の有無（可能なら軽く）。
- 出力は role ごとに ✓ / ✗ + 是正ヒント。`prepublishOnly` や CI、初回セットアップで使える。

### (c) アダプタ駆動の任意フック（将来拡張）
- `CliDriver` に `validateModel?(model)` を追加し、静的パターンや既知リストで明白な誤りを起動時に
  弾く。モデルは流動的なので**強い検証ではなく明白な誤りの早期警告**に留める。

### 実装順
(a) → (b) → (c)。(a) だけでも①の実害（浪費）はほぼ消える。

---

## テスト / ロールアウト / リスク

- **①テスト**: charter 変更はスナップショット / 内容アサート（`test/charter.test.ts` に
  「MCP ツールのみ / シェル不可」文言の存在を追加）。任意補強はモック `events` にシェル
  `agvsr send` を入れ、escalation 本文にヒントが入ることを検証。
- **②(a) テスト**: フェイク adapter で stderr にモデルエラーを吐かせ、**リトライせず**設定エラー
  escalation になることを `ipc.test.ts` 系で検証。`stderrTail` 追加は `run.test.ts`。
- **②(b) テスト**: 一時 PATH にダミーバイナリを置く / 置かないで `doctor` の ✓ / ✗ を検証。
- **リスク**: (a) のパターンマッチは adapter ごとに文言が違う。アダプタ別の小さなパターン表にして
  拡張可能にする。`stderrTail` のメモリは上限バイトで固定する。
- **別件（要処理）**: 既存 `test/cli-daemon.test.ts` の `daemon start` smoke が**現在 1 件 fail +
  tsc エラー**（別ジョブ由来）。恒久対策とは無関係だが、緑にするには別途修正が必要。

---

## 優先順位の推奨
1. **②(a) 非リトライ分類** — 低コスト・即効で①の浪費を解消。
2. **① charter 硬化** — 低コスト、②の上流予防（A の安全網と対で効く）。
3. **②(b) `agvsr doctor`** — セットアップ体験の本命、中コスト。
4. ①任意補強 / ②(c) — 仕上げ。
