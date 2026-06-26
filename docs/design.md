# agvsr 設計ドキュメント

> AGents superViSoR — AIエージェント・オーケストレーター
> TypeScript + Bun 製。Windows/macOS/Linux 一級対応。
>
> grilling（設計インタビュー）で確定した事項を、決定の理由とともに記録する生きた文書。
>
> 構成: §0 背景 / §1 アーキテクチャ決定（D1–D28）/ §2 charter 設計（CH1–CH8）/
> §3 実機検証の結果 / §4 既知のリスク・将来拡張 / §5 実装計画。

## 0. 背景・モチベーション

- 既存の `agmsg`（bash + sqlite3 の cross-agent メッセージング）から着想。
- ただし agmsg は Mac/Linux 実用・**Windows はベストエフォート**で、Bash 依存ゆえ Windows 信頼性が低い。
- agvsr は **Windows を一級市民**とし、より広範な**オーケストレーション**（役割割当・モデル設定・監督・暴走停止）を TS+Bun で**新規に**作る。
- agmsg のアイデアは借りるが、転送基盤ごと別物として作り直す（概念のみ継承）。

---

## 1. アーキテクチャ決定（D1–D28）

### D1: 実行モデル = 再開起動（resume-invoke）統一モデル（Q1 → Phase0-1 で改訂）
当初は常駐プロセス型を選んだが、Phase 0 スパイク（§3）で claude-code の CLI が常駐多ターンを持たないと判明（Agent SDK 専用）。代わりに3種すべてが `resume <id>` で会話継続できると実証 → **全アダプタを単一の resume-invoke モデルに統一**。
- ターンごとに `<cli> ... resume <session_id> <message>` を1発起動 → 構造化イベント（tool_use 含む）を吸う → プロセス終了。
- アイドル時はプロセスゼロ・session_id だけ（メモリ占有なし）。会話文脈は各CLIのセッション継続で保たれる（D12 の狙いを満たす。物理的常駐は手段にすぎず不要だった）。
- 代償のターン起動コストは LLM レイテンシに比べ無視可（claude は `--bare` で軽量化）。Agent SDK による claude 常駐ウォーム化は将来の最適化余地（§4）。

### D2: 駆動インターフェース = stream-json I/O（Q2）
TUI を PTY/画面パースで叩くのではなく、各CLIのプログラム駆動モード（stream-json）で構造化 I/O を行う。
- **理由**: 画面パースは脆い。stream-json なら構造化応答が得られ、ループ検知も容易。
- **tmux は不採用**: Unix専用で Windows ネイティブに無く、3OS・低依存方針に反する。tmux の利点（生セッションへの human attach）は必須要件ではないと確認（D3）。

### D3: human の生セッション介入は非必須（Q2.5）
人間がセッションにアタッチして操作を引き取る要件は無い。ただし**観測は必要**（未熟なAIの無限ループ等を検知・停止したい）。stream-json なら観測・停止は素直に実現できる。

### D4: 暴走監視の責務分離（Q3）
- **機械的健全性**（タイムアウト/ループ/予算/kill）= agvsr ランタイムの**決定論的ウォッチドッグ**。
- **意味的判断**（成果物の良し悪し、役割再割当）= **AI監督**。
- **暴走検知そのものは必ず決定論側に置く**。AIにAIの無限ループ検知を任せない（監督自身がハングしうるため）。

### D5: agmsg との関係 = 完全新規（概念のみ継承）（Q4）
転送層ごと TS+Bun で作り直す。`~/.config/agvsr/inbox.sqlite`（agmsg の DB とは別）。

### D6: 中央デーモン型（Q5）
`agvsrd` 的な常駐親プロセスが全エージェント子プロセスを抱え、stdin/stdout を所有し、メッセージをルーティングし、ウォッチドッグを回す。CLI（`agvsr ...`）はデーモンに指示を送る薄いクライアント。
- **理由**: 役割の割当・強制停止・横断ルーティング・一元観測は「全体を見る単一の親」がいると桁違いに素直。agmsg の "no daemon" は転送限定の美徳で、オーケストレーションを足すなら手放す。

### D7: メッセージの送受信モデル（Q6 → Phase0-1 で改訂）
- **送信 = MCP ツール傍受**: 各エージェントに `agvsr_send(to, body, refs?)` 等を与え、1起動内の `tool_use` をデーモンが構造化取得・ルーティング。
- **受信／起動 = 再開起動の spawn**: デーモンが対象エージェントを `resume <session_id>` で起動し、配送メッセージを prompt として渡す（旧「stdin 注入で常駐を起こす」を置換）。**MCP では相手を起動できない**（MCP は受け身プロトコル）ことに変わりはなく、起動はあくまでデーモンによる resume-invoke。
- **非同期 fire-and-forget**: `agvsr_send` は即「受け付けた」と返し、返信は別ターン=別の resume 起動として届く。
- 実行ループ: `A の起動内で agvsr_send(to=B)` → デーモンが傍受・宛先解決・キュー → B が手すきなら `B を resume 起動`（メッセージを prompt に）→ B 処理・イベント→終了 → 再びアイドル。

### D8: 単一アダプタ抽象（resume-invoke 統一）（Q8 → Phase0-1 で改訂）
能力マップ（§3 実機検証）:

