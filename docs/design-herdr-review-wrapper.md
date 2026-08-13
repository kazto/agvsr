# 設計: Herdr レビュー依頼の同一ワークスペース強制ラッパー

## 1. 背景と問題

agvsr のジョブは作成時に Herdr の `workspace_id`、`workspace_name`、
`caller_pane_id`、`herdr_session` を保存する。さらに `2d9b1ec` 以降、ワーカーには
デーモン起動元ではなく、そのジョブ固有の `HERDR_WORKSPACE_ID` を渡している。

しかし PR レビュー依頼は、ワーカーが直接 `herdr agent list` と
`herdr agent prompt` を操作する手順に依存している。`agent list` は全ワークスペースの
agent を返すため、種類だけで最初の Codex/Claude を選ぶと、growllover (`w6`) の依頼を
agvsr (`w1`) の agent へ送れてしまう。ID の衝突ではなく、候補選択に構造的な
workspace 制約がないことが原因である。

## 2. 目的と非ゴール

目的:

- レビュー依頼先を、ジョブに保存された `workspace_id` と一致する live agent に限定する。
- workspace 不一致、候補なし、候補複数、Herdr 応答不正をすべて送信前に拒否する。
- agent が pane ID を手入力・推測せずにレビューを依頼できるようにする。
- 解決結果と拒否理由を agvsr の監査ログへ残す。
- 初回レビューと再レビューで同じ reviewer を明示的に再利用できるようにする。

非ゴール:

- Herdr の汎用 `agent prompt` 自体を変更すること。
- 複数 Herdr session を横断して reviewer を探索すること。
- reviewer agent の新規起動、pane 分割、workspace 作成を自動化すること。
- PR の取得、GitHub review 投稿、merge をラッパー内部で行うこと。
- shell からの直接 `herdr agent prompt` をOSレベルで完全に禁止すること。

最後の項目は重要である。本設計は正規経路を fail-closed にするが、任意shell実行が可能な
agentによる迂回を完全には封じない。charterで直接送信を禁止し、将来必要ならHerdr側の
workspace-bound capabilityを別途導入する。

## 3. 採用案

既存の agent 用 MCP shim に `agvsr_request_review` を追加する。shim は対象 pane を
解決せず、`review.request` IPC を現在の `AGVSR_JOB_ID` と `AGVSR_ROLE` 付きでデーモンへ
中継する。デーモンがStoreのジョブ情報とHerdr live stateを照合し、検証済みpaneへ
`herdr agent prompt`を実行する。

```text
worker
  │ agvsr_request_review(kind, body, reviewer_pane_id?)
  ▼
MCP shim ── review.request(job_id, from_role, ...)
  ▼
daemon
  ├─ Store: job.workspace_id / caller_pane_id / herdr_session
  ├─ Herdr: agent list
  ├─ same-workspace / kind validation
  ├─ fail closed on 0 or >1 candidates
  ├─ audit message
  └─ agent prompt <verified pane_id> <body>
```

シェル用にも同じIPCを呼ぶ薄い `agvsr review request` CLIを用意できるが、第一段では
agentが既に利用するMCP toolを正規経路とする。CLIを追加する場合も独自解決ロジックを
持たず、必ず同じ `review.request` handlerを使う。

## 4. API

### 4.1 MCP tool

```ts
agvsr_request_review({
  reviewer_kind: "claude" | "codex",
  body: string,
  reviewer_pane_id?: string,
})
```

- `reviewer_kind`: 自分と逆のagent種別。将来拡張可能な文字列ではなく第一段は列挙型。
- `body`: PR URL、対象commit、base、確認事項、結果の返却先を含むレビュー依頼本文。
- `reviewer_pane_id`: 再レビュー時のみ推奨。初回成功時に返されたpane IDを指定する。
  指定されてもworkspace/kindの再検証を省略しない。

成功結果:

```json
{
  "reviewer_pane_id": "w6:p2",
  "workspace_id": "w6",
  "workspace_name": "growllover",
  "reviewer_kind": "codex"
}
```

