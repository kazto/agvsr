# agvsr (AGents superViSoR)

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