| エージェント | 再開起動 | 構造化イベント | MCP |
|---|---|---|---|
| claude-code | `claude -p --resume <id> <msg>` | `--output-format stream-json`（JSONL） ✓ | client ✓ |
| codex | `codex exec resume <id> <msg> --json` | `--json`（JSONL） ✓ | client ✓ / 自身も MCP server 可 |
| agy (Antigravity) | `agy -p --conversation <id> <msg>` | print のみ・構造化なし（MCP で補完） | `mcp_config.json` で登録 |

- **gemini CLI は obsolete**。Google は Antigravity CLI `agy` への移行を案内 → agvsr の対象は **claude-code / codex / agy** の3つ。
- デーモンの統一インターフェース: `adapter.deliver(agentId, message) → イベントストリーム`。**全3種が同一の resume-invoke 実装**: `resume <session_id>` 起動 → イベント吸い上げ → 終了、アイドル=session_id のみ（プロセス/メモリ0）。
- claude/codex は JSONL の構造化イベントで `tool_use` を直接抽出。agy は構造化stdout が無いが、ツール呼び出しは MCP shim（D19）で捕捉するため送受信は成立（観測の細粒度のみ劣る = D28）。
- **codex は安定版 `exec resume --json` に寄せる**（experimental な app-server/exec-server は使わない）。
- 当初の「ライブ/再開の2モデル」は不要だった（Phase 0 で claude も再開駆動可能と判明）。Agent SDK による claude 常駐ウォーム化は将来の最適化余地（§4）。

### D9: 役割 = 宣言的チーム設定（Q9）
`team.yaml` 等に役割を宣言。各役割 = `{ 名前, adapter(CLI種別), model, charter(責務/system prompt), instances }`。
```yaml
roles:
  supervisor:     { adapter: claude-code, model: claude-opus-4-8, charter: "..." }
  design:         { adapter: claude-code, model: claude-sonnet-4-6 }
  implementation: { adapter: codex,       model: ... }
  qa:             { adapter: agy,          model: ... }
```
- **宛先は役割名で指定**（`send(to="design")`）、デーモンが実体に解決。
- v1 は **1役割1実体・静的宣言**。監督による動的 spawn/割当は将来拡張（権限を絞り観測性を優先）。

### D10: メッセージング・トポロジ = スター型 + デーモン強制（Q10）
- **supervisor がハブ**。ワーカー（design/implementation/qa）は**supervisor としか通信しない**。supervisor が順序を差配。
- **デーモンが許可辺を強制**: 各役割に配る `agvsr_send` ツールの有効宛先を、`team.yaml` の辺宣言から生成。ワーカーの送信先候補は supervisor のみ。スキーマ/バリデーションで逸脱を弾く（憲章プロンプトだけに頼らない）。
- メッシュ化は将来、辺を足して対応。

### D11: ジョブを軽量な第一級実体にする（Q11）
- 人間がゴールを投入 → デーモンが Job レコード `{id, goal, status, created_at}` を起票。
- 状態は `running / done / failed` 程度の最小ステートマシン。
- **完了は supervisor が `agvsr_complete(job_id, result)`、失敗は `agvsr_fail(job_id, reason)` を明示宣言** → デーモンが状態更新し結果を人間に浮上（CLI 出力/通知）。
- 理由: 観測性・ウォッチドッグ・結果返却経路は「ジョブ状態」という形があって初めて成立。

### D12: エージェント・ライフサイクル = 常設の枠 + ジョブ単位で会話リセット（Q12）
- 役割の「枠」と（ライブ型の）プロセスはデーモン生存中ずっと常駐（ウォームな即応性・観測の安定）。
- **会話スレッドはジョブ単位で新規化**（claude-code=新セッション、codex/agy=新 conversation id）、前ジョブはアーカイブ。
- **ジョブの境界 = supervisor の受け入れ承認**。「コーディング依頼→完了報告→レビューで不具合→修正依頼→…」の内部ループは**全て同一ジョブ**で、その間**会話文脈は維持**（実装は自分のコードを覚えたまま修正を受ける）。supervisor が `agvsr_complete` で承認した瞬間にリセット。
- 留意: 1ジョブ内の修正ループが極端に長引けば文脈は伸びる（想定内、必要なら別途コンパクション）。

### D13: 永続化（sqlite）= 単一書き手の耐久キュー兼監査台帳（Q7）
- 転送バスでもポーリング対象でもない。ルーティングはメモリ/イベント駆動。
- sqlite には「受付時に1行 INSERT・配信時に read_at を打つ」だけ。**書き手はデーモン1つ（single writer）** → agmsg の複数プロセス同時書き込み問題（Windows 信頼性低下の元凶）が消える。
- 役割: (a) Audit/観測、(b) クラッシュ耐性、(c) ビジー相手へのメッセージ待ち行列の durability。
- スキーマ（D24 と整合）: `messages(id, job_id, from_agent, to_agent, kind, body, refs, created_at, read_at)`、`jobs(id, goal, status, cwd, branch, created_at, updated_at)`。

