# コントリビューション

Issue・PR を歓迎します。個人で保守しているので、大きな変更は先に Issue で相談してもらえると助かります。

## 開発の始め方

```bash
npm install
npm run typecheck
npm test          # orca ランタイム不要
npm run build
```

Node.js 22 以上を使ってください(テストの vitest が 22.12 以上を要求します。ビルド済みのサーバーは 20 以上で動きます)。

## PR を出す前に

- `npm run typecheck` と `npm test` が通ること(CI でも同じものを回します)
- 開発規約は [AGENTS.md](./AGENTS.md) にまとまっています。特に次の点は必ず守ってください
  - orca CLI は `execFile(bin, argvArray)` だけで呼ぶ(shell 文字列を作らない)
  - stdout は MCP ワイヤー専用(ログは `console.error`)
  - poll / result / 観測ツールから変更系コマンドを呼ばない
  - 外部に見せるのは非同期 Job API(低レベルな API は登録しない)
- テストは `CommandRunner` の注入点か偽 client を使い、実際の orca を起動しない
- Orca CLI の挙動に依存する変更は、どのバージョンで確認したか(`orca --version`)を PR に書いてください
- リポジトリの文章(README・AGENTS.md・ツールの説明・テスト名)は日本語で書きます

## ライセンス

コントリビューションは [MIT License](./LICENSE) で提供されるものとします。
