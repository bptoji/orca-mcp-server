# orca-mcp

[Orca](https://github.com/stablyai/orca) の CLI(`orca`)を MCP 経由で操作するための
MCP サーバーです。エージェントのオーケストレーション(タスク委譲・進捗確認・メッセージ受発信)を
MCP クライアント(Claude Code / Claude Desktop / dsh など)から利用できます。

## 必要環境

- Node.js **>= 20**(開発は v24 で検証)
- PATH 上に `orca` CLI(または `ORCA_BIN` 環境変数でバイナリパスを指定)
- 大半の操作は起動中の Orca ランタイムが必要(未起動なら `orca open`)

## セットアップ

```bash
npm install
npm run build     # src → dist
npm test          # vitest(子プロセス不要の単体テスト)
```

## MCP クライアント設定例

ビルド(`npm run build`)後に設定ファイルへ登録します。

```json
{
  "mcpServers": {
    "orca": {
      "command": "node",
      "args": ["C:\\Users\\e12171\\orca\\projects\\orca-mcp\\dist\\index.js"]
    }
  }
}
```

開発中にビルドへ依存したくない場合は `npx tsx src/index.ts` を `command` にしても動きます。

## ツール一覧

現在は **フェーズ 1: `orca_status` のみ登録**(観測専用)。内部で `orca status --json` を
1 回呼ぶだけで、エージェントの起動・変更は一切行いません。他 3 ツールはコードの足場を
置いたまま未登録です(エージェント起動を伴うため次のフェーズで有効化)。

| ツール | 状態 | 内容 | 対応 orca コマンド |
| --- | --- | --- | --- |
| `orca_status` | 登録済 | ランタイム準備状態を JSON で返す(入力なし) | `orca status --json` |
| `orca_delegate` | 未登録 | タスク作成 + 指定ターミナルへ dispatch | `orca orchestration task-create` + `dispatch` |
| `orca_task_status` | 未登録 | タスク一覧の絞り込み表示、dispatch 状況 | `orca orchestration task-list` / `dispatch-show` |
| `orca_message` | 未登録 | メッセージ送信 / 受信箱チェック / 返信 / 一覧 | `orca orchestration send` / `check` / `reply` / `inbox` |

### 使用例(概念図・全フェーズ)

1. `orca_status` で稼働中の worktree / ターミナルを把握する ← 今ここ
2. `orca_delegate` で「仕様 → タスク作成 → ターミナルへ dispatch」を一気に委譲する
3. `orca_task_status` で進捗を見る
4. `orca_message`(action=check)でワーカーからの完了報告を受け取る

## スクリプト

| コマンド | 内容 |
| --- | --- |
| `npm run dev` | tsx で開発実行(ビルド不要) |
| `npm run build` | `tsc` で `src/` を `dist/` へビルド |
| `npm start` | `node dist/index.js` |
| `npm run typecheck` | 型チェックのみ(src + tests) |
| `npm test` | vitest 1 回 |
| `npm run test:watch` | vitest watch |

## 構成

```
orca-mcp/
├─ src/
│  ├─ index.ts          # エントリ(createServer + stdio 接続)
│  ├─ orca/
│  │  ├─ client.ts      # 型付き orca CLI クライアント(runner 注入可能)
│  │  ├─ command.ts     # 子プロセス実行の最下層(--json 付与・JSON パース・タイムアウト)
│  │  └─ schemas.ts     # ツール入力の zod スキーマ
│  └─ tools/
│     ├─ status.ts
│     ├─ delegate.ts
│     ├─ task-status.ts
│     └─ message.ts
├─ tests/               # orca ランタイム不要の単体テスト
├─ AGENTS.md            # エージェント向け開発規約
├─ README.md
├─ package.json
└─ tsconfig.json        # 開発用(noEmit) / tsconfig.build.json: ビルド用
```

## トラブルシューティング

- `orca 起動失敗: orca CLI が見つかりませんでした` → PATH か `ORCA_BIN` を確認
- 終了コード非ゼロ → ツールの応答に stderr が含まれます(`orca status` でランタイム起動確認)
- MCP クライアントに接続されない → `npm run dev` で手動起動し、stdio 接続であることを確認