### D14: ウォッチドッグの検知信号と発動ラダー = 二段（Q13）
**検知信号（決定論的・ランタイム側）**:
- 絶対上限: 1ターン/ジョブのウォール時計タイムアウト、ジョブ総トークン・コスト予算、ジョブ内最大反復回数。
- ループ兆候: 同一ツールを同一引数で N 回連続、出力ほぼ同一の反復、2役割間の状態変化なきピンポン、ファイル変更を伴う `tool_use` ゼロのまま N ターン経過（無進捗）、短時間に許可拒否 N 回（D22b）。

**発動 = 二段ラダー**:
- **Tier1（ソフト）**: ループ・無進捗の**兆候** → ウォッチドッグが**supervisor に通知**、supervisor が意味的に判断（再割当・サブタスク中止・指示変更）。
- **Tier2（ハード）**: **絶対上限超過**、または **Tier1 後も未解消**、または **supervisor 自身が無応答** → ウォッチドッグが**問答無用で kill**（ライブ=SIGKILL、再開=再起動停止）、ジョブを failed、人間に通知。
- **絶対上限だけは supervisor を飛び越え無条件強制**（supervisor 自身がループしうるため）。

### D15: 人間との接点 = 離散コマンド + supervisor への途中 steering（Q14）
人間は**スター中心の supervisor と話せる特別な `user` ノード**として座る。
- **投入**: `agvsr job "ゴール文"` → Job 起票 → supervisor へ。
- **観測**: `agvsr status`（ジョブ/エージェント状態一覧）、`agvsr logs -f <job>`（監査台帳をストリーム追尾、stdout 流すだけで3OS素直）。
- **介入（言葉）**: `agvsr tell supervisor "やっぱり X を優先して"` → 実行中ジョブの supervisor に人間メッセージを stdin 注入（D7 の仕組みを再利用）。
- **介入（強制）**: `agvsr stop <job>` / `agvsr kill <agent>`。
- リッチ TUI/Web 盤面は将来拡張（v1 は離散コマンド + `logs -f` で足りる）。

### D16: モデル設定 = 生文字列・team.yaml が正・オーバーライド無し（Q15）
- **各CLI生のモデル文字列**を `team.yaml` の役割ごとに記載（`{adapter: claude-code, model: claude-opus-4-8}`）。横断論理エイリアスは作らない（異種ベンダに真の等価性が無く保守地獄になるため）。
- 起動時に各アダプタの利用可能モデルと突き合わせて**検証**（不明なら起動失敗）。
- **モデル選択は人間の責任**。`team.yaml` の記載を正とし、**ジョブ単位オーバーライドも supervisor の実行時切替も持たない**（どのジョブがどのモデルで動いたかが監査台帳に確定的に残る）。

### D17: クラッシュ時フェイルセーフ + 設定スナップショット（Q16）
- **クラッシュ復旧 = フェイルセーフ**。デーモン再起動時・エージェント死亡時、実行中ジョブは `interrupted`/`failed` にマークし人間に通知。**自動レジュームしない**。人間が状況を見て再投入を判断。
  - 理由: 「人間の責任・観測性・予測可能性・未熟AIに権限を渡さない」方針（D9/D14/D16）と一致。半端な状態の自動再開は暴走の温床。
  - sqlite の durability は「証跡・配信途中メッセージを失わない」ため。「勝手に再開する」ためではない。
  - 自動レジューム（特に復旧可能な再開型）は将来拡張。
- **設定リロード**: `team.yaml` 変更は再起動 or 明示 `agvsr reload` で反映。**実行中ジョブは起動時スナップショットを維持**（走行中の役割定義変更による混乱を防ぐ）。

### D18: クライアント↔デーモン IPC = ローカル専用（Q17）
- **ローカル専用 IPC**（ネットワークを介さない）。TCP localhost は不採用（ポート開放・ファイアウォール・他プロセス到達を避ける。agmsg の "no network" を保つ）。
- 実装: POSIX（mac/Linux）= Unix ドメインソケット、Windows = 名前付きパイプ、の薄い抽象（Bun `node:net` で両対応・§3）。ソケットのファイル権限でユーザ本人に接続元を限定。
- 将来 Bun の Windows AF_UNIX 対応が確認できたら **UDS 1本に簡約**。

### D19: MCP 提供 = stdio shim → ローカル IPC でデーモン中継（Q18）
- エージェントにツールを持たせるには MCP（モデルがツールの存在を知る必要があり「傍受」では不可）。論点はトランスポート。
- **各エージェントが `agvsr-mcp`（Bun製の極薄 shim）を stdio MCP サーバとして起動**し、shim がツール呼び出しを D18 のローカル IPC でデーモンへ中継。**ポートを一切開かない**（D18 と整合）。stdio は全 MCP クライアント共通で互換性最大。デーモンが状態の単一源のまま。
- HTTP/SSE 形態は不採用（TCP ポート再導入で D18 に逆行）。
- **配るツール（初期）**: `agvsr_send(to, body, refs?)`（宛先候補は D10 の許可辺でフィルタ）／ `agvsr_escalate(reason)`（D22）／ `agvsr_complete(job_id, result)`・`agvsr_fail(job_id, reason)`（supervisor のみ）／（将来）`agvsr_status` 等の読み取り系。
- agy も `~/.gemini/antigravity/mcp_config.json` で shim 登録可（§3 で検証済み）。

