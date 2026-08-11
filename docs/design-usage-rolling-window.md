# agvsr: 5時間ローリング使用量と時間当たり消費速度

`docs/design-cost-visibility.md` の D32、`docs/design-supervisor-idle.md` の D36〜D37 に続く決定。

## 背景

現在の `agvsr usage` は、D32 以降に記録された全ターンを累積表示する。これは高コストなロールや
ジョブの特定には使えるが、Claude Code などの時間窓付き利用制限に対して、直近の消費がどれほど
速いかは分からない。並列ジョブや短時間のリトライ集中も累積値では見えにくい。

本機能はプロバイダーの残量を推測せず、agvsr が実測できたターンだけから次の2点を表示する。

1. 直近5時間のローリング使用量
2. その固定窓で割った1時間当たりの平均消費速度と、1時間バケットの実績

## D38: 使用量の時刻はターン完了時刻とし、半開区間で集計する

`turn_usage.created_at` は既に各ターンの終端イベントを記録した時刻を UTC の ISO 8601 形式で保持
している。新しい列や履歴テーブルは追加せず、リクエストごとに daemon が一度だけ `as_of` を決め、
次の半開区間を集計する。

```text
[as_of - window, as_of)
```

- 既定の `window` は5時間。`agvsr usage` の既存動作は互換性のため累積のままとする。
- usage はターン完了時にしか確定しないため、実行中ターンは窓に含めない。timeout / kill などで
  終端usageを取得できなかったターンもD32どおり未計測であり、0トークンとして補完しない。
- 長いターンが窓の開始前に始まり窓内に完了した場合は全量を窓内へ計上する。CLIイベントから
  ターン途中の消費時系列を得られないため、按分はしない。
- `as_of` はクライアント時刻ではなくdaemon時刻を使い、totals・ロール別・ジョブ別・バケット別の
  全クエリで同じ値を共有する。これにより境界付近でも各表の合計が一致する。

全ジョブを時刻だけで絞るクエリを効率化するため、既存の `(job_id, created_at)` に加えて次を作る。

```sql
CREATE INDEX IF NOT EXISTS idx_turn_usage_created_at ON turn_usage(created_at);
```

`CREATE INDEX IF NOT EXISTS` なので既存DBはdaemon起動時に安全に更新でき、データ移行は不要。

## D39: 「時間当たり速度」は固定窓の合計を窓長で割る

5時間ローリング平均は、最初と最後の観測ターン間隔ではなく、要求された壁時計上の窓全体で割る。

```text
rate_per_hour(metric) = window_totals(metric) / (window_ms / 3_600_000)
```

対象は `turns`、全token列、報告済みの `cost_usd`。この定義なら無活動時間も速度低下として反映され、
同じ窓を連続観測した値を比較できる。`cost_partial` は合計から継承し、Codexを含む速度の金額表示にも
`+`を付ける。これは請求額やプロバイダー残量ではなく、D32と同じく実測値の代理指標である。

突発的な消費を平均だけで隠さないため、`--hourly` は窓をUTC正時で1時間バケットに分割して実績を
返す。空のバケットも0で返し、先頭と末尾の部分バケットは `partial: true` とする。部分バケットを
1時間相当に外挿すると急増を誇張するため、バケット行は速度へ変換せず実績値のまま表示する。

各バケットにも `cost_partial` を保持する。全トークン列は、バケットを合計すると同じ期間のtotalsと
一致しなければならない。

## D40: 既存のusage.reportを時間窓対応に拡張する

### CLI

```text
agvsr usage [job-id] [--since DURATION] [--hourly] [--json]
```

- `--since 5h`: 直近5時間のローリング集計。`m`、`h`、`d`を受理し、正の整数だけを許可する。
- `--hourly`: 1時間バケットを追加表示する。単独指定時は `--since 5h` を暗黙適用する。
- `--since` と `--hourly` の併用時は1時間以上を必須とする。`--since 30m --hourly` のような
  組み合わせはCLIで先に検証し、`--hourly requires --since of at least 1h` と表示して終了する。
  daemonも同じ制約を検証し、CLIを介さないIPCクライアントを保護する。
- `--json`: human表示と同じ期間メタデータ、totals、rates、breakdown、bucketsを返す。
- job-idとの併用を許可し、そのジョブだけを同じ期間で絞る。
- `agvsr usage`、`agvsr usage <job-id>`、既存JSONフィールドは変更しない。期間指定時だけ新しい
  フィールドを追加し、古いクライアント／daemon間の互換性を保つ。

human表示例：

```text
WINDOW  last 5h  2026-08-10T03:15:00Z..2026-08-10T08:15:00Z
TOTAL   42 turns  in 1.20M  out 180.0k  cache_r 40.00M  $8.40+
RATE/h  8.4 turns  in 240.0k  out 36.0k  cache_r 8.00M  $1.68+

by hour (UTC):
  03:15-04:00*  ...
  04:00-05:00   ...
  08:00-08:15*  ...
  * partial hour
```

### IPC

`usage.report` のparamsを次へ拡張する。

```ts
params?: {
  job_id?: string;
  window_ms?: number;
  bucket_ms?: number; // 初期実装では 3_600_000 のみ
}
```

daemonは有限の正数であること、`bucket_ms <= window_ms`であること、`window_ms`が30日以下で
あることを検証する。CLIはdurationをミリ秒へ変換して同じ条件を先に検証するが、daemon側でも必ず
検証し、不正値は既存のエラー命名規約に合わせて `bad_request` とする。30日超の値はサイレントに
クランプせず拒否する。

