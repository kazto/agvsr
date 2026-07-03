# 設計メモ: 進捗中ターンのタイムアウト制御（action-plan §3「進捗中ターンのタイムアウト制御」）

対象: `docs/action-plan.md` の観測性 §3「進捗中ターンのタイムアウト制御」。
本メモは **実装可能な第一段** を `implementation` に渡せる粒度で設計する。実装はまだ
行わない。既存の未追跡ファイル（`docs/permanent-countermeasures.md` 等）・ユーザー変更を
壊さない範囲を明示する。

---

## 0. 現状（コードに紐づく事実）

- ターンのタイムアウトは **単一のハード wall-clock タイマー** ひとつだけ。
  `src/adapters/run.ts:42-47` が `setTimeout(() => { timedOut = true; proc.kill(); }, timeoutMs)`
  をターン spawn 時に張り、**進捗の有無に関わらず** `timeoutMs` 経過で問答無用に kill する。
- 値は `turnTimeoutMs()`（`src/daemon/daemon.ts:121-126`）= `AGVSR_TURN_TIMEOUT_MS`、
  既定 `DEFAULT_TURN_TIMEOUT_MS = 10*60*1000`（10 分、`daemon.ts:118`）。
- このタイマーは `defaultTurnRunner`（`daemon.ts:175-203`）が
  `runTurn(..., { timeoutMs: turnTimeoutMs(), signal })` として渡す（`daemon.ts:200`）。
- タイムアウト発火時、`run.ts:91-97` が `result` イベントを `ok:false` で合成し、
  `outcome.timedOut = true`（`run.ts:106`）を立てる。
- daemon 側 `dispatchRole` は `result.outcome.timedOut` を見て、**ワーカーでも問答無用に
  job を `failed`** にする（`daemon.ts:507-518`、reason = `"<role> turn failed by timeout."`）。
  → これが「進捗していても 10 分超で failed」になる経路。作業成果は未コミットのまま。
- **重要な観察**: `run.ts:72-80` はターン中ずっと **stdout を 1 行ずつストリーム消費** している
  （`consume(line)` → `parser.push`）。つまり「進捗シグナル」は run.ts 内に**既に流れている**。
  text 出力・`tool_use`・`result` は全て stdout 行として到達する。idle タイマーを張る材料は
  追加 IPC なしで run.ts 内に揃っている。
- ロール設定スキーマは `src/config/team.ts:16-24`（`RoleSchema`）。`charter` / `charter_append`
  / `instances` など **任意フィールドを per-role で持つ前例**がある。
- 実行状態の可視化（§5 B）は実装済み: `computeRuntime`（`daemon.ts:673-687`）が `inflight`
  Map から稼働ロールを、最新監査メッセージから `idle_ms` を算出し、`job.get` が
  `{ job, runtime }` を返す。CLI は `formatRuntime`（`agvsr.ts:60-66`）で
  `running — working: <roles>, idle 12s` と表示する。
- アイドル watchdog（§5 A-2）も実装済み: `notifyStalledJobs`（`daemon.ts:689-707`）は
  **in-flight でない** running ジョブの監査アイドルが `AGVSR_STALL_TIMEOUT_MS` を超えたら
  `on_job_stalled` フックを 1 回鳴らす。**本設計と責務が重ならない**（後述 §6）。

---

## 1. 第一段で実装すべき仕様（提案）

問題の根は「進捗の有無を見ずにハード kill する」こと。第一段は次を満たす:

1. **hard timeout と no-progress(idle) timeout の分離**（run.ts）。
   進捗があり続ける限りターンは生かす。進捗が idle 閾値ぶん途切れたら kill。さらに暴走の
   安全弁として絶対上限（hard）を別に持つ。
2. **進捗シグナルによる idle タイマー延長**。進捗 = run.ts に届く stdout 行（= text /
   tool_use / result イベント）。1 行到達ごとに idle タイマーをリセットする。
3. **role 別 timeout**。`team.yaml` の per-role 設定で hard / idle を上書きできる。
   優先順位は role 設定 > 環境変数 > 既定値。
4. **`status` に残り時間 / 最終進捗時刻を表示**。

スコープを **2 tier** に切る。Tier 1 が「進捗中 failed」バグを直す最小完結。Tier 2 は
status の進捗可視化の精度向上。supervisor は Tier 1 のみで切ってもよい。

