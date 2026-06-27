# agvsr (AGents superViSoR)

## Getting started

```sh
# 1. Generate a team.yaml (4 standard roles, all claude-code)
agvsr init

# 2. Start the daemon
agvsr daemon start

# 3. Submit a job
agvsr job "add a health endpoint"
```

See `agvsr init --help` for options (`--adapter`, `--model`, `--role`, `--stdout`, etc.).

`agvsr` とは、ClaudeCode / Codex / Gemini / Antigravity など複数のAIエージェントに役割を割り当て、相互に指示をやり取りしあうSkill、スクリプト群です。

いわゆるAIオーケストレーターと言われるもののひとつです。

# 依存関係

すべてのスクリプトはTypeScriptで記述しており、唯一 Bun に依存しています。

# 役割

- 監督
- 設計
- 実装
- 品質保障

# メッセージ

`~/.config/agvsr/inbox.sqlite` を介してメッセージをやりとりします。

# npm 配布

`agvsr` は npm パッケージとして配布できますが、実行時には Bun が必要です。

- インストール: `npm install agvsr`
- 直接起動: `bunx agvsr --help`
- ローカルインストール後に起動: `npm exec agvsr -- --help`
- Bun のランタイム要件: `agvsr` は Bun 上で動作します。Node-only 環境では実行できません。

公開用に tarball を作るときは、`npm pack --dry-run --json` で `src/`, `charters/`, `examples/`, `README.md` が入ることを確認します。
