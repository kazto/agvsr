# 設計: 構造的ガードレール (D43–D46)

growllover Issue #153 のジョブ (`533fc8bb-0c79-4c59-b54c-31749cb789ed`) で
人間の介入なしには完了できなかった事象のうち、影響の大きい 4 件に対する恒久対策。

- 起票日: 2026-08-21
- 対象リビジョン: `9ba6522`
- 出典: growllover workspace からの報告(問題 1〜8。本文書は 1〜4 を扱う)

## 0. この文書が「ガードレール」と呼ぶもの

LLM は確率的に動くので、charter に書いたルールは**守られる確率を上げるだけ**であり、
再発可能性をゼロにしない。本文書では次を満たすものだけをガードレールと呼ぶ。

1. **デーモン側で執行する。** エージェントの協力を必要としない。charter への追記は
   補助であって保証ではない。charter だけで済ませる対策は本文書では採用しない。
2. **エージェントの自己申告を根拠にしない。** 「テストは全部通りました」という報告は
   検証の入力にしない。デーモン自身が観測した事実だけを根拠にする。
3. **fail-closed。** 判定できないときは黙って緑にせず、拒否かエラーにする。
   問題 1 が最悪だったのは、失敗が「静かな緑」として出力されたためである。

各対策は既存の commit gate (`src/git/commit-gate.ts`) や design-approval gate
(`src/daemon/daemon.ts:1712-1737`) と同じ形、すなわち
**デーモンが IPC ハンドラで拒否する構造的バックストップ**として実装する。

## 1. 調査で判明した事実(報告への補足と訂正)

設計に入る前に、報告と現コードの突き合わせ結果を記録する。

### 1.1 「環境変数を選んで渡す仕組み」は既に存在する

報告の「`.env` をそのままコピーするのは危険なので、環境変数を選んで渡す仕組みのほうが
安全」という指摘に対応する機構は、`b818e74` で既に入っている。

- `src/config/team.ts:88` — team レベルの `env`
- `src/config/team.ts:50` — role レベルの `env`
- `src/daemon/daemon.ts:1036-1057` — 両者を合成し、agvsr 自身の予約変数で上書き

つまり `DATABASE_TEST_URL` は今すぐ team.yaml の `env:` に書けば全ロールに渡る。
**足りないのは受け渡し機構ではなく、「設定漏れを検知する機構」である。**
設定していない状態でジョブを流すと、今も静かに 236 件がスキップされる。
D43 はここを塞ぐ。

### 1.2 `AGVSR_SEED_PATHS` にファイルを指定すると壊れる

`seedDependencies` (`src/git/deps.ts:149`) はディレクトリ専用ではなく、
`cp -a` 経由なのでファイルも通る。よって `AGVSR_SEED_PATHS=node_modules,.env` は
一見動く。しかしキャッシュの鮮度判定が**ロックファイルのフィンガープリント**
(`src/git/deps.ts:69-82`) なので、`.env` を書き換えてもロックファイルが変わらない限り
古い `.env` が配られ続ける。環境ファイルをこの経路に相乗りさせてはならない。
D43 では別経路を用意する。

### 1.3 worktree 自動回収で untracked が消えることはない(報告の懸念は不成立)

報告 4 の「untracked ファイルがあっても clean と判定されるなら危険」は、
現コードでは成立しない。

- `src/git/cleanup.ts:74` — `git status --porcelain=v1 --untracked-files=normal`
- 同 `:85` — 出力が空でなければ `dirty = true`
- 同 `:93-99` — dirty なら `NEEDS_REVIEW`、`SAFE_TO_REMOVE` にはならない
- `src/daemon/daemon.ts:829` — 自動回収は `SAFE_TO_REMOVE` のみを対象にする

したがって 587 行の設計文書が回収で消える経路はなかった。
**むしろこれが問題 8(NEEDS_REVIEW が 53 個溜まる)の直接の原因である。**
ロールがコミットせずに終わる → 永久に dirty → 永久に回収されない。
問題 4 と問題 8 は同一の対策 (D46) で同時に解ける。

### 1.4 重複委譲ガードは本文一致でしか効かない

`hasOutstandingIdenticalDelegation` (`src/daemon/daemon.ts:511-531`) は
`body.trim()` の完全一致で判定する。報告 2 の 11 秒後の「進捗確認です」は
最初の設計依頼と本文が違うので素通りした。D44 はここを本文非依存にする。

