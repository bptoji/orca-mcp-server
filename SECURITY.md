# セキュリティポリシー

## 脆弱性の報告

脆弱性と思われるものを見つけたら、**公開の Issue / PR には書かず**、次のどちらかで非公開に知らせてください。

1. GitHub の [Private vulnerability reporting](https://github.com/bptoji/orca-mcp-server/security/advisories/new)(推奨)
2. メール: bptoji@mac.com

再現手順・影響範囲・使っている orca-mcp / Orca CLI / Node.js のバージョンを添えてもらえると助かります。
個人で保守しているプロジェクトなので返信までに時間がかかることがありますが、受け取ったものはすべて確認します。

## 対象

- このリポジトリのコード(`src/` / `scripts/`)
- 特に重視するもの: 子プロセス起動の command injection(`src/orca/command.ts`)、
  HTTP トランスポートの Host / Origin / Bearer 検証(`src/server/`)

Orca 本体や各エージェント(Codex / Claude Code など)の脆弱性は、それぞれのプロジェクトへ報告してください。

## 運用上の注意

- HTTP トランスポートをループバック以外で公開するときは必ずトークンを設定してください
  (トークン無しでは起動を拒否します)。直接 bind より `ssh -L` / TLS プロキシ / VPN の内側での利用を推奨します。
- この MCP サーバーに接続できるクライアントは、Orca 上でエージェントを起動し、ゲートの承認や ask への回答ができます。
  信頼できるクライアントだけを接続してください。
