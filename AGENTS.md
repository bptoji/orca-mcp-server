# AGENTS.md — orca-mcp

このリポジトリは **Orca CLI をラップする MCP サーバー** です。
TypeScript (ESM) + `@modelcontextprotocol/server` (SDK v2) + zod v4 + vitest で構成されます。

## コマンド

| 目的 | コマンド |
| --- | --- |
| 依存インストール | `npm install` |
| 型チェック | `npm run typecheck` |
| ビルド(src → dist) | `npm run build` |
| テスト | `npm test` |
| テスト(watch) | `npm run test:watch` |
| 開発実行(ビルド不要) | `npm run dev` |
| 本番実行 | `npm start`(先に `npm run build` が必要) |

## フォルダ構成と役割

```
src/
  index.ts          # MCP サーバーのエントリ。createServer() で全ツールを登録し stdio で接続
  orca/
    command.ts      # orca CLI を子プロセスで実行する最下層(runOrca / buildArgs / OrcaCommandError)
    client.ts       # OrcaClient: コマンド単位の型付きメソッド。runner 注入可能(テストでモック)
    schemas.ts      # 各ツールの zod inputSchema
  tools/
    result.ts       # 共通の CallToolResult ヘルパー(textResult / errorResult / resultOf)
    status.ts       # orca_status          … status
    worktrees.ts    # orca_list_worktrees  … worktree list / orca_get_worktree … worktree show
    agents.ts       # orca_list_agents     … worktree ps の agents[] を平坦化
    task-status.ts  # orca_get_task_status … task-list(+ id 指定なら dispatch-show)
    delegate.ts     # orca_delegate        … task-create + dispatch(未登録の足場)
    message.ts      # orca_message         … send / check / reply / inbox(未登録の足場)
tests/              # vitest。子プロセスを実際に起動しない(モック runner / スタブ client)
```

## 登録ツール(フェーズ 2: 読み取りのみ)

**稼働中は読み取り(read-only)ツールだけを登録する。** すべて内部で orca CLI を 1 回呼ぶだけ
の観測専用で、エージェントの起動・送信・停止・タスク変更は行わない。エージェントを起動する
`delegate` / `message` はファイルの足場が置いてあり、`createServer()` での登録は次のフェーズまで行わない。
登録を外したツールのファイルは削除しない(テストは生かす)。

| ツール | 状態 | 内部コマンド |
| --- | --- | --- |
| `orca_status` | 登録済 | `orca status --json` |
| `orca_list_worktrees` | 登録済 | `orca worktree list --json` |
| `orca_get_worktree` | 登録済 | `orca worktree show --worktree <selector> --json` |
| `orca_list_agents` | 登録済 | `orca worktree ps --json`(agents[] を平坦化) |
| `orca_get_task_status` | 登録済 | `orca orchestration task-list --json`(+ id なら `dispatch-show`) |
| `orca_delegate` | 未登録(足場) | task-create + dispatch |
| `orca_message` | 未登録(足場) | send / check / reply / inbox |

読み取りツールの決まり:

- `annotations` は `{ readOnlyHint: true, openWorldHint: false }` 固定。
- 大きな欄は既定で省略する(`orca_list_agents` は `prompt` を 200 文字で切り詰め、
  `lastAssistantMessage` は `full: true` のときだけ)。
- 1 ハンドラーで orca を複数回呼ぶのは「同じコマンドの continuation」だけ
  (`task-list` → `dispatch-show`)。新しいコマンドを勝手に足さない。

## 決まりごと

### 心臓部(command.ts)のセキュリティ — 最優先

- **shell 文字列を絶対に作らない。** `exec(\`orca ${userInput}\`)` は command injection。
  実行は `execFile(bin, argvArray)`(`shell: false` 固定)のみを使うこと。
- 引数は常に **argv 配列**。ユーザー入力は 1 要素としてそのまま渡す(エスケープ不要、
  shell に解釈させること自体を避ける)。
- `runOrca` は失敗時に例外を投げず `OrcaCommandResult` を返す:

  ```ts
  interface OrcaCommandResult<T> {
    ok: boolean;
    data?: T;                      // stdout の JSON 解析結果
    error?: { code: string; message: string };        // transport 側の失敗
    orcaError?: { code: string; message: string; data?: unknown }; // CLI が返す ok:false
    args: string[]; exitCode: number; stdout: string; stderr: string;
  }
  const result = await runOrca(["status", "--json"]);
  if (!result.ok) { /* result.error.code で分岐 */ }
  ```

- 失敗コードは `spawn_failed / timeout / max_buffer_exceeded / non_zero_exit / invalid_json` の
  安定した識別子のみ。新しい失敗の形を足すときは型にも追記する。
- **transport と CLI の意味は別軸で持つ。** `error` は終了コード等の分類、`orcaError` は
  stdout の `ok:false` エンベロープが運ぶ CLI 側の理由(`run_required` など)。
  終了コード 0 でも `ok:false` は入り得る(`ok: true` のまま `orcaError` だけ載せる)。
- 例外化はクライアント層(`OrcaClient.call`)だけが行う。ツール層は
  `OrcaCommandError.code` を応答に載せて返す。このとき **`orcaError` があれば transport の
  code より優先する**(モデルに `non_zero_exit` より `run_required` を伝える)。
- 失敗はプロトコル例外にせず `isError: true` の CallToolResult で返す
  (`src/tools/result.ts` の `resultOf` を使う)。

### 一般

- **stdout は MCP ワイヤー専用**。ログ・診断は必ず `console.error`(stderr)へ。
  stdout に雑な出力を混ぜるとプロトコルが壊れます。
- orca CLI 呼び出しは `--json` 前提(`buildArgs` が既定で付与)。人間向けテキスト出力の解析はしない。
- 新しいツールは `src/tools/<name>.ts` に `registerXxxTool(server, client)` を書き、
  `src/index.ts` の `createServer()` で登録する。inputSchema は `src/orca/schemas.ts` に置く。
- orca CLI の新しいコマンドは `OrcaClient` にメソッドを追加する。
  引数組み立ては純粋な配列操作(`buildArgs`)に保ち、プロセス起動は `command.ts` の
  `execFile` に集約する(他ファイルで `spawn` / `exec` を使わない)。
- バイナリパスは `ORCA_BIN` 環境変数で上書き可能(既定: PATH 上の `orca`)。
- ESM なので相対 import は `.js` 拡張子付き(`import { x } from "./client.js"`)。
  型のみ import は `import type`(`verbatimModuleSyntax`)。
- テストは orca ランタイム不要。`CommandRunner` の注入点を使うこと。

## orca CLI 側の前提

- 大半のコマンドは起動中の Orca ランタイムを必要とします(未起動なら `orca open`)。
- コマンド仕様の確認は `orca --help` / `orca orchestration <cmd> --help` / `orca agent-context --json`。