### 1.5 commit gate はジョブ完了時にしか効かない

`checkJobCommitGate` の呼び出しは 2 か所だけである。

- `src/daemon/daemon.ts:1909` — `job.complete`
- `src/daemon/daemon.ts:1954` — `job.mergeInstance`

ロールのターン終了時にも、ロール間のハンドオフ時にも効かない。よって
design の成果物が untracked のまま supervisor に引き渡され、以後 QA と
implementation がそれを読む、という状態が成立した。失敗したジョブは
`job.complete` に到達しないので、commit gate は一度も動かない。

## 2. D43 — 環境パリティ (問題 1)

### 2.1 何を不可能にするか

**「元チェックアウトでは実行されるテストが、job worktree では黙って実行されない」
という状態のままジョブが開始されること。**

### 2.2 機構 A: 環境パリティ検査(必須、`job.create` で fail-closed)

`job.create` の worktree 準備直後に、次を機械的に突き合わせる。

1. 元チェックアウトで git-ignore されているファイルのうち、環境ファイル
   パターンに一致するものを列挙する
   (既定: `.env`, `.env.*`, `.envrc`, `*.local.toml`, `*.local.json`, `.tool-versions`)。
2. 各ファイルについて、team.yaml に**明示的な処理宣言**があるかを確認する。
3. 宣言のないファイルが 1 つでもあれば `job.create` を失敗させる。

```yaml
worktree:
  env_files:
    .env: env          # 中身を KEY=VALUE として読み、role env に注入(ファイルは配らない)
    .env.test: copy    # ファイルとして worktree に配置する
    .env.production: ignore   # このジョブ種別には不要と人間が明示的に判断した
```

エラー文面は次の形で、解決手段を両方提示する。

```
job.create failed: unresolved environment files.

これらのファイルは元チェックアウトに存在し gitignore されていますが、
job worktree には存在しません。テストや設定が黙ってスキップされる可能性があります。
team.yaml の worktree.env_files で各ファイルの扱いを宣言してください。

  .env         → env | copy | ignore
  .env.local   → env | copy | ignore

  env    : 中身を環境変数として各ロールに渡す(推奨。ファイル自体は配らない)
  copy   : ファイルを worktree に配置する
  ignore : このリポジトリのジョブには不要

一時的に無効化するには AGVSR_ENV_PARITY=0
```

**設計上の要点**

- `env` を既定の推奨とする。報告にあった「`.env` をそのままコピーすると
  `VITE_MARKETPLACE_SOURCE=api` が無関係なテストを 1 件落とす」問題は、
  `env` 宣言時にキーを絞れるようにすることで解ける(`.env: [DATABASE_TEST_URL]`
  のようにキー配列も受ける)。
- 判定は `job.create` で行う。**エージェントが 1 つも起動する前**なので、
  エージェントには回避手段が存在しない。
- コストは 1 リポジトリあたり 1 回の宣言のみ。2 回目以降のジョブは無音で通る。
- `git check-ignore` は既に `src/git/worktree.ts:95` で使っているので追加依存はない。
- **エディタ/エージェントの設定ディレクトリは対象外にする**(実装時の追加判断)。
  `.claude/` `.codex/` `.agents/` `.agvsr/` `.cursor/` `.vscode/` `.idea/` 配下は
  ツール自身の設定であってアプリケーションの設定ではないため、検出しても
  `ignore:` の 1 行を全ユーザーに強いるだけで何も守らない。除外しないと
  agvsr リポジトリ自身が `.claude/settings.local.json` で引っかかる。
  リポジトリ直下のアプリ設定 (`config.local.json` など) は従来どおり検出する。
- 実装は `src/git/env-parity.ts` を新設し、`provisionWorktree` の後に呼ぶ。
  `src/git/deps.ts` には相乗りさせない(§1.2 のキャッシュ鮮度問題のため)。

### 2.3 機構 B: デーモン実行の検証ゲート(opt-in、強検証)

機構 A は「今回の原因」を塞ぐが、「テストが黙って除外される」一般形
(vitest の project 除外以外にも、`testPathIgnorePatterns` の変更、
CI 専用フラグ、tag フィルタなど)は塞がない。そこで完了時に
**デーモン自身がテストを実行し、実行数を基準値と比較する**層を用意する。

