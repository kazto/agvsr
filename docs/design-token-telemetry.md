# Token telemetry design

目的: agvsr が投入した `codex` / `claude-code` / `agy` の各ターンについて、
OpenTelemetry 由来のトークン消費量を収集し、ジョブ・役割・アダプタ・モデル単位で集計して
CLI / Web / 監査ログから確認できるようにする。

この文書は実装前の設計メモ。既存設計との関係では、D4/D14 の「コスト上限」、
D13 の監査台帳、D26 の通知/フックに接続する。

## 背景

現状の agvsr はターンの stdout/stderr と構造化イベントを `runTurn()` で観測しているが、
トークン使用量は永続化していない。`codex` は JSON イベントに `turn.completed.usage` を出す
実績がある一方、`claude-code` と `agy` も OpenTelemetry を使った計測が可能である。
3 アダプタ横断の機能としては、CLI 固有 stdout のパースを増やすより、OpenTelemetry を
第一級の入力チャネルにする方が拡張しやすい。

OpenTelemetry 側の前提:

- OTLP/HTTP exporter は既定で `http://localhost:4318` を使い、ベース endpoint から
  `/v1/traces` / `/v1/metrics` / `/v1/logs` へ送る。
- Generative AI semantic conventions には `gen_ai.usage.input_tokens`、
  `gen_ai.usage.output_tokens`、`gen_ai.usage.reasoning.output_tokens`、
  `gen_ai.usage.cache_read.input_tokens`、`gen_ai.usage.cache_creation.input_tokens` がある。
- ただし GenAI conventions は移動/発展中なので、agvsr の永続スキーマは OTel 属性名に
  直接固定せず、正規化済みカラム + raw payload を併存させる。

## 方針

agvsr daemon がジョブ実行中だけローカル OTLP receiver を持ち、子 CLI の OTel exporter を
その receiver に向ける。receiver は受け取った span/log/metric からトークン使用量を抽出し、
`job_id` / `role` / `adapter` / `model` / `turn_id` に紐づけて SQLite に保存する。

```text
agvsrd
  ├─ runTurn(role=implementation, adapter=codex, model=...)
  │    env: OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:<port>
  │         OTEL_RESOURCE_ATTRIBUTES=service.name=agvsr-agent,agvsr.job_id=...,agvsr.role=...
  │
  ├─ local OTLP receiver
  │    POST /v1/traces
  │    POST /v1/logs
  │    POST /v1/metrics
  │
  └─ SQLite token_usage tables
```

原則:

1. agvsr 自身が exporter を強制設定する。ユーザの既存 OTel 設定を壊さないため、既定は
   agvsr 内部 receiver に向けるが、team.yaml で外部 collector への forward も許す。
2. レポートの正は SQLite。OTel は入力チャネルであり、レポート時に外部 collector を
   問い合わせない。
3. attribution は agvsr が付ける。各 CLI が出す span 名や provider 属性だけに頼らず、
   `runTurn()` が発行する `turn_id` と環境変数で必ず相関 ID を注入する。
4. exact once は狙わない。OTel exporter は retry するため重複があり得る。span/log id と
   属性 fingerprint で実用的に dedupe する。

## Configuration

`team.yaml` の top-level に `telemetry` を追加する。

```yaml
telemetry:
  tokens:
    enabled: true
    mode: local # local | external | off
    listen_host: 127.0.0.1
    listen_port: 0
    export_raw: true
    external_endpoint: null
    forward_to_external: false
```

意味:

- `enabled`: トークン計測機能を有効化する。既定は `false` から始める。安定後に既定有効化を検討。
- `mode: local`: agvsrd が OTLP/HTTP receiver を起動し、子 CLI をそこへ向ける。
- `mode: external`: agvsr は receiver を持たず、子 CLI を `external_endpoint` へ向ける。
  SQLite レポートはできないため、`agvsr tokens` は「external mode」と表示するだけ。
- `mode: off`: OTel 環境変数を注入しない。
- `forward_to_external`: local receiver で保存した後、同じ OTLP payload を外部 collector に
  best-effort forward する。失敗してもジョブは失敗させない。

環境変数 override:

- `AGVSR_TOKEN_TELEMETRY=0|1`
- `AGVSR_OTLP_ENDPOINT=http://127.0.0.1:4318`
- `AGVSR_OTLP_FORWARD_ENDPOINT=https://collector.example/v1/...`

## Turn correlation

各ターン開始時に daemon が `turn_id = randomUUID()` を作る。`TurnDispatch` と `AgentSpec.env`
へ以下を追加する。

```text
AGVSR_JOB_ID=<job id>
AGVSR_ROLE=<role>
AGVSR_ADAPTER=<adapter>
AGVSR_MODEL=<model>
AGVSR_TURN_ID=<turn id>
OTEL_SERVICE_NAME=agvsr-agent
OTEL_RESOURCE_ATTRIBUTES=service.name=agvsr-agent,agvsr.job_id=...,agvsr.role=...,agvsr.adapter=...,agvsr.model=...,agvsr.turn_id=...
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:<local-port>
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
```