### D20: ワークスペース = ジョブ単位で単一作業ディレクトリを全役割共有（Q19）
- ジョブ投入時に対象を指定（`agvsr job "..." --cwd /path/to/repo`）。デーモンが各アダプタに渡す（claude-code/agy=`--add-dir`、codex=cwd）。
- design→implementation→qa は**1つのリポジトリ状態**を順に触る（1ジョブ=1つの一貫した成果物、D12 と整合）。
- スター型（D10）の逐次受け渡し・1役割1実体（D9）なので同一ツリーの同時殴り合いは基本生じない。
- 将来、複数ワーカー並列を入れる段階で git worktree 分離へ拡張。

### D21: 権限ゲート = ccgate（LLM許可判定）+ 多層（Q20, Q21）
- ヘッドレス常駐では対話的許可プロンプトに答えられない。権限判定は **ccgate**（github.com/tak848/ccgate）を採用。
  - ccgate = 許可要求ごとに `tool_input`＋文脈を高速・安価な LLM に渡し、自然言語の allow/deny ルールで allow/deny/fallthrough を判定。設定は jsonnet（`~/.claude/`・`~/.codex/`）。
- **fallthrough_strategy = `deny`**（無人運転の安全側。迷ったら拒否）。人間へのエスカレーションは将来（ccgate の `ask` は対話TUI前提のため agvsr 仲介の実装が要る）。
- **多層防御**: ccgate（空間×危険度の AI ゲート）＋ OS サンドボックス（空間の決定論ゲート、ワークスペース閉じ込め D20）＋ ウォッチドッグ（時間/ループの決定論ゲート D14）＋ 監査台帳（D13）。ccgate は AI 判定で決定論的保証ではないため単独の安全層にしない。
- **ccgate は claude-code / codex のみ対応**（§3 検証）。agy は非対応 → D28。
- 留意: ccgate は許可要求ごとに外部 LLM API を叩く（D18 の "no network" とは別軸でレイテンシ・コスト・ネットワーク依存が乗る）。

### D22: 拒否を正規エスカレーションに変換（Q22）
bare `deny` は「拒否→抜け穴あがき→再拒否」のトークン浪費（＝ループ兆候）を誘発する。拒否を行き止まりにせず正規のエスカレーションへ変換する:
- **(a) 指示的 deny_message ＋ 憲章ルール**: 「拒否されたら抜け穴を試さず、supervisor へ `agvsr_escalate(reason)` / `agvsr_send` でエスカレーションせよ」を明記。あがきの代わりに手を上げるのを正規行動にする。
- **(b) ウォッチドッグ新シグナル**: 「短時間に拒否 N 回」「ほぼ同一の被ブロックコマンド反復」を D14 の無進捗シグナルに追加 → Tier1 supervisor 通知、未解消なら Tier2 kill。トークン浪費を決定論的に頭打ち。
- **(c) supervisor→人間裁定**: supervisor が「本来許可すべき」と判断すれば D15 の steering 経路で人間に上げ裁定。「正当だが拒否された」案件に本物の解決経路を与え、あがきの動機自体を消す。

### D23: ワークフロー駆動 = 創発（憲章駆動）・ガードレール内（Q23）
- agvsr はワークフローを固定ステートマシンに機械化しない。supervisor が charter（責務・利用可能な役割・期待）に基づき、実行時に段取り（design→implementation→qa→反復→承認）を**意味的に判断**する。
- 理由: D4 の責務分離（意味的判断は supervisor、機械的健全性はランタイム）。順序決定は意味的判断なので機械化しない。
- 野放しではなく**決定論ガードレールの中**で創発: スター型トポロジ（D10）／ウォッチドッグ（D14）／明示的完了宣言（D11）が外枠を固定。「外枠は機械が固定、中の段取りは supervisor が創発」。
- 条件: charter に期待する規律を明記（CH8）。フェーズ順の強制が必要になればオプションの workflow policy 層を後付け。

### D24: メッセージ形式 = 自由文 body ＋ ツール由来 kind ＋ 任意 refs（Q24）
- 本文（`body`）は**自由文**（LLM が書く実体）。
- **種別（kind）は「どのツールで送ったか」で確定**: `agvsr_send`=message、`agvsr_escalate`=escalation、`agvsr_complete`=completion、`agvsr_fail`=failure。本文に種別を埋めさせない（ツールの同一性が型を符号化）。
- 任意で `refs`（変更ファイルパス等の参照リスト）。D20 のワークスペース共有での受け渡しと監査（D13）が締まる。
- デーモンのレコード: `{id, job_id, from, to, kind, body, refs?, created_at, read_at}`。
- 「型はツールが、内容は自由文が、参照は refs が」担う役割分担。本文へのスキーマ強制（未熟AIが壊す）も完全自由文（機械が読めない）も避ける。