```yaml
verify:
  command: "bun run test:run"
  # 実行件数を取り出す正規表現。未指定なら vitest/jest/bun test の内蔵パターンを試す
  count_pattern: 'Tests\s+\d+ passed \((\d+)\)'
  baseline: source      # source | fixed:<n> | off
  tolerance: 0          # 基準を下回った件数の許容値
```

- **基準値の採取**: `job.create` 時に**元チェックアウトで**同じコマンドを実行して
  件数を採る。元チェックアウトには `.env` があるので、これが「本来の件数」になる。
  結果は `(repoRoot, HEAD, lockfingerprint)` でキャッシュし、
  `src/git/deps.ts` と同じ要領で再利用する。
- **判定**: `job.complete` の commit gate と同じ位置で、worktree に対して同じ
  コマンドを実行し、件数が `baseline - tolerance` を下回れば完了を拒否する。
- **エージェントの自己申告は一切使わない。** 「293 tests passed」という報告が
  本文にあってもデーモンは読まない。デーモンが自分で走らせた数だけが根拠になる。

**トレードオフ(明記して opt-in にする理由)**

- テストスイートを 1 ジョブにつき 2 回追加実行する。重いリポジトリでは無視できない。
- 元チェックアウトが人間の編集途中で dirty だと基準値がぶれる。
  その場合のために `baseline: fixed:530` を用意する。
- `count_pattern` はランナー依存で壊れやすい。パターンが 1 件も一致しなければ
  **fail-closed**(「検証不能」として完了を拒否)とする。静かに素通りさせない。

機構 A は必須、機構 B は opt-in。A だけでも今回の事故は起きない。

## 3. D44 — 委譲の待機 (問題 2)

### 3.1 何を不可能にするか

**「委譲先ロールが 1 ターンも実行していない時点で、supervisor が
『応答がない』を根拠に人間へエスカレーションすること。」**

### 3.2 機構 A: 委譲状態の事実注入(デーモン生成)

supervisor のターンを dispatch するとき、メッセージ本文の先頭に
デーモンが観測した客観的事実のブロックを付加する。エージェントが
書いた文字列ではなく、デーモンが `turnStartedAt` / `store` から組み立てる。

```
[agvsr delegation status]
  design          : dispatched 32s ago, 0 turns completed, in-flight: yes
  implementation  : not delegated
  qa              : not delegated
```

これで supervisor は「応答がない」と「まだ動き始めていない」を混同できなくなる。
ただしこれは**モデルが読むことに依存する**ので、単独ではガードレールではない。
次の機構 B が保証を担う。

### 3.3 機構 B: 未応答委譲先への再送を拒否

`msg.send` で `from === SUPERVISOR` かつ宛先が worker ロールのとき、次を検査する。

- その宛先への直近の委譲が未応答であり、かつ
- その宛先が委譲以降に 1 ターンも完了していない

この条件が成立する間は**本文に関わらず拒否**する。

```
error: delegate_not_started
design has not completed its first turn yet (delegated 11s ago).
Sending it another message now cannot change anything.
Use agvsr_wait to park the job until it reports back.
```

既存の `hasOutstandingIdenticalDelegation` (`daemon.ts:511`) を置き換えず拡張する。
現行は本文一致のみを見るので、「進捗確認です」のような**別文言の催促**を通してしまう
(§1.4)。新ガードは本文を見ないので、言い換えでは回避できない。

なお、委譲先が 1 ターンでも完了した後は再送を許可する。これは
「QA の指摘を implementation に送る」のような正当な往復を妨げないためである。

### 3.4 機構 C: 起動待ちを理由とするエスカレーションの拒否

`msg.escalate` および `msg.send(to="user")` を、次の条件が**すべて**成立する間だけ拒否する。

- ジョブに未応答の委譲が 1 つ以上ある
- そのすべてが `min_delegation_wait_ms`(既定 300_000 = 5 分)より新しい
- どのワーカーロールもこのジョブでまだ 1 ターンも完了していない

```
error: delegation_still_starting
No worker has completed a turn yet, and every outstanding delegation is
younger than 5m (design: 30s). Escalating now would ask the human to fix
something that has not had a chance to happen.
Use agvsr_wait, or escalate again after the window.
```