- **Tier 1（コア・必須）**: §2〜§4。run.ts の hard/idle 分離 + 設定 + per-role + 失敗
  メッセージ + `status` の **ハード残り時間**表示。
- **Tier 2（観測性・推奨）**: §5。進捗コールバックで daemon が **真の最終進捗時刻**を
  把握し、`status` に「last progress」/ 進捗ベース残り時間を出す。

---

## 2. Tier 1: hard / idle タイムアウトの分離（`src/adapters/run.ts`）

### データモデル

`RunTurnOptions`（`run.ts:9-12`）を拡張:

```ts
export interface RunTurnOptions {
  /** 絶対上限。進捗に関わらずこの時間で必ず kill（暴走の安全弁）。 */
  hardTimeoutMs?: number;
  /** 無進捗上限。最後の stdout 行からこの時間進捗が無ければ kill。 */
  idleTimeoutMs?: number;
  /** 後方互換: 旧 timeoutMs（ハード上限として解釈、hardTimeoutMs 未指定時のみ）。 */
  timeoutMs?: number;
  signal?: AbortSignal;
}
```

### 制御フロー（run.ts 内）

- spawn 直後に **ハードタイマー**（従来どおり一度きり）と **アイドルタイマー**（リセット可能）
  を張る。どちらも発火時は `timedOut = true; proc.kill();`。
- 発火理由を区別する変数を持つ: `let timeoutKind: "hard" | "idle" | null = null;`。
- stdout を消費する箇所（`consume` / chunk ループ）で **行が届くたびにアイドルタイマーを
  リセット**（`clearTimeout` → 再 `setTimeout(idleTimeoutMs)`）。`stderr` ドレインは進捗と
  みなさない（既存どおり捨てる）。進捗判定は **stdout 行のみ**。
- ループ終了・`proc.exited` 後に両タイマーを `clearTimeout`（リーク厳禁、テスト並列のため）。
- 合成 `result` の `text`（`run.ts:92-97`）を理由別に出し分け:
  - hard: `turn exceeded hard timeout ${hardTimeoutMs}ms`
  - idle: `turn made no progress for ${idleTimeoutMs}ms`
- `TurnOutcome`（`src/adapters/types.ts:32-40`）に **任意フィールド** `timeoutKind?: "hard" | "idle"`
  を追加し、`run.ts:104-107` の `outcome` に載せる。`timedOut` は従来どおり両ケースで `true`
  （daemon 既存分岐との後方互換のため意味を変えない）。

### エッジケース

- どちらの値も未指定なら従来挙動（タイマー無し or `timeoutMs` のみ）を保つ。
- `idleTimeoutMs > hardTimeoutMs` の設定は意味を成さない → daemon 側の解決で
  `idle = min(idle, hard)` にクランプ（§3）。run.ts は受け取った値をそのまま使う。
- ストリームせず最後にまとめて 1 行だけ出す adapter（agy 系）でも、その 1 行到達で
  idle リセットされるため、ハード上限までは生存できる。

---

## 3. Tier 1: 設定・優先順位（`src/daemon/daemon.ts` + `src/config/team.ts`）

### 環境変数

`turnTimeoutMs()` の流儀（`Number.isFinite && >0` で fallback）に合わせて 2 つ追加:

- `AGVSR_TURN_HARD_TIMEOUT_MS` → ハード上限。
- `AGVSR_TURN_IDLE_TIMEOUT_MS` → 無進捗上限。
- `AGVSR_TURN_TIMEOUT_MS`（既存）→ **後方互換のハード上限フォールバック**として温存。

### per-role 設定（`team.yaml`）

`RoleSchema`（`team.ts:16-24`）に任意フィールドを追加（既存 optional 群に倣う）:

```ts
hard_timeout_ms: z.number().int().positive().optional(),
idle_timeout_ms: z.number().int().positive().optional(),
```

例:

```yaml
roles:
  implementation:
    adapter: claude-code
    model: ...
    idle_timeout_ms: 1200000 # 実装は長く沈黙しがち → 20 分
    hard_timeout_ms: 5400000 # 絶対上限 90 分
```

`team.yaml` での `hard_timeout_ms` / `idle_timeout_ms` はこの役割だけに効く上書きで、長い実装
ターンと短い監督ターンを分けたいときに使う。