一部 CLI が `OTEL_RESOURCE_ATTRIBUTES` を無視する場合に備え、receiver 側では次の順で
相関する。

1. resource/span/log/metric attributes の `agvsr.turn_id`
2. resource attributes の `process.command_line` または `process.command_args` から、
   daemon が生成した一時 OTel token を探す
3. 受信時刻が turn の `[started_at, ended_at + flush_grace]` に入り、かつ role の in-flight が
   1 つだけなら補完
4. それでも不明なら `unattributed_token_usage` として保存し、レポートでは別枠にする

## Receiver

実装は `src/telemetry/otlp.ts` に置く。

v1 は OTLP/HTTP のみを受ける。OTLP/gRPC は不要。ほとんどの SDK/CLI は env var で
`http/protobuf` にできるため、依存を増やさない。

受ける endpoint:

- `POST /v1/traces`
- `POST /v1/logs`
- `POST /v1/metrics`

payload は protobuf。Bun で扱いやすいよう、`@opentelemetry/otlp-transformer` などを採用するか、
最小の protobuf decoder を内部に持つ。依存追加を避けたい場合は、初期版だけ
`OTEL_EXPORTER_OTLP_PROTOCOL=http/json` を指定して JSON receiver から始めてもよい。

推奨は二段階:

1. Phase A: `http/json` receiver で end-to-end を作る。
2. Phase B: `http/protobuf` receiver を追加し、既定を spec 推奨に寄せる。

## Normalization

抽出対象は以下。

```ts
interface TokenUsageSample {
  id: string;
  job_id: string | null;
  role: string | null;
  adapter: "claude-code" | "codex" | "agy" | null;
  model: string | null;
  turn_id: string | null;
  session_id: string | null;
  source_signal: "trace" | "log" | "metric" | "stdout";
  source_name: string | null;
  source_id: string | null;
  input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  total_tokens: number;
  cost_usd: number | null;
  raw_json: string | null;
  observed_at: string;
}
```

属性名の優先順:

1. Current GenAI names:
   - `gen_ai.usage.input_tokens`
   - `gen_ai.usage.output_tokens`
   - `gen_ai.usage.reasoning.output_tokens`
   - `gen_ai.usage.cache_read.input_tokens`
   - `gen_ai.usage.cache_creation.input_tokens`
2. Deprecated aliases:
   - `gen_ai.usage.prompt_tokens` -> `input_tokens`
   - `gen_ai.usage.completion_tokens` -> `output_tokens`
3. Adapter-specific fallbacks:
   - codex JSON event `turn.completed.usage`
   - known claude-code OTel fields, if different
   - known agy OTel fields, if different

`total_tokens = input_tokens + output_tokens` unless the provider explicitly gives a total.
`reasoning_output_tokens` is included in `output_tokens` when the provider follows GenAI conventions;
do not add it twice.

## Storage

Add tables to `Store.migrate()`.

```sql
CREATE TABLE token_usage_samples (
  id TEXT PRIMARY KEY,
  job_id TEXT,
  role TEXT,
  adapter TEXT,
  model TEXT,
  turn_id TEXT,
  session_id TEXT,
  source_signal TEXT NOT NULL,
  source_name TEXT,
  source_id TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  raw_json TEXT,
  observed_at TEXT NOT NULL,
  UNIQUE(source_signal, source_id, turn_id)
);

CREATE INDEX idx_token_usage_job ON token_usage_samples(job_id, observed_at);
CREATE INDEX idx_token_usage_role ON token_usage_samples(job_id, role);
CREATE INDEX idx_token_usage_turn ON token_usage_samples(turn_id);
```

Optional pricing table, disabled by default:

```sql
CREATE TABLE token_price_rules (
  adapter TEXT NOT NULL,
  model TEXT NOT NULL,
  input_usd_per_1m REAL,
  output_usd_per_1m REAL,
  reasoning_output_usd_per_1m REAL,
  currency TEXT NOT NULL DEFAULT 'USD',
  effective_from TEXT NOT NULL,
  source TEXT,
  PRIMARY KEY (adapter, model, effective_from)
);
```

Pricing is explicitly best-effort. Model prices change and may depend on account, region, cache,
batching, or subscription. Token counts are first-class; cost is an optional derived estimate.

## CLI / API

Add requests:

```ts
{ method: "usage.summary", params: { job_id?: string } }
{ method: "usage.samples", params: { job_id: string } }
```

Add CLI:

```bash
agvsr tokens                 # all recent jobs, compact table
agvsr tokens <job-id>        # per-role and per-turn summary
agvsr tokens <job-id> --json # machine readable
```

Human output example:

```text
job 2f80372d  done

role             adapter      model                 turns  input  output  reasoning  total
supervisor       claude-code  claude-opus-4-8          5   18210    4210        910  22420
design           claude-code  claude-sonnet-4-6        2    8210    3122          0  11332
implementation   codex        gpt-5.4                  4   29410    6901       1200  36311
qa               agy          gemini-...               2    9031    2210          0  11241

total                                              13   64861   16443       2110  81304
```