**この条件を厳しくしている理由**: 「ジョブがまだ一度もワーカー出力を生んでいない」
状態に限定すれば、正当なエスカレーション(目標の曖昧さの確認など)を長期に
妨げない。最大でも 5 分の遅延で、窓が明ければ自動的に通る。
また charter は既に「明確化は委譲前に済ませる」と規定している
(`charters/defaults/supervisor.md:19-22`) ので、この窓に当たる正当な用件は少ない。

設定値は `team.yaml` の `supervisor.min_delegation_wait_ms` と
環境変数 `AGVSR_MIN_DELEGATION_WAIT_MS` で上書き可能にする。

**採用しなかった案**: エスカレーションを受理した上で人間への配送だけ遅延させる
(hold-and-release)方式。情報を失わない利点があるが、「委譲先が動き出したので
保留中のエスカレーションを破棄してよいか」の判定が曖昧になる。既存の D-gate が
`approval_required` で拒否する形を取っているので、拒否で揃える。

## 4. D45 — 承認済み決定の凍結 (問題 3)

### 4.1 何を不可能にするか

**「人間が承認した決定項目が、差し戻しの往復で黙って元に戻り、
それが supervisor のレビューを通過すること。」**

### 4.2 前提: 決定に安定 ID を持たせる

報告にある通り、今回の設計文書は既に `D-1` `D-4` `D-5`、QA は `Q-2` という
**安定した項目 ID** を使っていた。これを機構の足場にする。

design → supervisor のハンドオフを受けたとき、デーモンは `refs` の各ファイルを読み、
`^\s*[-*#]*\s*(D-\d+)` に一致する行を決定項目の見出しとして抽出する。
1 件も抽出できないハンドオフは拒否する。

```
error: design_decisions_unparseable
The design handed off cites docs/design_x.md but no decision entries were
found. Each decision must start with a stable id, e.g. "D-1: access TTL は
24h 据え置き". Ids are what freezes an approved decision against later drift.
```

**ID 必須化は設計文書の書式に対する制約**であり、そこはコストとして認める。
これがないと「どの決定が凍結されているか」を機械的に表現できない。

### 4.3 機構: 決定台帳と範囲外変更の拒否

新テーブル `design_decisions(job_id, decision_id, content_hash, approved_at)` を
`src/daemon/store.ts` に追加する。

1. **承認時**: 人間の `approve` 判定 (`approvalVerdict`, `daemon.ts:539`) が出た時点で、
   承認対象の `refs` から抽出した全決定項目の
   `(decision_id, その項目本文の SHA-256)` を台帳に記録する。
   既存の `design_approved_refs` (`protocol.ts:37`) の粒度をファイルから
   項目へ細かくしたものにあたる。
2. **差し戻し時**: 人間の `reject` 判定、または supervisor の design 宛て
   再委譲メッセージから、対象となる決定 ID を抽出する
   (`D-1`, `D-4` のような言及をそのまま拾う)。これを**改訂スコープ**として記録する。
   スコープが空の差し戻しは拒否する:

   ```
   error: rework_scope_required
   A rework instruction must name the decision ids to change (e.g. "D-1, D-4, D-5
   を修正。他は現状維持")。全文の再作成を指示すると、承認済みの決定が確率的に
   巻き戻ります。
   ```

3. **再提出時**: 次の design → supervisor ハンドオフで決定項目を再抽出し、台帳と比較する。
   **改訂スコープ外の決定項目のハッシュが変化していたら、ハンドオフを拒否する。**

   ```
   error: approved_decision_reverted
   これらの決定は承認済みで、今回の改訂スコープ (D-1, D-4, D-5) に含まれません。
   承認時の内容に戻してから再提出してください。

     D-2  access TTL          承認時: 24h 据え置き / 今回: 1h
     D-7  トークン形式         承認時: 変更しない   / 今回: familyId 埋め込み

   改訂スコープを広げる必要がある場合は、人間に再承認を求めてください。
   ```

これで**巻き戻りは supervisor のレビュー能力に依存しなくなる**。
報告にある通り supervisor の検知自体は 3 回とも正確だったので、
検知能力ではなく「収束させる仕組み」が欠けていた。本機構は
巻き戻った再提出をそもそも受理しないので、3 ラウンドの往復自体が発生しない。