### 4.2 IPC

```ts
{
  method: "review.request",
  params: {
    job_id: string;
    from_role: string;
    reviewer_kind: "claude" | "codex";
    body: string;
    reviewer_pane_id?: string;
  };
}
```

`job_id` と `from_role` はagent入力を信用せず、shimの起動環境から固定する。daemonは
`job_id` が存在してrunningであること、および `from_role` がそのジョブの有効roleで
あることも確認する。

## 5. Herdr client拡張

`HerdrClient` に次を追加する。

```ts
interface HerdrAgent {
  pane_id: string;
  workspace_id: string;
  agent: string; // Herdrが検出したagent kind/name
  agent_status: string;
  cwd: string | null;
}

listAgents(session?: string | null): Promise<HerdrAgentListResult>;
```

既存メソッドのように `null` へ握りつぶすだけでは、候補なしとHerdr障害を区別できない。
レビュー送信はfail-closedが必要なため、結果を判別可能にする。

```ts
type HerdrAgentListResult =
  | { ok: true; agents: HerdrAgent[] }
  | { ok: false; code: "unavailable" | "timeout" | "invalid_response"; message: string };
```

`herdr agent list` のJSONをZodまたは手動の厳格なshape checkで検証する。未知フィールドは
許容するが、候補に必要な `pane_id`、`workspace_id`、`agent` が欠けた行は候補にしない。
Herdr CLI呼び出しにはジョブ保存済み `herdr_session` を渡す。

## 6. 解決アルゴリズム

1. Storeからジョブを取得する。
2. `workspace_id` がnullなら `review_workspace_unavailable` で拒否する。cwdやlabelから
   workspaceを推測しない。
3. `listAgents(job.herdr_session)` を実行する。失敗・timeout・不正JSONは拒否する。
4. `agent.workspace_id === job.workspace_id` の候補だけを残す。
5. `agent.agent === reviewer_kind` の候補だけを残す。Herdrが将来kindとrename済みnameを
   分離する場合は、kindフィールドを優先するようadapter内で正規化する。
6. 依頼roleのadapterと `reviewer_kind` が同じなら拒否する。reviewerは別agent kindという
   workflow契約をdaemon側でも検証する。ただし `caller_pane_id` は除外しない。たとえば
   growllover jobをClaude paneから投入し、Codex implementationがそのClaudeへレビューを
   依頼する構成では、caller paneが正しいreviewerだからである。
7. `reviewer_pane_id` 指定時は、候補に完全一致する1件だけを許可する。不一致なら拒否し、
   別候補へ自動fallbackしない。
8. 未指定時は候補がちょうど1件の場合だけ選択する。
9. 0件なら `reviewer_not_found`、2件以上なら `reviewer_ambiguous` と候補pane ID一覧を返す。
   自動的にfocused/idle/先頭のagentを選ばない。
10. 選択直後、`promptAgent` 前に同じsnapshot上のworkspace/kindを再確認する。
11. prompt成功を確認して監査ログを記録し、選択したpane IDを返す。

agent状態は初期版では選択条件にしない。working agentにもHerdrはpromptをqueueできるためで
ある。ただし `blocked` や `unknown` を警告として成功結果へ含めてもよい。

## 7. 監査とエラー

成功時、messagesへ `from_role -> daemon`, kind=`note` として次を保存する。

```text
Herdr review requested: workspace=w6(growllover), reviewer=codex, pane=w6:p2
```

本文全体はHerdrへ送るが、監査ログにはPR URL・commitと文字数制限付きpreviewだけを残し、
既存Web監査と同様に無制限な本文複製を避ける。

拒否コード:

- `review_workspace_unavailable`: standalone jobまたはworkspace未保存
- `herdr_unavailable`: CLI/server/timeout/JSON障害
- `reviewer_not_found`: 同一workspaceに指定kindがいない
- `reviewer_ambiguous`: 同一workspaceに指定kindが複数いる
- `reviewer_mismatch`: 指定paneのworkspaceまたはkindが違う
- `reviewer_same_kind`: 依頼roleとreviewerが同じagent kind
- `review_delivery_failed`: 検証後のprompt実行失敗

