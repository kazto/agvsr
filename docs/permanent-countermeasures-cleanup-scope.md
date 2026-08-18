# 恒久対策: `agvsr cleanup --apply` の誤爆スコープ問題

対象: growllover 開発者からのインシデント報告。`agvsr cleanup --apply --job growllover-95`
（`--job` は当時未実装のフラグ）が `ERR_PARSE_ARGS_UNKNOWN_OPTION` で exit 1 即終了し、
シェルの `||` フォールバックが `agvsr cleanup --apply`（フィルタなし）を実行、
無関係な job `growllover-97` のworktree（未マージ実装コミットを含む
`growllover-97--implementation-1` 等）まで削除された。実際の内容は
job base ブランチ（`agvsr/growllover-97`）へ既にmerge済みだったため物理的な喪失はなく、
削除されたブランチ参照もGC未実行で `git branch <name> <sha>` で復旧できたが、再現性のある
危険な経路だった。

## 根本原因（3つ）

1. `agvsr cleanup` に単一jobへのスコープ限定手段がない。フィルタなしの `--apply` は
   常に**全job横断**で安全判定・削除を行う。
2. 未知フラグが Node の生例外 (`ERR_PARSE_ARGS_UNKNOWN_OPTION`) としてキャッチされずに
   exit 1 で落ちる。他の一般的な失敗と exit code が区別できず、シェルスクリプト側の
   `||` フォールバックが「意図した処理の失敗 → 広範な代替処理」という危険な連鎖を誘発しうる。
3. `SAFE_TO_REMOVE` 判定基準がローカル `main` 参照ベース固定で、ローカル `main` が
   `origin/main` から乖離していると誤判定（今回は安全側=過剰にNEEDS_REVIEW、
   理論上は逆方向の誤判定もありうる）しうる。基準を変える手段がなかった。

（`assessWorktree` 自体のD27ロジック — instanceブランチをjob baseブランチ基準で判定する仕様 —
は設計通りで、job base ブランチが同時に削除対象へ入ることはない。これは既存テスト
`test/cli-wait-cleanup.test.ts`「classifies an instance worktree against its owning
job's branch, not main (D27)」で担保済み。今回のインシデントで実害が出なかったのはこの
設計のおかげであり、根本原因は上記1〜3。）

## 実装した対策

### 対策① `--job <id>` によるスコープ限定（根本原因1）

`src/cli/agvsr.ts` の `cleanup` ケースに `--job <id>` を追加。指定時は対象jobの
「job自身のworktree」＋「そのjobのinstance worktree（`job.roleWorktrees`）」だけに
レポート・削除の対象を絞り込む。存在しない job id を渡すとエラー
（`no such job: <id>`, exit 2）で即座に止まり、暗黙にフィルタなし実行へフォールバックしない。

### 対策② 未スコープ `--apply` の明示的ガード（根本原因1, 2）

`--apply` は **`--job <id>` または `--all` のどちらかを明示しないと拒否**するよう変更
（`refusing to run --apply without a scope`, exit 2）。これにより、①のフラグ名を
打ち間違えた場合でも「フィルタなしの破壊的操作が黙って走る」経路自体が構造的に塞がれる
（`--job` が仮に将来も存在しなかったとしても、`--apply` 単体では常に拒否される）。

副次的に、`parseArgs` が投げる `ERR_PARSE_ARGS_*` 系の生例外を `main()` 呼び出し側で
キャッチし、`agvsr --help` へ誘導する短いメッセージ＋ exit code 2 に変換した
（`src/cli/agvsr.ts` 末尾）。cleanupに限らず全コマンドの未知フラグ・不正な値がこの経路を通る。
exit code 2 は既存の「usageエラー」規約（例: リポジトリ外での実行）と揃えてあり、
一般的な失敗(exit 1)と機械的に区別できる。

### 対策③ `--base-ref` によるマージ判定基準の上書き（根本原因3）

`--base-ref <ref>`（デフォルト `main`、ローカル参照）を追加。ローカル `main` が
`origin/main` から乖離している疑いがある場合、`git fetch` 後に
`agvsr cleanup --base-ref origin/main` で判定し直せる。デフォルトは変更していない
（`origin` remote が存在しないリポジトリでも安全に動く必要があるため）。`--help` に
「ローカル参照である」旨を明記した。

## テスト

`test/cli-wait-cleanup.test.ts` に追加/更新:

- 既存の「フィルタなし `--apply`」系テストは全て `--all` を明示する形に更新
  （変更後の挙動に合わせた仕様変更であり、regressionではない）。
- D27 instanceテストの `--apply` 呼び出しを `--job <id>` に変更し、スコープ機能を
  実運用シナリオ内でも検証。
- 新規: `--apply` 単体（`--job`/`--all` なし）が exit 2 で拒否され、何も削除しないこと。
- 新規: 2job存在する状態で `--job <jobA>` がjob Aのworktreeのみをレポート・削除し、
  job Bのworktreeに触れないこと。
- 新規: 存在しない `--job` idがexit 2で止まり、何も削除しないこと（暗黙フォールバック無し）。

`bun test`: 506テスト中505 pass、1 fail (`test/package.test.ts` のタイムアウト、
本変更と無関係・変更前から再現することを `git stash` で確認済み)。

## リスクと非対応事項

- `--base-ref` はCLIの `agvsr cleanup` のみに追加した。daemonの自動reclaim
  （`src/daemon/daemon.ts` の `reclaimWorktrees`, D42）は元々1job単位のスコープに
  限定されており今回のインシデントの経路に該当しないため、`baseRef="main"`固定のまま
  据え置いた。同じローカル参照の乖離リスクは理論上残るが、影響範囲が1jobに閉じるため
  優先度を下げた。
- シェル側の `||` フォールバック自体（呼び出し元の運用パターン）はagvsrの責務外であり
  変更していない。対策②により「フィルタなし破壊的操作が拒否される」ことで、
  この種のフォールバック連鎖が起きても実害に至らないことを担保する方針とした。
