# agvsr: デーモンの停止と endpoint 所有権

`docs/design.md` の D1〜D28、`design-herdr-integration.md` の D29〜D31、
`design-cost-visibility.md` の D32 に続く決定。

## 背景: 観測されたゾンビ

「プロセスは生きているのにソケットファイルが存在しない agvsrd」が発生していた。
`agvsr status` は "daemon is not running" を返す一方、`pgrep` にはプロセスが残り、
`ss -lx` にも listen が現れない。原因は独立した3つの欠陥の連鎖だった。

1. **`serve()` が生きているソケットを unlink していた。** 「前回の実行が残した stale な
   ソケットを消す」意図だったが、生死を確認していなかった。新デーモンが起動すると旧デーモンが
   listen 中のパスを削除して自分のものを bind し、旧デーモンは**パスを失った listener を
   握ったまま生き続ける**。後に新しい方が終了するとパスごと消え、観測された状態になる。
2. **`close()` が `server.close()` より先に進行中ターンを待っていた。** ターンのハード
   タイムアウト既定値は1時間。ターンが1本走っているだけで endpoint が最大1時間 bind
   されたままになり、その間に1が起きる窓が開く。
3. **IPC 経由の `daemon.stop` にプロセス終了がなかった。** `process.exit` は SIGINT/SIGTERM
   ハンドラにしか無く、停止パスはイベントループの自然な枯渇に依存していた。

## D33: endpoint は生きている限り奪わない

`serve()` は unlink の前に endpoint へ接続を試みる。

- **接続できた、または接続がタイムアウトした → live**。`EndpointInUseError` を投げて起動を中止する。
  タイムアウトを live 側に倒すのは意図的で、判断がつかない場合に稼働中デーモンの endpoint を
  失わせないため。
- **明確に接続拒否された → stale**。この場合だけ unlink して bind する(クラッシュ後の復帰)。

`agvsr daemon` はこの例外をスタックトレースではなく1行のメッセージで報告して exit 1 する。
これは異常終了ではなく通常の運用結果であるため。

副作用として `agvsr daemon restart` が旧デーモンと競合しうるので、CLI は `daemon.stop` の後に
`waitForEndpointFree()` で endpoint の解放を確認してから新デーモンを spawn する。解放されない
場合は**新デーモンを起動せずエラーにする** — 黙って2つ目を起動して片方を壊すよりよい。

## D34: 停止は「受付を止めてから、有限時間だけ待つ」

`close()` の順序を入れ替え、ドレインに予算を設ける。

```
server.close()                                  ← 先に受付を止める
drainPending(pending, drainMs)                  ← 既定 10s (AGVSR_SHUTDOWN_DRAIN_MS)
  超過したら in-flight の AbortController を abort
  drainPending(pending, ABORT_GRACE_MS)         ← 2s の猶予
store.close()
```

- 予算超過時に abort するのは、**アダプタのサブプロセスを孤児にしないため**。`runTurn` は
  AbortSignal でサブプロセスを kill するので、abort せずに exit すると `claude -p` 等が
  親を失って残る。
- `Promise.allSettled` は Set を呼び出し時に一度だけ反復する。ドレイン中に enqueue された
  ディスパッチは意図的にこのドレインの対象外とする(無限に待たないため)。
- ドレインのタイマーは必ず clear する。負けた側の `setTimeout` が残るとイベントループを
  参照し続け、「停止したのに終了しないプロセス」を自分で作ることになる。

## D35: 停止応答は close より前に flush する

`daemon.stop` は「停止を開始した」旨を返してから閉じるが、この応答は**まさに閉じようとしている
ソケット**に書かれる。2点を守る必要がある。

- トランスポートの `close()` はクライアントソケットを `destroy()` ではなく `end()` する。
  `destroy()` はキュー済みの書き込みを破棄するため、応答が消えてクライアントが永久に待つ。
  猶予(500ms)を過ぎても閉じないソケットのみ強制切断する。
- ハンドラ内の close は**マクロタスク**で予約する。トランスポートは `await handler(...)` の
  継続(マイクロタスク)で応答を書くため、マイクロタスクで閉じるとソケットが先に end され、
  応答は送られない。

停止完了後、`exitOnStop` が有効なら `process.exit(0)` する。このオプションを持つのは
`agvsr daemon` プロセスだけで、埋め込み利用とテストは既定の false のまま(テストは `exit` を
注入して検証する)。

## 非ゴール

- 停止時に進行中ジョブを再開可能な形で保存すること。既存の D17 fail-safe(起動時に stale な
  running ジョブを interrupted にする)をそのまま使う。
- `daemon.stop` を「完全に閉じてから応答する」同期 API にすること。応答が遅れるとクライアントの
  タイムアウト設計に影響するため、v1 は「応答は即時、CLI 側で解放を確認」の分担を維持する。
- 複数 endpoint / 複数デーモンの同時稼働のサポート。