### 優先順位（daemon で解決）

`dispatchRole` は `roleConfig`（`daemon.ts:386-387`）を持つので、ここで実効値を 1 箇所で
決める。新ヘルパ（例 `resolveTurnTimeouts(roleConfig)`）:

- `hardMs = roleConfig.hard_timeout_ms ?? env(AGVSR_TURN_HARD_TIMEOUT_MS) ?? env(AGVSR_TURN_TIMEOUT_MS) ?? DEFAULT_HARD_TIMEOUT_MS`
- `idleMs = roleConfig.idle_timeout_ms ?? env(AGVSR_TURN_IDLE_TIMEOUT_MS) ?? DEFAULT_IDLE_TIMEOUT_MS`
- `idleMs = min(idleMs, hardMs)`（クランプ）

既定値（`daemon.ts:118` 付近に定数追加）:

- `DEFAULT_IDLE_TIMEOUT_MS = 10*60*1000`（10 分）← 「10 分無進捗 = 詰まり」。従来の
  ハード 10 分の体感を idle 側に引き継ぐ。
- `DEFAULT_HARD_TIMEOUT_MS = 60*60*1000`（60 分）← 進捗し続ける作業の絶対上限。

既存 `DEFAULT_TURN_TIMEOUT_MS`（10 分）と `stallTimeoutMs()` は**そのまま残す**
（§6 watchdog のため）。

### dispatch への受け渡し

`defaultTurnRunner` は `TurnDispatch` しか受け取らない（roleConfig を知らない）。よって
**解決済みの値を `TurnDispatch` に載せて渡す**:

- `TurnDispatch`（`daemon.ts:55-70`）に `hardTimeoutMs: number; idleTimeoutMs: number;` を追加。
- `dispatchRole` が `runner({... hardTimeoutMs, idleTimeoutMs})` で渡す（`daemon.ts:413-431`）。
- `defaultTurnRunner` が `runTurn(..., { hardTimeoutMs, idleTimeoutMs, signal })` を渡す
  （`daemon.ts:200` を置換）。

これで解決ロジックは daemon の 1 箇所に集約され、テスト用 turnRunner も実効値を検査できる。

---

## 4. Tier 1: 失敗メッセージと `status` のハード残り時間

### 失敗理由の明確化（任意だが推奨）

`dispatchRole` のタイムアウト失敗分岐（`daemon.ts:507-518`）で、`result.outcome.timeoutKind`
を使い reason を出し分ける:

- `"<role> turn failed: no progress for <idle>ms (no-progress timeout)."`
- `"<role> turn failed: exceeded hard timeout <hard>ms."`

挙動（`failed` にする・`on_job_failed` 発火）は不変。文言だけ改善。

### `status` のハード残り時間（`JobRuntime` 拡張）

daemon にターン開始時刻を持たせ、ハード締切までの残りを出す。

- daemon 内に `turnStartedAt: Map<string, number>`（キー `"${jobId}:${role}"`）。
  `dispatchRole` の `runner(...)` 呼び出し直前に `set(key, Date.now())`、`finally` で
  `delete(key)`（`daemon.ts:411-435` の try/finally に同梱。`acSet` 解放と同じ寿命）。
- 実効 hard 値も同様に `turnHardMs: Map<string, number>` に置くか、`computeRuntime` 内で
  再解決する（`roleConfig` から再計算可）。Map で持つ方が単純。
- `protocol.ts` の `JobRuntime`（`protocol.ts:26-35`）に任意フィールド追加:

```ts
/** 稼働中ロールごとのターン開始時刻（ISO）。in-flight でなければ空。 */
turn_started_at?: Record<string, string>;
/** 稼働中ロールごとのハード締切までの残り ms（負なら 0 クランプ）。 */
hard_remaining_ms?: Record<string, number>;
```

- `computeRuntime`（`daemon.ts:673-687`）で active role について `turnStartedAt` から
  `hard_remaining_ms = max(0, started + hardMs - Date.now())` を埋める。
- CLI `formatRuntime`（`agvsr.ts:60-66`）に追記: in-flight 行に
  `… , budget 47m left` 程度を足す（`formatDuration` 既存利用）。terminal 状態では空のまま。

