# agvsr: supervisor の空振りターンの扱い

`docs/design.md` の D1〜D28、`design-herdr-integration.md` の D29〜D31、
`design-cost-visibility.md` の D32、`design-daemon-shutdown.md` の D33〜D35 に続く決定。

## 背景: 「待機ターン即死」

supervisor が人間へエスカレーションした直後、まだ返答が来ていない状態で別のターンが届く
(worker からの報告など)。supervisor が「既に報告済みで、今は待つのが正解」と正しく判断して
ターンを終えると、デーモンがジョブ全体を hard-fail していた:

```
supervisor turn ended with assistant text but no agvsr tool call was recorded;
the text was saved to the audit log, but no work was routed and the job cannot progress.
```

実際の運用で 6 ジョブ以上が、実装作業に何の問題も無いまま失敗し、その都度人間がジョブを
立て直して `git merge` で成果を回収する必要があった。

原因は 3 つ重なっていた。

1. **判定が実装と食い違っていた。** 条件は `routedByRole` ——「このターン中に
   `from_role = supervisor` のメッセージが作られたか」であり、tool call の有無ではない。
   エラー文言が誤診を誘発していた。
2. **「待機」を表明する手段が存在しなかった。** `agvsr_send` / `agvsr_escalate` /
   `agvsr_complete` / `agvsr_fail` はいずれもメッセージを作るが、待機の表明には使えない
   (同じ質問の再送や、既にブロックされている worker への ping になる)。唯一自然な
   `agvsr_status` は read-only でメッセージを作らないため、呼んでも救済されなかった。
   一方 `charters/scaffold.md` は「**毎ターン必ず agvsr tool call で終えること**」を要求し、
   `supervisor.md` は「承認を待て」と指示していた —— charter 同士が矛盾していた。
3. **supervisor だけが hard-fail だった。** 同じ「テキストのみ・ルーティング無し」に対し、
   worker には supervisor へエスカレーションして再ディスパッチするソフトな回復パスが
   用意されている。supervisor だけがジョブ即死という非対称。

## D36: 空振りターンは「待機中か否か」で区別し、失敗は最終手段にする

`dispatchRole` の判定を 3 段階にする。

1. **人間への未回答の問いがある → 何もしない。**
   `isAwaitingUserReply(jobId)` が監査ログを走査し、`supervisor → user` の最後のメッセージが
   `from_role = user` の最後のメッセージより新しいかを見る。真なら、supervisor には
   ルーティングすべきものが無いのでターンが空振りで終わるのは正常。ジョブは running のまま。
   人間が永久に答えない場合は既存の stall watchdog が検出・通知する。
2. **未回答の問いが無い → まず注意を促す。**
   連続空振り回数を数え、`MAX_SUPERVISOR_IDLE_TURNS`(3)未満なら
   `daemon → supervisor` のエスカレーションを作って再ディスパッチする。文面には
   「`agvsr_status` は read-only でルーティングにならない」ことを明記する。
   supervisor が何かをルーティングした時点でカウンタはリセットされる。
3. **それでも空振りが続く → 従来どおり失敗させる。**
   この場合は作業を再開させる契機が永遠に来ないため、ジョブを進める術が無い。
   文言は実装に合わせて「N 回連続でメッセージをルーティングしなかった」と正確に述べる。

### charter 側の整合

- `charters/scaffold.md` の「毎ターン tool call」ルールに、supervisor 限定の例外を1つ明記した。
  同時に「ルールを満たすためだけにメッセージを捏造するな」「`agvsr_status` はルーティングに
  ならない」と釘を刺す。
- `supervisor.md` / `supervisor.ja.md` に「**待つことは正当な行動である**」を追加し、
  デーモンがこの状態を認識すること、および未回答の問いが無い状態での空振りは注意 →
  失敗につながることを説明した。

### 新しいツールを足さなかった理由

`agvsr_wait` のような no-op ツールを追加すれば `routedByRole` を満たせるが、
**デーモンが状態を推論できるものをモデルの規律に依存させることになる**。待機中かどうかは
監査ログから決定的に分かるので、そちらで判定する。ツール表面積も増えない。

## D37: シャットダウン開始後は新規ディスパッチを受け付けない

D34 のドレインは「開始時点で存在するディスパッチ」だけを待つ。ところが結果処理の複数箇所が
後続ターンを enqueue する(worker のソフトパス、D36 の nudge)。ドレインのスナップショット後に
積まれたディスパッチは待たれないまま `store.close()` を追い越し、
`RangeError: Cannot use a closed database` を切り離された promise から投げていた。

`close()` の先頭で `closing` フラグを立て、`enqueueDispatch` はそれ以降 no-op とする。
呼び出し箇所ごとにガードを置くのではなく enqueue の一点に集約する —— 後続ターンを積む経路は
今後も増えうるため。

## 非ゴール

- 待機中の supervisor に一切ターンを渡さないこと。待っている間に届く worker の報告には
  重要なものがありうるので、ターン自体は渡し、空振りで終えることを許す設計にする。
- 人間への問い合わせに期限を設けること(タイムアウトで自動失敗させるなど)。既存の
  stall watchdog による通知に委ねる。
- `MAX_SUPERVISOR_IDLE_TURNS` の設定可能化。まず固定値で運用し、必要が出てから検討する。