### D25: charter = 3層モデル（agvsr の本体・育成対象）（Q25）
**charter こそが agvsr の本体であり、その育成がプログラムの目的。** 3層構造:
1. **agvsr プロトコル・スキャフォールド**（機械規律: ツール使用 / スター型トポロジ D10 / 拒否エスカレーション D22 / 完了宣言 D11・D23）。**常に注入・ユーザ不変**（層2を置換しても機械規律は壊れない）。
2. **開発者が用意した既定 role charter**（supervisor/design/implementation/qa のドメイン憲章）。agvsr 同梱（`charters/defaults/*.md`）、**カスタマイズなしで動く**。育てていく中核資産。
3. **ユーザカスタマイズ（任意）**。
- カスタマイズ機構（team.yaml の役割ごと）:
  - 無指定 → 既定 charter をそのまま（out-of-the-box）。
  - `charter_append: ...` → 既定の上に追記（最も一般的）。
  - `charter: ...` → まるごと置換（フルコントロール）。
- charter は別 md ファイル参照が基本（短いものはインライン文字列可）。
- アダプタが「合成済み charter → 各CLIのシステムプロンプト機構」へマッピング（claude=`--append-system-prompt`/設定、codex=instructions/AGENTS.md、agy=独自）。

### D26: 人間への通知 = プル型 ＋ 設定可能イベントフック（Q26）
- **プル型**: イベントは監査台帳（D13）に積まれ、`agvsr status`（要対応のジョブ/エスカレーション）・`agvsr logs -f`（ストリーム）で人間が見る。
- **設定可能イベントフック**: 注目イベント時に**ユーザ設定のコマンドをイベント JSON 付きで実行**。実際の通知手段（notify-send / osascript / Slack webhook / PowerShell トースト等）はユーザが配線。agvsr に通知連携を内蔵しない（低依存・3OS、agmsg のフック思想）。
- 発火する注目イベント: ジョブ完了/失敗、Tier2 kill（D14）、人間裁定が要るエスカレーション（D22c）。

### D27: 並行モデル = v1 は逐次（規律ベース）、並列は将来拡張（Q27）
- **v1 は逐次**: デーモンは直列化スケジューラを作らない。supervisor の charter に「共有ワークスペース上では1度に1ワーカーへ受け渡せ」と規律づける（機械ロックなし）。役割が異なれば同時編集は稀で、charter 規律＋ウォッチドッグ（D14）＋監査（D13）でカバー。
- **並列は明示的な将来拡張**: 複数ワーカー同時走行＋ worktree 隔離（D20 の将来拡張）＋ charter 規律の緩和で開ける。規律ベースなので「ロックを外す」手間なく拡張できる。

### D28: agy アダプタの安全姿勢（実機検証由来 §3）
agy は ccgate 非対応・構造化stdout欠如のため、claude/codex より厳しめの決定論ガードで運用する:
- 権限ゲートは ccgate ではなく **agy native `--sandbox` ＋ ワークスペース閉じ込め（D20）**。team.yaml で agy 役割は既定で厳しめサンドボックス（read-only 寄り）を推奨。
- 観測は **ターン単位（resume-invoke の1起動ごと）のウォール時計タイムアウト ＋ MCPチャネルでのツール呼び出し反復観測（D19 shim）＋ 監査（D13）** で代替。内部ツールの細粒度ループ検知は claude/codex に劣ることを許容。
- → 安全姿勢はアダプタごとに非対称（claude/codex=ccgate+sandbox+watchdog、agy=sandbox+watchdog のみ）。これを team 設計時の前提とする。

---

## 2. charter 設計（agvsr の本体・育成対象 — D25）

実装物: `charters/scaffold.md`（層①）＋ `charters/defaults/{supervisor,design,implementation,qa}.md`（層②）。
役割憲章は一貫テンプレート（Mission / What you own / Boundaries / How you work / Definition of done）。

### CH1: 既定 charter の言語 = 英語（最終成果物）
- 最終成果物は**英語**。理由: (1) AI（claude/codex/agy）との相性、(2) ユーザは日本人に限らない国際的対象。
- 開発中は日本語で下書きすることもありうるが、ship される既定 charter は英語に統一。

### CH2: 役割境界 = 中庸に鋭い（Q charter-2）
各役割に明確な主担当を与え、受け渡し点を明示しつつ、自レーン内の常識的自己チェックは許す:
- **supervisor**: オーケストレーション専任。**自分でコードを書かない**。ジョブ分解・委譲・成果レビュー・反復判断・受け入れ完了宣言（D11）。単一ハブ（D10）。
- **design**: 要件から設計方針・インターフェース・計画を生成。**実装しない**。
- **implementation**: 設計に沿って実装。**着手前後の軽い自己チェック（build/lint/その場の単体）はやる**（能力であって QA ではない）。
- **qa**: レビュー・テストし**欠陥を発見・報告。自分で直さない**。欠陥は supervisor へ返し、supervisor が修正を implementation へ回す。
- 死守する独立性の線: **「qa=発見役 / implementation=修正役」の分離**（実装の自己認証を許さない）と **supervisor=ハンズオフ**。

### CH3: 役割の正式識別子 = `supervisor` / `design` / `implementation` / `qa`
- 原語（監督/設計/実装/品質保障）と 1:1、最短・最明瞭。team.yaml のキー兼アドレス（D9）。

### CH4: 人間（`user`）は supervisor の第一級アドレス先（双方向 steering）
- supervisor は `agvsr_send(to="user", ...)` で人間に確認・中間報告でき、人間の steering は supervisor への入力ターンとして届く（D15 の双方向化）。
- 2つの上り経路の粒度差: `agvsr_escalate` = ブロッカー/拒否/裁定要求、`agvsr_send(to="user")` = 通常の確認・相談。
- `user` は supervisor の allowed_targets にのみ含める。worker からは不可（スター維持 D10）。