> 注: Tier 1 の `status` は **ハード残り時間**のみ正確に出せる。「最終進捗時刻」を stdout
> 行粒度で正確に出すには daemon が進捗を受け取る必要があり、それは Tier 2。Tier 1 では
> 既存の `idle_ms`（監査メッセージ基準）が「最後に監査ログが動いた時刻」として併存する。

---

## 5. Tier 2（推奨）: 進捗コールバックで真の「最終進捗時刻」を可視化

Tier 1 の idle タイマーは run.ts 内で完結するため**機能は成立する**が、`status` 上の
「最終進捗時刻」を stdout 行粒度で正確に見せるには daemon が進捗を知る必要がある。

- `RunTurnOptions` に `onProgress?: () => void` を追加。run.ts が **stdout 行を消費する
  たびに** 呼ぶ（idle タイマーリセットと同じ箇所）。
- `TurnDispatch` に `onProgress?: () => void` を追加し、`defaultTurnRunner` が
  `runTurn(..., { onProgress })` に転送。
- daemon が `lastProgressAt: Map<string, number>`（`"${jobId}:${role}"`）を持ち、
  `dispatchRole` が `onProgress = () => lastProgressAt.set(key, Date.now())` を渡す。
  ターン終了の `finally` で `delete(key)`。
- `computeRuntime` で active role の `last_progress_at` / `idle_since_progress_ms` を埋め、
  `JobRuntime` に任意フィールドとして追加。`formatRuntime` で
  `… , last progress 8s ago` を表示。
- **§6 watchdog とは独立**: A-2 watchdog は引き続き「監査メッセージ idle × in-flight でない
  ジョブ」を見る。`lastProgressAt` は in-flight 中の表示専用に使い、watchdog の判定基準は
  変えない（`docs/design-stall-detection.md` の「idle_ms フィードバックループ問題」を
  侵さないため）。

頻度は「stdout 1 行ごとに Map.set 1 回」で安価。状態は in-flight 中のみ存在し終了で消える。

---

## 6. 既存 watchdog（§5 A-2）との関係（重複しないことの確認）

- **per-turn idle timeout（本設計）**: ターンが **in-flight の最中** に進捗が止まったら
  その**ターンを kill** する（job は failed 経路）。
- **idle watchdog（実装済み）**: **in-flight でない** running ジョブ（誰のターンも回って
  いないのに監査が止まっている）を検知して **`on_job_stalled` を通知**するだけ（fail しない）。
- `notifyStalledJobs` は `runtime.in_flight` なジョブを除外する（`daemon.ts:697`）ので、
  本設計が殺すべき「進捗の止まった in-flight ターン」と watchdog が拾う「止まった非
  in-flight ジョブ」は**排他**。二重発火しない。
- 既定値も衝突しない: `DEFAULT_STALL_TIMEOUT_MS`（=10 分、`daemon.ts:138`）は据え置き。

---

## 7. 変更対象ファイル（サマリ）

| ファイル                        | Tier 1                                                                                                                                               | Tier 2                                                         |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `src/adapters/run.ts`           | hard/idle 2 タイマー化・行到達で idle リセット・理由別 result text                                                                                   | `onProgress` を行ごとに呼ぶ                                    |
| `src/adapters/types.ts`         | `TurnOutcome.timeoutKind?` 追加                                                                                                                      | —                                                              |
| `src/config/team.ts`            | `RoleSchema` に `hard_timeout_ms?` / `idle_timeout_ms?`                                                                                              | —                                                              |
| `src/daemon/daemon.ts`          | 既定定数・env パーサ・`resolveTurnTimeouts`・`TurnDispatch` 拡張・`defaultTurnRunner` 受け渡し・失敗文言・`turnStartedAt` Map・`computeRuntime` 拡張 | `lastProgressAt` Map・`onProgress` 配線・`computeRuntime` 追加 |
| `src/protocol.ts`               | `JobRuntime` に `turn_started_at?` / `hard_remaining_ms?`                                                                                            | `last_progress_at?` / `idle_since_progress_ms?`                |
| `src/cli/agvsr.ts`              | `formatRuntime` にハード残り時間表示                                                                                                                 | `formatRuntime` に last progress 表示                          |
| `team.yaml` / `examples` / docs | per-role timeout の記述例（任意）                                                                                                                    | —                                                              |

