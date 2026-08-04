# 設計: herdr 統合（herdr mode / ワークスペース紐付け / 窓口エージェントへのエスカレーション）

agvsr は「AI エージェントが herdr のペイン内から呼び出す」運用を主眼に据え、herdr と統合する。
design.md の D1〜D28 に続く決定として記録する。

## 背景

agvsr はこれまで人間が CLI/Web を直接操作する前提だった（design.md D15）。実際の運用では、
人間は herdr ペイン内の AI エージェント越しにしか agvsr を見ておらず、その前提がずれていた。
今回、ジョブ投入元が herdr ペインであることを積極的に利用し、(1) ジョブにワークスペース識別子を
付与し、(2) 人間へのエスカレーションを、そのジョブを投入したペインを占有するエージェント
(「窓口エージェント」) 経由でも配送できるようにする。

## D29: herdr mode / standalone mode の自動切り替え（明示的拒否はしない）

`agvsr job` はプロセス起動時の env（`HERDR_ENV=1` かつ `HERDR_WORKSPACE_ID` が設定されている
か）を見て、herdr mode と standalone mode を自動的に切り替える。

- **herdr mode**: `HERDR_WORKSPACE_ID`（および利用可能なら `HERDR_PANE_ID`/`HERDR_SESSION`）を
  `job.create` の params に含めて送信する。ジョブにワークスペース紐付け（D30）と窓口エージェント
  へのエスカレーション（D31）が有効になる。
- **standalone mode**: herdr 関連の env が無ければ通常通りジョブを投入する。ジョブの herdr 関連
  フィールドは全て `null` のまま。**明示的な拒否はしない** — herdr は「使えるときに深く使う」
  強化であって、必須のゲートではない。
- モード判定は `agvsr` CLI の `job` サブコマンド（`src/cli/agvsr.ts`）だけで行う。デーモン/
  プロトコル層（`job.create` の IPC ハンドラ）は herdr フィールドを常に optional として扱い、
  一切の必須チェックを掛けない。これにより IPC を直接叩くテストや将来の非 CLI クライアントは
  無改修で動く。
- `agvsr doctor` に herdr チェックグループを追加したが、バイナリ不在も env 未設定も `warn` に
  留める（`fail` にしない）。

## D30: ワークスペース名をジョブの追加識別子として付与する

各ジョブ作成時、`workspace_id`（`HERDR_WORKSPACE_ID` の生値）と、それを `herdr workspace list`
で解決した `workspace_name`（herdr 側の `label` フィールド）を保存する。

- **既存の team.yaml/team.toml 解決（D9, cwd ベース）は変更しない。** ワークスペース名は
  あくまで追加の識別子であり、どの team ファイルを読むかのロジックには影響しない。
- 解決はベストエフォート: `herdr workspace list` が失敗・タイムアウトしても job 作成は
  ブロックされず、`workspace_name` が `null` のまま作成される。
- `src/herdr/client.ts` の `resolveWorkspaceName()` が実装を持つ。`HERDR_SESSION` が異なる
  herdr セッション/ソケットを指すため、ジョブ投入元プロセスの値をそのまま herdr CLI 呼び出しに
  渡す（`herdr/src/session.rs` の `HERDR_SESSION` 仕様に準拠）。

## D31: 窓口エージェントへのエスカレーション配送

supervisor が人間宛てにメッセージを出す・ジョブが完了/失敗/停滞するタイミングで、既存の
`hooks:`（`on_job_done`/`on_job_stalled`/`on_supervisor_message`/`on_job_failed`）や Web push に
加えて、そのジョブを投入した herdr ペイン（`caller_pane_id`）に `herdr agent prompt` でテキストを
直接差し込む。

- 「窓口エージェント」= **そのジョブを投入した呼び出し元エージェント**。herdr の `agent`
  サブコマンドは pane id をターゲットとして直接受け付ける（生きているエージェント名の解決は
  不要）ため、`caller_pane_id` を保存しておけば十分。
- 配送は既存の `hook()` 関数（`src/daemon/daemon.ts`）1箇所に集約する。個々の呼び出し箇所
  （msg.send to=user, msg.escalate, job.complete/job.fail 等）を増やさない。
- **既存の CLI/Web/フック経路は撤去しない**。herdr 配送はそれらと並行する追加チャネルであり、
  フォールバックではなく同時配送。
- `herdr agent prompt` は `--wait` を付けずに呼ぶ（即座に返る fire-and-forget）。返信は
  引き続き `agvsr tell <job-id> "..."` で行う — herdr 経由の返信チャネルは v1 では作らない。
- 配送失敗（ペインが閉じている、herdr が落ちている等）は `src/herdr/client.ts` 内部で握りつぶし、
  デーモンの他の処理に影響しない。

## 非ゴール

- herdr 経由の返信チャネル。
- team.yaml/team.toml のスキーマ変更。
- 既存 CLI/Web/フックの撤去・非推奨化。
- 複数 herdr セッションをまたぐオーケストレーション（`HERDR_SESSION` の素通しのみ）。
- doctor からの herdr サーバーへの実通信（バイナリ存在確認 + env 確認のみ）。