`agvsr status <job-id>` should add one compact line:

```text
tokens: 81,304 total (64,861 input, 16,443 output, 2,110 reasoning)
```

The web gateway can expose the same summary in job detail, using the same IPC request.

## Watchdog / budgets

Add optional token budgets to `team.yaml`.

```yaml
telemetry:
  tokens:
    enabled: true
    budgets:
      job_total_tokens: 500000
      role_total_tokens:
        supervisor: 150000
        implementation: 250000
```

Budget checks run after each token sample insert and at turn completion.

- Soft threshold: at 80%, write a `note` to audit log and notify supervisor.
- Hard threshold: at 100%, Tier2 fail the job unless the in-flight turn has already exited.
- If telemetry is missing or late, budget enforcement is best-effort and must not be the only
  safety cap. Timeouts remain the deterministic backstop.

## Hooks

Extend existing D26 hooks with token fields, no new hook names required initially.

`on_job_done` / `on_job_failed` event JSON gets:

```json
{
  "token_usage": {
    "input_tokens": 64861,
    "output_tokens": 16443,
    "reasoning_output_tokens": 2110,
    "total_tokens": 81304,
    "cost_usd": null,
    "by_role": []
  }
}
```

Optionally add `on_token_budget_warning` later if soft threshold notifications need separate routing.

## Adapter notes

### codex

Use both channels:

- Primary: OTel receiver, same as other adapters.
- Fallback: existing `--json` stream `turn.completed.usage`.

The fallback should emit `source_signal="stdout"` samples with `source_id` derived from
`turn_id + event offset` so reports work even when Codex OTel is unavailable.

### claude-code

Primary: OTel receiver. Inject standard OTEL env vars from `runTurn()`.

Need one spike to confirm:

- which signal carries usage: span attributes, log records, or metrics
- exact attribute names
- whether `OTEL_RESOURCE_ATTRIBUTES` is preserved
- whether exporter flushes before process exit in `-p` resume-invoke mode

### agy

Primary: OTel receiver. Because agy stdout is not structured, OTel is the only robust token source.

Need one spike to confirm:

- whether agy honors OTLP/HTTP env vars
- whether it uses Gemini/GenAI attributes or Google-specific names
- whether sandbox mode blocks localhost exporter traffic

If agy cannot export to local loopback under its sandbox, support `mode: external` or write telemetry
to a CLI-supported file exporter if available.

## Privacy and security

- Store token counts and low-cardinality metadata by default.
- Do not persist prompt/completion bodies from OTel events by default. If raw payload storage is enabled,
  redact known body attributes (`gen_ai.input.messages`, `gen_ai.output.messages`,
  `gen_ai.system_instructions`, prompt/completion aliases) before writing `raw_json`.
- Bind local receiver to `127.0.0.1` only.
- Do not open a network listener in `mode: off` or `mode: external`.
- Forwarding to external collectors is opt-in because it may disclose local workflow metadata.

## Implementation plan

1. Add config schema for `telemetry.tokens` and parse env overrides.
2. Add `turn_id` to daemon dispatch and inject `AGVSR_*` + `OTEL_*` env vars in `defaultTurnRunner`.
3. Add local OTLP/HTTP JSON receiver behind a feature flag.
4. Add token normalizer with unit tests for GenAI current names, deprecated aliases, and codex stdout fallback.
5. Add SQLite `token_usage_samples` migration and store methods.
6. Add `usage.summary` / `usage.samples` IPC handlers.
7. Add `agvsr tokens` CLI and compact `status <job-id>` token line.
8. Add budget checks as a separate phase after collection/reporting is stable.
9. Spike protobuf receiver and switch default protocol from `http/json` to `http/protobuf`.

## Tests

- `parseTeam` accepts/validates telemetry config and defaults.
- `runTurn` env injection includes correlation IDs when telemetry is enabled.
- OTLP receiver accepts minimal trace/log/metric JSON payloads and stores normalized samples.
- Normalizer dedupes repeated samples with same source id.
- codex stdout `turn.completed.usage` fallback creates a sample when OTel is absent.
- `usage.summary` aggregates by job, role, adapter, model, and turn.
- `agvsr tokens --json` is stable and machine-readable.
- Budget warning writes a `note`; hard budget fails a fake running job.

## Open questions

- Exact OTel knobs for `claude-code` and `agy` need real-machine spikes.
- Whether to depend on OTel protobuf packages or keep a small decoder.
- Whether cost estimation belongs in core or should be an external report plugin.
- Whether raw OTel payloads should default to off permanently, even for debugging.

## References

- OpenTelemetry OTLP exporter configuration:
  https://opentelemetry.io/docs/specs/otel/protocol/exporter/
- OpenTelemetry GenAI semantic convention attributes:
  https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/