### CH5: バージョン管理 = implementation がジョブ用ブランチで実装＋コミット
- implementation はジョブ用ブランチで作業し論理単位でコミット、ハンドオフ時にコミット/diff を `refs` で渡す。
- qa はそのコミットを検証。supervisor は完了時にマージ方針を判断するが、**最終マージ（不可逆）は人間に委ねる**（D15/安全方針）。
- **保護ブランチ（main/master/release/* 等）への直接コミット/マージはエージェント禁止**（ccgate/サンドボックスで強制、agy は native sandbox）。エージェントはジョブ用ブランチに閉じ込める。
- 利点: コミット履歴で QA が明確な単位を検証でき、フェイルセーフ（D17）でも成果が git に保全（sqlite durability と二重の安全網）。

### CH6: qa は2フェーズ（テスト計画作成 ＋ 検証）
- **Phase 1（設計→テスト計画）**: qa は設計を受け、要件・設計から**テスト計画**（テスト対象・ケース・エッジ/失敗ケース・受け入れ基準）を作成。**人間レビュー可能なドキュメント**としてワークスペースに残し（`docs/` 等）、ジョブ用ブランチにコミット、パスを `refs` で supervisor へ。この計画が後の検証の合否基準。
- **Phase 2（実装の検証）**: 実装を「テスト計画＋設計＋ゴール」に照らして検証、欠陥を計画に紐づけて報告。
- CH2 の独立性（qa=発見役・修正せず）は維持。supervisor が「設計ができたら qa にテスト計画を作らせてから実装受け入れ」を差配。
- **テスト計画の人間レビュー = 任意レビュー**（必須ゲートにしない）。計画は常にコミット済みドキュメントとして残り人間はいつでも読める。supervisor は `agvsr_send(to="user")` で提示できるが、**人間の承認を待たず実装へ進む**。人間は steering（D15）で介入可能。将来 team.yaml で設定可能化の余地。

### CH7: テスト所有権 = impl=床 / qa=天井 / design=種別ごとのE2Eの形を定義
- **implementation（床=必要条件）**: ユニットテスト ＋ **正常系E2Eが実際に走るテスト**を必ず作成・コミット。design が定めたE2Eの形（エントリポイント・成功条件）に従う。「end-to-end で動く証明」=能力であって品質の自己認証ではない。
- **qa（天井=ゲート=十分条件）**: テスト計画（CH6）でエッジ/異常系/否定ケース/E2Eシナリオを定義し、独立に検証。implementation のユニット＋E2Eを走らせた上で、計画のエッジ/異常系を自分でも確認・追加。**impl のテストが通っても必要条件にすぎず、qa の独立判定がゲート**。
- **design**: 「このアーティファクトでE2Eが動くとは何か」を設計成果に明記（CLI=コマンド実行＋出力検証、Web=サーバ起動＋エンドポイント/Playwright、ライブラリ=公開API呼び出し…）。種別差をここで吸収し、charter 本文は種別非依存に保つ（環境に Playwright スキルあり）。
- CH2 の独立性（発見と修正の分離・自己認証禁止）と完全両立。

### CH8: supervisor = ゴール追求ループ（`/goal` 的）＋自己統治
- supervisor は claude-code の `/goal` のように「ゴール達成まで開発→検査→反復」を**自律的に粘る持続ループ**。1パスで終わらせない（D11/D12/D23 の明示化）。
- **自己統治**: 非収束の兆候（同種欠陥の再発・QA/実装の堂々巡り・進捗頭打ち・ジョブ上限接近）を自分で検知したら、黙って予算を燃やさず **人間へ相談（`agvsr_send(to="user")`）or 根拠付き `agvsr_fail`**。
- 決定論ウォッチドッグ（D14）は AI 自己統治が効かなかった時の**最終 backstop**（D14 二段ラダー: Tier1=意味的=supervisor/人間、Tier2=機械的）。
- D22 の「あがいて浪費しない」哲学をオーケストレーション層にも適用。

### スキャフォールド（層①）の placeholder
`charters/scaffold.md` の `{{...}}` をデーモンが spawn 時に充填:
- `{{role}}` / `{{job_id}}` / `{{cwd}}`。
- `{{completion_tools}}`: supervisor のみ（complete/fail の説明）。worker は空。
- `{{allowed_targets}}`: worker=`supervisor`、supervisor=`design, implementation, qa, user`。

---

## 3. 実機検証の結果（2026-06-25 実施）

能力マップ（実機 `--help`・設定ファイル・ccgate リポジトリで確認）:

| | 構造化stdout | MCP（agvsrツール） | 継続/再開 | ccgate | native sandbox |
|---|---|---|---|---|---|
| claude-code (2.1.187) | ✓ stream-json | ✓ | ライブ（stdin 注入） | ✓ | claude sandbox/FS |
| codex (0.139.0) | ✓ `exec --json` JSONL | ✓ `codex mcp` | ✓ `exec resume <id> <prompt> --json` | ✓ | ✓ `-s read-only/workspace-write/danger-full-access` |
| agy (Antigravity 0.47.0) | ✗ print テキストのみ | ✓ `~/.gemini/antigravity/mcp_config.json`（stdio mcpServers） | `--conversation <id>` / `--continue` | ✗ 非対応 | ✓ `--sandbox` |

確定した含意:
- **codex 再開アダプタは完全成立**: `codex exec resume <SESSION_ID> <PROMPT> --json`（UUID/スレッド名で再開、JSONL でイベント=tool_use 抽出可）。
- **agy は MCP 送信可能** → 「受信専用降格」回避。`mcp_config.json` で `agvsr-mcp` shim を stdio 登録でき、`agvsr_send/escalate/complete` を MCP 経由で呼べる（デーモンは D19 の shim 側で捕捉、agy の stdout 構造化に依存しない）。
- **agy の2つの劣化**（→ D28 で対処）: ①構造化stdout欠如で内部ツールの細粒度ストリーム観測不可、②ccgate 非対応（claude/codex のみ、schemas も2つ）。
- **Bun 1.3.13 は `node:net`（名前付きパイプ/UDS）を持つ** → D18 の IPC 抽象は API 上実現可能。

### Phase 0 スパイク結果（2026-06-26）
- **S1（claude ライブ駆動）= 想定外**: `claude -p --input-format stream-json` は**単発実行**で、最初の `result` 後に stdout を閉じる。「1プロセスを生かして stdin に複数ターン注入」は **CLI では不可**（Agent SDK 専用機能）。公式 headless ドキュメントも、多ターンは `--continue`/`--resume <session_id>`（別プロセスで継続）と明記。
- **S1b（claude 再開駆動）= PASS**: `claude -p --resume <session_id> "<msg>" --output-format json` で会話継続を実証（別プロセスのターン2が、ターン1だけで述べた事実を想起。session_id も維持）。**claude も codex/agy と同一の resume-invoke モデルで駆動可能** → D8 の2モデルを単一モデルに統一できる（下記 D1/D7/D8 改訂、要ユーザ確認）。

- **S2（codex 再開）= PASS**: `codex exec --json` のイベントは `thread.started`(`thread_id`=session id) → `turn.started` → `item.completed`(`item:{type:"agent_message", text}` / ツールは `item.type` 別) → `turn.completed`(`usage`)。`codex exec resume <thread_id> --json --skip-git-repo-check "<msg>"` で記憶継続を実証。**注意: resume は `--sandbox` 不可**（`-c sandbox_mode=...` か config で渡す）。`spikes/s2-codex.ts`。
- **S2（agy 再開）= PASS（条件付き）**: `agy --continue -p "<msg>"` で会話継続を実証（recall PASS）。ただし: ①agy は**自前 conversation id を受け付けず** UUID を自動生成、`~/.gemini/antigravity-cli/conversations/<uuid>.db`（per-conversation SQLite）に保存 → agvsr は**spawn 後に新規 db を検出して id を捕捉**する必要。②`--conversation <id>`（明示id）は一度ハング（コールド起動の遅さ/不安定）→ 実装時にタイムアウト/リトライで要堅牢化。③構造化出力なし（D28 のまま）。→ **claude/codex が堅い一級、agy は best-effort**。

- **S3（MCP 傍受 end-to-end）= PASS**: claude が `agvsr_send(to,body)` を呼び、**MCP stdio shim → ローカル UDS（`Bun.listen` unix）→ スタブデーモン**まで到達（`node:net` UDS クライアントで中継）。エージェントの stdout 形式に依存せずツール呼び出しを捕捉できることを実証（D18/D19）。`spikes/s3-mcp/`・`spikes/s3-run.ts`。
  - 注意: claude の `--bare` は OAuth 認証をスキップ（`ANTHROPIC_API_KEY`/`apiKeyHelper` 必須）→ OAuth ログイン運用では `--bare` を使わない。MCP ツールは `--allowedTools "mcp__<server>__<tool>"` で事前承認。

### Phase 0 まとめ
S1–S3 完了（Linux 実機）。**設計の中核前提はすべて検証 or 改訂済み**: 単一 resume-invoke モデル（3種）／MCP shim→ローカルIPC→デーモン傍受／Bun `node:net` IPC／各CLIのイベント形状。残る **S4（Windows 名前付きパイプ実挙動）は実 Windows 必須**で未実施。

### 実装フェーズで潰す残検証
- S4: Bun の Windows 名前付きパイプ実挙動（D18、実 Windows 必須）。
- agy `--conversation <id>` のハング原因・堅牢化（タイムアウト/リトライ、id 捕捉の確実性）。
- 各アダプタのツール呼び出しイベント（claude: stream-json の `tool_use` / codex: `item.completed` の tool item）を実タスクで確定。

---

## 4. 既知のリスク・将来拡張

### 既知のリスク
- **agy の安全姿勢の非対称**（D28）: ccgate 無し・細粒度観測不可。agy 役割は厳しめ sandbox 前提で設計する。
- **ccgate の外部API依存**: 許可要求ごとにレイテンシ・コスト・ネットワーク（D21）。多ツール呼び出し時の影響を計測する。
- **Windows IPC 実挙動**（D18）: 名前付きパイプは実 Windows でのみ確証できる。

### 将来拡張（v1 では作らない）
- 動的役割 spawn/割当（supervisor 権限拡大）（D9）。
- メッシュ・トポロジ（辺追加）（D10）。
- 並列ワーカー＋ worktree 隔離（D20/D27）。
- クラッシュ自動レジューム（特に再開型）（D17）。
- リッチ TUI/Web 盤面（D15）。
- テスト計画の必須ゲート化（team.yaml 設定）（CH6）。
- ccgate `ask` の agvsr 仲介（人間への許可エスカレーション）（D21）。

---

## 5. 実装計画

方針: **薄い縦割り（walking skeleton）を先に通し、安全層・観測・残アダプタを後から積む**。各フェーズは §1/§2 の決定に紐づく。

### Phase 0 — スパイク（不確実性の除去）
§3 で残った未検証点を、最小コードで先に潰す。
- **S1 ライブ駆動 = 棄却 / S1b 再開駆動 = PASS（完了）**: claude 常駐多ターンは CLI 不可と判明。`claude -p --resume <id>` で会話継続を実証 → 単一 resume-invoke モデルへ統一（D1/D7/D8 改訂、§3）。`spikes/s1-live-claude.ts`・`spikes/s1b-claude-resume.ts`。
- **S2 再開・アダプタ（codex/agy）**: `codex exec resume <id> <prompt> --json` と `agy -p --conversation <id>` の1往復で、再開継続とイベント/出力形状を確定（D8、§3）。
- **S3 MCP shim + IPC**: 極薄 `agvsr-mcp`（stdio）→ ローカル IPC（UDS）→ スタブデーモン、を claude/codex/agy で登録し、`agvsr_send` 1発が傍受される経路を実証（D18/D19）。agy は `mcp_config.json` 経由。
- **S4 Windows IPC**（実 Windows）: 名前付きパイプで client↔daemon 疎通（D18）。

### Phase 1 — デーモン骨格 ✅ 実装済み（bun test 緑・E2E スモーク済み）
- デーモン本体 ＋ ローカル IPC サーバ（POSIX=UDS / Windows=名前付きパイプ抽象、D18） — `src/ipc/transport.ts`（`node:net` 1コードパス）、`src/daemon/daemon.ts`。
- 薄い CLI クライアント `agvsr`（D6/D15） — `src/cli/agvsr.ts`（`ping`/`job`/`status`/`team`/`daemon`）。
- sqlite ストア（single writer）: `jobs` / `messages`（D13/D24） — `src/daemon/store.ts`（bun:sqlite, WAL）。
- `team.yaml` ローダ＋検証（役割・adapter・model、D9/D16） — `src/config/team.ts`（zod, star 許可辺の導出 D10）。model 文字列の実在検証は Phase 2（アダプタ依存）。
- テスト: `test/{store,team,ipc}.test.ts`（11 pass）。`tsconfig.json` で `tsc --noEmit` クリーン。

### Phase 2 — アダプタ層
- アダプタ I/F `deliver(agentId, message) → event stream`（D8、単一 resume-invoke 実装）。
- CLI 別の差分（resume コマンド・イベント形状・モデルフラグ・システムプロンプト注入）だけを薄く吸収する claude/codex/agy ドライバ。
- charter 合成: scaffold＋role charter＋placeholder → 各CLIのシステムプロンプト機構（D25）。
- MCP shim 配線（各アダプタ、D19）。

### Phase 3 — オーケストレーション・ランタイム
- メッセージ・ルータ＋スター型許可辺の強制（D10）。
- ジョブ・ライフサイクル: create/running/done/failed、`agvsr_complete/fail`（D11）。
- ジョブ単位の会話ライフサイクル（spawn/reset/archive、D12）。
- ツール・ハンドラ: `agvsr_send/escalate/complete/fail`（D7/D22/D24）。
- → ここで **MVP 縦割り**到達: 「`agvsr job` → supervisor が implementation に send → 実装が commit → supervisor が complete → 人間に結果」。

### Phase 4 — 安全層
- 決定論ウォッチドッグ: 検知信号＋二段ラダー（D14、D22b シグナル）。
- ccgate 統合（claude/codex 設定注入・fallthrough=deny）＋ agy native sandbox（D21/D28）。
- ワークスペース閉じ込め＋ git ジョブブランチ強制・保護ブランチ禁止（D20/CH5）。

### Phase 5 — 人間接点・観測
- `agvsr job/status/logs -f/tell/stop/kill`（D15）。
- 通知イベントフック（D26）。監査台帳の表示。

### Phase 6 — クラッシュ処理・3OS 仕上げ
- フェイルセーフ（interrupted マーク）＋設定リロード（D17）。
- 3OS パッケージング・実 Windows 検証。

### Phase 7 — charter 育成（継続・本来の目的）
- 実ジョブで既定 charter を反復改良（D25）。

### テスト戦略
- **アダプタのモック**: `deliver` I/F を満たす偽アダプタで、ランタイム（ルータ/ジョブ/ウォッチドッグ）を決定論的に単体テスト。
- **E2E**: トイ・リポジトリに対し claude-code 実バックエンドで 1 ジョブを完走（MVP 縦割りを回帰テスト化）。