全エラーはMCPの `isError: true` で返し、別workspaceへのfallbackは絶対に行わない。

## 8. 直接Herdr経路の扱い

`charters/scaffold.md` とレビュー手順を次のように更新する。

- PRレビュー依頼・再レビュー依頼は必ず `agvsr_request_review` を使う。
- `herdr agent list` から自分でreviewerを選んで `herdr agent prompt` してはならない。
- 初回成功で返った `reviewer_pane_id` を監査メッセージと作業メモに保存し、再レビューへ渡す。
- wrapperが曖昧性を返した場合は人間へエスカレーションし、先頭候補を選ばない。

これは事故防止を大きく改善するが、任意shell経由の迂回を技術的には残す。完全な強制が必要なら
第二段として、Herdrに「caller workspace外へのpromptを拒否する scoped token/API」を追加し、
agvsrワーカーへはそのtokenだけを渡す。PATH上の偽 `herdr` や文字列ベースのshell denylistは
迂回可能かつ保守困難なので採用しない。

## 9. テスト計画

### Unit: `src/herdr/client.ts`

- `agent list` の正常JSONを正規化する。
- non-zero、timeout、不正JSON、必須フィールド欠落を区別する。
- `HERDR_SESSION` をlist/promptの両方へ渡す。

### Daemon integration

- `w6` job + `w1 codex`, `w6 codex` なら `w6`だけへ送る。
- 一覧順が `w1`先頭でも結果が変わらない（今回の回帰テスト）。
- `reviewer_pane_id=w1:p2` を指定すると `reviewer_mismatch` でprompt 0回。
- 同一workspaceにCodexが0件なら拒否する。
- 同一workspaceにCodexが2件なら曖昧性で拒否する。
- 明示paneが1件に一致すれば再レビューを同じpaneへ送る。
- standalone job、閉じたpane、Herdr障害でfallbackしない。
- 依頼roleと同じagent kindは拒否する。
- caller paneでも、同一workspaceかつ逆kindなら正当なreviewerとして許可する。
- 成功・拒否とも監査記録が残る。

### MCP shim

- tool入力を `review.request` へ正しく中継する。
- `job_id/from_role` をtool引数から上書きできない。
- daemonの構造化エラーを `isError: true` としてagentへ返す。

### 実Herdr smoke

名前の異なる2workspaceに同じkindのagentを1体ずつ置き、growllover相当jobから依頼する。
対象workspace側だけに固有markerが到着し、他方には到着しないことを目視/agent readで確認する。
このsmokeは既存ユーザーagentへ実メッセージを送るため、専用テストsession/workspaceで行う。

## 10. 導入順序

1. `HerdrClient.listAgents` と失敗型を追加する。
2. `review.request` protocol/daemon handlerとpure resolverを追加する。
3. MCP `agvsr_request_review` を追加する。
4. unit/integration回帰テストを追加する。
5. charter、README、growlloverのissue workflowテンプレートを更新する。
6. デーモンを再起動する。既存running jobもStoreのworkspace IDを使えるが、既に起動済みの
   agent sessionには新MCP tool定義が反映されない可能性があるため、新規ジョブから必須化する。
7. 専用Herdr sessionで実smokeを行う。

## 11. 受入条件

- growllover jobからのレビュー依頼が、一覧順に関係なくagvsr workspaceへ配送されない。
- 別workspaceのpane IDを明示しても配送前に拒否される。
- 候補を一意に決められない場合、配送せず具体的なエラーを返す。
- 再レビューは初回に返した同じpaneを再検証して利用できる。
- Herdr停止・不正応答時に別経路や別workspaceへfallbackしない。
- 配送先workspace/pane/kindと拒否理由を監査できる。
- 既存のfront-desk escalation (`caller_pane_id`への通知) は挙動不変である。