### 4.4 補助機構: 凍結リストの自動添付と差分レビュー

- supervisor → design の再委譲メッセージに、デーモンが**凍結中の決定一覧**を
  自動で追記する。supervisor が書き忘れても design には必ず届く。
- supervisor へのハンドオフ通知に、承認時スナップショットとの**差分**を添付する。
  587 行の全文を毎回読み直させるのをやめ、変わった箇所だけをレビュー対象にする。
  これは §4.3 の拒否をすり抜けた場合(スコープ内の変更)のレビュー品質を上げる。

## 5. D46 — 成果物のコミット (問題 4 / 問題 8)

### 5.1 何を不可能にするか

- **「ロールの成果物が、コミットされないまま次のロールへ引き渡されること。」**
- **「ジョブが終了したあと、回収できない未コミット作業が worktree に残り続けること。」**

### 5.2 機構 A: refs のコミット済み検査(ハンドオフ時)

worker → supervisor の `msg.send` が `refs` を伴うとき、デーモンは各 ref パスを
そのロールの実効 worktree で検査する。

- 追跡されていない (`git ls-files --error-unmatch` が失敗) → 拒否
- 追跡されているが変更がある (`git diff HEAD -- <path>` が非空) → 拒否

```
error: refs_uncommitted
Referenced artifacts are not committed on the job branch. A worktree can be
reclaimed at any time; only committed work survives.

  docs/design_issue153_refresh_token_rotation.md   untracked

Commit them on <branch>, then hand off again.
```

**この機構が今回の事象に正確に当たる理由**: design は設計文書のパスを `refs` に載せて
supervisor に引き渡した。その瞬間に検査が走り、untracked なので拒否される。
design は自分でコミットして再送する。人間の介入は発生しない。

あわせて、design → supervisor のハンドオフに `refs` を必須化する。
現状 refs のないハンドオフは D-gate を再発火させる副作用的な扱いになっている
(`daemon.ts:577`)。これを明示的な拒否に変え、`refs` を必ず伴わせる。

### 5.3 機構 B: ターン終端チェックポイント

各ロールのターン終了時、そのロールの実効 worktree が dirty なら、デーモンが
**作業ツリーの状態を専用 ref に退避**する。ジョブブランチには触れない。

**`git stash create` は使えない(実装時に判明)。** `git stash create` は
**追跡済みの変更しか拾わない**。本機構が守るべき対象そのもの — `git add` されて
いない設計文書 — を取りこぼす。実測でも untracked な `design.md` は空の結果に
なった。代わりに使い捨て index 経由でツリーを組む:

```
GIT_INDEX_FILE=<tmp> git read-tree HEAD
GIT_INDEX_FILE=<tmp> git add -A          # untracked も含む。ignored は除外
GIT_INDEX_FILE=<tmp> git write-tree      # → tree
git commit-tree <tree> -p HEAD -m ...    # → commit(どのブランチにも乗らない)
git update-ref refs/agvsr/checkpoints/<job>/<role>/<n> <commit>
```

作業ツリーと実 index には一切触れない(エージェントが意図して stage した内容を
壊さない)。`--force` を付けないので `node_modules` 等の ignored は入らない。
linked worktree で作った `refs/agvsr/...` は ref ストアが共有されるため、
worktree 削除後も main 側から参照できる(実測確認済み)。

- エージェントの協力もトークン消費も不要。デーモンが git を叩くだけ。
- ジョブブランチの履歴を汚さない。エージェントの中途状態がコミットとして混ざらない。
- `job_checkpoints(job_id, role, turn, ref, file_count, created_at)` に記録し、
  `agvsr status` から参照できるようにする。
- 「未コミットのまま消える」経路が原理的に消滅する。

### 5.4 機構 C: チェックポイント済み worktree を回収可能にする

`src/git/cleanup.ts:93-99` の分類を拡張する。dirty な worktree であっても、
**現在の作業ツリー状態が最新チェックポイントと一致している**なら
`SAFE_TO_REMOVE` に分類してよい。内容は ref として残るので何も失われない。

これが問題 8(55 個中 53 個が NEEDS_REVIEW)の直接の解になる。
機構 B と組み合わせると、未コミットを理由に回収不能になる worktree が
新規には発生しなくなる。