**触らない**: `docs/permanent-countermeasures.md`、`docs/design-stall-detection.md`、
`team.yaml` のユーザー定義値（例の追記をする場合もコメント/任意ロールに限定）、その他
未追跡ファイル。スキーマ追加は全て **optional** なので既存 `team.yaml` はそのまま有効。

---

## 8. 互換性への注意点

1. **既定挙動の変化（意図的）**: 旧 = ハード 10 分で進捗無視 kill。新 = idle 10 分 + hard 60 分。
   進捗し続ける長時間ターンは生存するようになる（= 本件のゴール）。一方、定期的に stdout を
   吐きながら実質止まっているターンは最大 60 分生きうる。**この上限変化を明記**し、
   旧挙動が要るユーザーは `AGVSR_TURN_HARD_TIMEOUT_MS=600000` 等で戻せる。
2. **`AGVSR_TURN_TIMEOUT_MS` の後方互換**: 温存しハード上限フォールバックとして解釈。
   既存 `test/e2e.test.ts:101`（`=5000` を設定）は **ハード 5s として効く**ため緑のまま
   （当該テストはタイムアウト発火ではなく高速完了を見ているので影響なし）。
3. **`RoleSchema` の新フィールドは optional**: 既存 `team.yaml` / `examples/team.yaml` を
   無改変で読める。z スキーマの `passthrough` 不要（未知キーは元々拒否しないが、追加分は
   明示定義）。
4. **`TurnOutcome.timeoutKind` / `JobRuntime` 新フィールドは optional**: 既存の
   `runtime.test.ts` / `ipc.test.ts` のアサーション（`in_flight` / `idle_ms` 等）は不変で緑。
5. **`TurnDispatch` 拡張**: テスト用 turnRunner は引数を分割代入で受けており、未使用フィールド
   追加は型・実行とも非破壊。ただし `TurnDispatch` を**生成**するのは daemon のみなので、
   テストが自前で dispatch を組み立てている箇所が無いか実装時に確認（grep: `TurnDispatch`）。
6. **タイマーリーク**: hard/idle 両方を必ず `clearTimeout`。`turnStartedAt` /
   `lastProgressAt` は `finally` で必ず `delete`。テスト並列実行でハンドル/エントリを残さない。

---

## 9. 「end-to-end で動く」の定義（実装の e2e テスト & QA の検証対象）

エントリポイントは 2 系統:

- **run.ts 単体**: 実バイナリの代わりに「行を遅延付きで stdout に吐くフェイク CLI スクリプト」
  （`test/e2e.test.ts` の `fakeClaudeScript` と同方式で `tmp/bin` に生成）を spawn し、
  `runTurn(driver, spec, null, msg, { hardTimeoutMs, idleTimeoutMs })` を直接呼ぶ。
- **daemon 経由**: `startDaemon({ turnRunner })`（`test/runtime.test.ts` / `test/ipc.test.ts`
  準拠）でゲート付き turnRunner を使い、解決済み timeout 値・`status` 表示・失敗文言を検証。
  CLI を別プロセス起動する必要はない。

成功条件:

- 進捗し続けるターンは idle/hard どちらでも kill されず完走する。
- 進捗が idle 閾値ぶん途切れたターンだけが kill され、job が `failed`、reason に
  「no-progress timeout」が出る。
- hard 上限に達したターンは進捗の有無に関わらず kill され、reason に「hard timeout」。
- `agvsr status <job>` の in-flight 行にハード残り時間（Tier 2 なら last progress も）が出る。

検証コマンド（CLAUDE.md 準拠、最終確認）: `bun test` / `bun run typecheck` /
`bunx oxlint src test` / `oxfmt`。

---

## 10. Acceptance Criteria（QA がテスト計画を作れる粒度）

### AC-1 idle timeout が進捗で延長される（コア）

- フェイク CLI が「idle 閾値より短い間隔で stdout 行を吐き続け、合計時間は idle 閾値を
  超える」とき、ターンは **kill されない**（`outcome.timedOut !== true`、`exitCode === 0`）。
- 例: `idleTimeoutMs=200ms`、150ms 間隔で 5 行（合計 ~750ms）→ 完走する。

### AC-2 idle timeout が無進捗で発火する（コア）