期間指定時のレスポンスを次へ拡張する。

```ts
interface UsageWindow {
  start_at: string;
  end_at: string;
  window_ms: number;
}

interface UsageRate extends UsageTotals {
  // 各数値は1時間当たり。整数に丸めず number のまま返す。
}

interface UsageBucket {
  start_at: string;
  end_at: string;
  partial: boolean;
  totals: UsageTotals;
}

interface UsageReport {
  totals: UsageTotals;
  by_role: UsageBreakdown[];
  by_job: UsageByJob[];
  window?: UsageWindow;
  rate_per_hour?: UsageRate;
  buckets?: UsageBucket[];
}
```

`UsageRate.cost_partial` は速度の下限表示に必要なので残す。`turns`も小数になり得るため、型を
再利用する場合は `UsageTotals` の各数値が必ず整数という暗黙前提を置かない。より強い型が必要なら
`UsageRate`を同フィールドの独立interfaceとして定義する。

### Store

`usageReport(jobId?, range?)` へ範囲を渡し、全SQLへ共通の次のpredicateを加える。

```sql
u.created_at >= $start_at AND u.created_at < $end_at
```

文字列連結で任意WHERE句を受ける範囲を広げず、`UsageRange`から固定predicateとbind paramsを作る
小さなhelperを用意する。

バケットは範囲predicateを適用したうえで、UTC保存済みの `created_at` をSQLiteで正時へ丸める単一の
`GROUP BY` クエリで集計する。

```sql
strftime('%Y-%m-%dT%H:00:00Z', u.created_at)
```

daemonは `[start_at, end_at)` と交差するUTC正時境界を列挙し、SQLが返さなかった時間を0値で補完し、
先頭・末尾へ `partial` を設定する。バケットごとの個別SQLは発行しない。最大30日の検証責任は
公開境界であるdaemonに置き、Storeは検証済みの `UsageRange` を受け取るだけでクランプしない。
1時間バケットならレスポンスは最大721区間（両端が部分時間の場合）に収まる。

## エラーと表示上の注意

- 期間内に記録がなければ累積時と区別する。全ジョブでは
  `no accounted turns in the last 5h`、job-id指定時は
  `no accounted turns for job <job-id> in the last 5h` と表示する。
- 0件でも `window` と、要求された場合は0値で埋めたバケット列をJSONで返す。監視側が欠測とゼロを区別できる。
- daemon再起動や時計調整で `created_at` が将来になった既存行は `[start, end)` から自然に除外される。
- 表示タイムゾーンは初期実装ではUTCに固定する。human表示で明記し、JSONは常にISO 8601 UTCとする。
- Claude/Codexのプラン残量、上限到達予測、モデル別価格換算は行わない。

## テスト計画

### Store unit

固定した `created_at` を注入できるよう、`recordTurnUsage`にテスト専用時刻ではなくoptionalな
`recorded_at`、またはStore constructorへclockを与える。production既定は現在時刻のままとする。

- 開始境界を含み、終了境界を含まない。
- job・role・adapter・model絞り込みと時間窓が同時に効く。
- 5時間totalsが各1時間バケットの合計と一致する。整数のtoken列は厳密比較し、SQLite `REAL` の
  `cost_usd` は加算順序による誤差を許容する近似比較を使う。
- 空時間のバケットが0で埋まり、先頭／末尾だけがpartialになる。
- 報告コストなしのターンが窓・速度・バケットすべてで`cost_partial`を立てる。
- D32以前／本機能以前のDBを開くと新indexが作られ、既存usageを失わない。

### Protocol / daemon

- `window_ms`なしは従来の累積レスポンスと同一。
- 5時間指定はdaemonが返した同一`end_at`を全集計に使う。
- 0、負数、NaN相当、30日超、未対応bucketを `bad_request` で拒否し、値をクランプしない。
- `window_ms < bucket_ms`（例: 30分窓と1時間bucket）を `bad_request` で拒否する。
- 存在しないjob-idの既存エラー契約を維持する。

### CLI

- `5h`などのduration parse、0・小数・未知suffix・overflowの拒否。
- `--hourly`単独で5時間が適用される。
- `--since 30m --hourly`をdaemonへ送る前に、規定のCLIメッセージで拒否する。
- human表示に期間、`RATE/h`、UTC、partial hour、コスト下限記号が出る。
- JSONが丸め前の数値と期間境界を保持する。
- 期間0件時と全期間0件時を区別し、期間0件ではjob-id有無の2文面も検証する。

## 段階的な実装順

1. Storeのrange集計と時刻index、境界テスト。
2. `usage.report`のoptionalなwindow metadataとrate。既存呼び出しの回帰テスト。
3. CLIの`--since`とhuman/JSON表示。
4. 1時間バケットと`--hourly`。

この順なら各段階で既存の累積表示を壊さず、ローリング合計を先に利用可能にできる。

## 非ゴール

- プロバイダーの残量APIとの連携、5時間上限への到達時刻予測、自動停止。
- usageを返さなかったturnの推定や、実行中turnの途中経過推定。
- モデル価格表を内蔵したCodexコスト推定。
- Web UI、通知、永続的な事前集計テーブル。現在規模ではindex付き生データ集計で十分とする。