なお `growllover-96--implementation-1` のように **main より 89 コミット先行**する
worktree は別問題(未マージ)であり、`SAFE_TO_REMOVE` にはならない。
これは正しい挙動なので変更しない。

**適用経路は主に失敗ジョブである(実装時に判明)。** dirty な worktree のまま
`job.complete` を呼んでも既存の commit gate が `commit_required` で止めるので、
「dirty のまま完了して回収される」経路は存在しない。チェックポイントは
commit gate を迂回させるものではない(その性質をテストで固定した)。実際に
worktree が滞留したのは `job.complete` に到達しない**失敗ジョブ**であり、
機構 C が効くのはそこである。報告の 53 個も失敗ジョブ由来と一致する。

### 5.5 既存 commit gate との関係

`checkJobCommitGate` は `job.complete` 時の**最終**バックストップとして残す。
D46 の機構 A/B は、そこに到達する前(ハンドオフ時・ターン終端)に効く前段であり、
置き換えではない。失敗したジョブは `job.complete` に到達しないので、
前段がないと commit gate は一度も動かない(§1.5)。

## 6. 実装順序

依存関係と、費用対効果の順に並べる。

| 順 | 項目 | 規模 | 依存 | 効果 |
|---|---|---|---|---|
| 1 | D43 機構 A(環境パリティ検査) | 小 | なし | 静かな緑を止める。最優先 |
| 2 | D46 機構 A(refs コミット済み検査) | 小 | なし | 成果物消失と worktree 滞留の元を断つ |
| 3 | D44 機構 B/C(再送・早期エスカレーション拒否) | 小 | なし | 人間の往復を削る |
| 4 | D46 機構 B/C(チェックポイント + 回収) | 中 | 2 | 既存 53 worktree の解消経路 |
| 5 | D45(決定台帳) | 中 | なし | 設計往復の収束 |
| 6 | D44 機構 A(事実注入) | 小 | なし | 補助 |
| 7 | D43 機構 B(検証ゲート) | 大 | 1 | 一般形の静かな緑を塞ぐ |

1〜3 はいずれも既存の IPC ハンドラに検査を 1 つ足すだけで、
`src/daemon/daemon.ts` の `msg.send` / `job.create` に閉じる。
先にここまでを入れれば、今回の事象のうち問題 1・2・4・8 は再発しない。

## 7. 共通の設計方針

- **無効化スイッチを必ず用意する。** 既存の `AGVSR_DESIGN_GATE` /
  `AGVSR_COMMIT_GATE` / `AGVSR_AUTO_RECLAIM` に倣い、各ガードに
  `AGVSR_ENV_PARITY` / `AGVSR_REFS_GATE` / `AGVSR_DELEGATION_GUARD` /
  `AGVSR_DECISION_LEDGER` を設ける。既定は有効、`0|off|false|no` で無効。
- **拒否メッセージは次の行動を書く。** エラーコードだけを返すと、エージェントは
  推測で別の手を打つ。「`agvsr_wait` を使え」「`refs` をコミットして再送しろ」まで
  文面に含める。既存の D-gate の文面 (`daemon.ts:1723-1728`) が良い先例。
- **charter は補助として更新する。** ガードレールが拒否したときに何をすべきかを
  charter にも書いておくと、拒否 1 回で正しい行動に移れる。ただし
  charter への記述は保証としては数えない。
- **テストは拒否経路を主対象にする。** 「正しい入力が通ること」ではなく
  「壊れた入力が確実に拒否されること」を `test/ipc.test.ts` に足す。

## 8. 本文書が扱わない項目

報告のうち 5〜8 は別途扱う。

- **問題 5**(codex の設定破損が診断不能): `agvsr doctor` に実起動チェックを足し、
  ターン失敗診断で stderr が空なら stdout を採る。`src/doctor.ts` と
  `turnFailureDiagnostics` (`daemon.ts:421`) の変更。独立して実施可能。
- **問題 6**(利用上限エスカレーションの重複): 同一ロール・同一原因の集約と、
  生存アダプタの併記。`usageLimitEscalation` (`daemon.ts:390`) 周辺。
- **問題 7**(`agvsr job` の前景ブロック): job id を即時出力して返す。
  `src/cli/agvsr.ts`。
- **問題 8**(worktree 滞留): 新規発生分は D46 で止まる。既存 53 個の処理は
  `agvsr cleanup` の運用課題として別途。