- フェイク CLI が数行吐いた後、idle 閾値を超えて沈黙 → ターンが kill され、
  `outcome.timedOut === true` かつ `outcome.timeoutKind === "idle"`、合成 result text に
  `no progress` を含む。

### AC-3 hard timeout が進捗中でも発火する（コア）

- フェイク CLI が hard 閾値を超えて **行を吐き続けても**（idle は決して発火しない条件）、
  hard 閾値で kill され、`outcome.timeoutKind === "hard"`、result text に `hard timeout` を含む。
- `idle = min(idle, hard)` クランプ後も hard が上限として効くこと。

### AC-4 daemon が job を failed にし理由を出し分ける（コア）

- daemon 経由でワーカーターンが idle/hard timeout した各ケースで job が `failed`、
  `daemon → user` の `kind:"failure"` メッセージ本文が idle/hard を区別している。
  `on_job_failed` フックが発火する。

### AC-5 優先順位の解決（コア）

- role 設定 > 環境変数 > 既定 の順で実効値が決まることを、turnRunner が受け取る
  `hardTimeoutMs` / `idleTimeoutMs` を観測して検証:
  - role に `idle_timeout_ms` 指定あり → それが勝つ。
  - role 未指定・env あり → env が勝つ。
  - 両方未指定 → 既定（idle 10 分 / hard 60 分）。
  - `idle > hard` 指定時に `idle === hard` にクランプされる。

### AC-6 後方互換: `AGVSR_TURN_TIMEOUT_MS`（コア）

- 新 env 未設定で `AGVSR_TURN_TIMEOUT_MS` のみ設定 → ハード上限として効く。
- 既存 `test/e2e.test.ts`（`=5000`）が緑のまま。

### AC-7 後方互換: スキーマ / 既存テスト（コア）

- 新フィールドを一切持たない既存 `team.yaml` / `examples/team.yaml` が無改変で読める。
- `runtime.test.ts` / `ipc.test.ts` の既存アサーションが緑（`JobRuntime` / `TurnOutcome`
  の新フィールドは optional で従来検査に影響しない）。

### AC-8 `status` のハード残り時間表示（コア）

- in-flight ターン中、`job.get` の `runtime.hard_remaining_ms[<role>]` が
  `0 < x <= hardMs` で、時間とともに減少する。
- `agvsr status <job>` 出力の in-flight 行にハード残り時間（例 `budget 59m left`）が出る。
- terminal 状態（done/failed）では runtime 表示が空のまま（`formatRuntime` 既存仕様）。

### AC-9 進捗の真の最終時刻表示（Tier 2・任意）

- in-flight 中に stdout 行が届くたび `runtime.last_progress_at[<role>]` が更新され、
  `idle_since_progress_ms` が ~0 に戻る。沈黙が続くと増える。
- `agvsr status` に `last progress <n>s ago` が出る。
- **watchdog 非干渉**: `notifyStalledJobs` の判定基準（監査メッセージ idle × 非 in-flight）が
  変わっておらず、`on_job_stalled` の発火条件が本変更前後で同一（既存 stall テストが緑）。

### AC-10 リソースリークなし（コア）

- 全タイムアウトテストで hard/idle タイマーが `clearTimeout` され、`turnStartedAt`
  （Tier 2 は `lastProgressAt`）がターン終了後に空になる。
- `daemon.close()` 後に未解放タイマー/エントリが残らない（テスト並列で他テストに漏れない）。

### AC-11 既存回帰 + 検証コマンド（コア）

- `bun test` 全緑（現在のスイートを維持）。
- `bun run typecheck` / `bunx oxlint src test` / `oxfmt` が exit 0。

---

## 11. supervisor への確認事項

1. **スコープ**: 第一段を **Tier 1 のみ**にするか、**Tier 1 + Tier 2**まで含めるか。
   Tier 1 だけで「進捗中 failed」バグは解消する。Tier 2 は `status` の進捗可視化を
   正確にする観測性強化。推奨は両方だが、Tier 1 単独でリリース可能な切り口にしてある。
2. **既定値**: idle 10 分 / hard 60 分でよいか（旧挙動はハード 10 分）。上限が伸びる点を
   許容するか。
3. **per-role 設定キー名**: `hard_timeout_ms` / `idle_timeout_ms`（snake_case、既存
   `charter_append` に合わせた）でよいか。
