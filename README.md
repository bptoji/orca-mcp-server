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

現在は **フェーズ 2: 読み取り(read-only)5 ツール**。すべて内部で orca CLI を 1 回呼ぶだ
けの観測専用で、エージェントの起動・送信・停止・タスク変更は一切行いません。
エージェントを起動する `orca_delegate` / `orca_message` は足場のみで未登録です。

| ツール | 状態 | 内容 | 対応 orca コマンド |
| --- | --- | --- | --- |
| `orca_status` | 登録済 | ランタイム準備状態を JSON で返す(入力なし) | `orca status --json` |
| `orca_list_worktrees` | 登録済 | ワークツリー一覧(repo / limit 指定可) | `orca worktree list --json` |
| `orca_get_worktree` | 登録済 | 1 件のワークツリー詳細(セレクタ指定) | `orca worktree show --json` |
| `orca_list_agents` | 登録済 | worktree 横断のエージェント一覧(平坦化) | `orca worktree ps --json` |
| `orca_get_task_status` | 登録済 | タスク一覧(+ id 指定で dispatch 状況) | `orca orchestration task-list` / `dispatch-show` |
| `orca_delegate` | 未登録 | タスク作成 + 指定ターミナルへ dispatch | `orca orchestration task-create` + `dispatch` |
| `orca_message` | 未登録 | メッセージ送信 / 受信箱チェック / 返信 / 一覧 | `orca orchestration send` / `check` / `reply` / `inbox` |

### 読み取りツールの挙動

- **入力はすべて argv 配列**で、セレクタや自由文は 1 要素としてそのまま渡す(shell 文字列は作らない)
- `orca_list_agents` は既定で `prompt` を 200 文字に切り詰め、`lastAssistantMessage` を省略する
  (`full: true` で全文)
- CLI が `ok:false` を返したときは `code` をそのまま応答に載せる。例: Run 未バインドで
  `orca_get_task_status` → `code: "run_required"`(+ CLI の `data.nextSteps`)、`isError: true`

### 使用例(概念図・全フェーズ)

1. `orca_status` で稼働中のランタイムを把握する
2. `orca_list_worktrees` / `orca_get_worktree` で対象 worktree を特定する ← 今ここ
3. `orca_list_agents` で起動中のエージェント(dsh / codex / claude)を把握する ← 今ここ
4. `orca_delegate` で「仕様 → タスク作成 → ターミナルへ dispatch」を一気に委譲する
5. `orca_get_task_status` で進捗を見る ← 今ここ
6. `orca_message`(action=check)でワーカーからの完了報告を受け取る

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
│     ├─ result.ts      # 共通の CallToolResult ヘルパー(text / isError)
│     ├─ status.ts      # orca_status
│     ├─ worktrees.ts   # orca_list_worktrees / orca_get_worktree
│     ├─ agents.ts      # orca_list_agents(worktree ps の平坦化)
│     ├─ task-status.ts # orca_get_task_status
│     ├─ delegate.ts    # orca_delegate(未登録の足場)
│     └─ message.ts     # orca_message(未登録の足場)
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
