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

ビルド(`npm run build`)後に設定ファイルへ登録します。`<your-user>` と `<repo-dir>` はご自身の環境に読み替えてください。

```json
{
  "mcpServers": {
    "orca": {
      "command": "node",
      "args": ["C:\\Users\\<your-user>\\<repo-dir>\\orca-mcp\\dist\\index.js"]
    }
  }
}
```

macOS / Linux では `"args": ["/home/<your-user>/<repo-dir>/orca-mcp/dist/index.js"]` のように絶対パスで指定します。

開発中にビルドへ依存したくない場合は `npx tsx src/index.ts` を `command` にしても動きます。

## ツール一覧

公開 API は **非同期 Job API(submit / poll / result)** を主軸にします。
**1 回の MCP 呼び出しでワーカーの完了を待ちません**(30 分ブロックのような設計にしない)。
低レベルすぎる API(`orca_create_worktree` / `orca_start_agent` / `orca_send_terminal` 之类)は
外部に出さず、内部実装に隠しています。

### Job API

| ツール | 役割 | 内部で呼ぶもの | 待つ? |
| --- | --- | --- | --- |
| `orca_delegate_task` | **submit** | run-create(未指定時) → task-create → worktree create --agent → dispatch | 待たない |
| `orca_get_task_status` | **poll** | task-list / dispatch-show / worker-list / gate-list | 待たない |
| `orca_get_task_result` | **result** | task-list / dispatch-show / worker-read | 待たない |

```
orca_delegate_task({ spec: "README を更新して" })
  → { "taskId": "task_abc123", "state": "running", "runId": "run_…",
      "target": { "kind": "new_worktree", "worktree": "…", "terminal": "term_…", "agent": "codex" },
      "dispatchId": "disp_1", "warnings": [] }

orca_get_task_status({ taskId: "task_abc123" })
  → { "taskId": "task_abc123", "state": "running", "phase": "implementation",
      "rawStatus": "dispatched",
      "workers": [ { "agent": "codex", "status": "completed", "dispatchId": "disp_1" },
                   { "agent": "claude", "status": "running", "dispatchId": "disp_2" } ],
      "gates": [], "nextAction": "poll again with orca_get_task_status" }

orca_get_task_result({ taskId: "task_abc123" })
  → { "state": "completed", "result": "README を更新しました",
      "outputs": [ { "dispatchId": "disp_1", "source": "transcript", "text": "…", "cursor": "…" } ] }
```

- `state`: `queued / running / blocked / completed / failed / cancelled`(CLI 生の値は `rawStatus`)
- `phase`: `queued / starting / implementation / decision_gate / settling / finished`
- dispatch だけ失敗しても **タスクは生き続ける** → `state: "queued"` + `warnings` で返す
- CLI 側の失敗はコードごと転送する(例: `run_not_found` + `data.orchestrationRequestId`)

### 介入(intervene)

委譲したジョブに**明示的に頼まれたときだけ**手を出す 2 個です。poll / result / 観測ツールは変更を一切行いません。

| ツール | 役割 | 内部で呼ぶもの | 破壊的? |
| --- | --- | --- | --- |
| `orca_send_message` | ワーカーへの指示補足・質問・エスカレーション | `orchestration send`(必要なら `run-use` でバインド切替) | いいえ |
| `orca_cancel_task` | タスクを止めてキャンセル扱いにする | worker-stop / worker-abandon → `task-update --status failed` | はい |

```
orca_send_message({ subject: "方針変更", body: "実装は src/ のみに限定", run: "run_…",
                    taskId: "task_abc123", type: "status" })
  → { "ok": true, "messageId": "msg_1c7834109a5e", "runId": "run_…", "type": "status" }

orca_cancel_task({ taskId: "task_abc123", reason: "方針変更" })
  → { "taskId": "task_abc123", "state": "cancelled", "cancelled": true, "mode": "stop",
      "workers": [ { "dispatchId": "ctx_…", "action": "stop", "resultState": "stopped" } ],
      "warnings": [] }
```

- `type` は CLI が受け付ける種別のみ(`status / dispatch / worker_done / merge_ready / escalation /
  handoff / decision_gate / question / heartbeat`)。`worker_done` には `outcome` が必須(無ければ `outcome_required`)
- 宛先 `to` は `run:<id>` / `dispatch:<id>` / `@all` / `@codex` / `@worktree:<id>`、省略時は Run の受信箱
- MCP 側は Run バインドを持たないので `run`(`orca_delegate_task` が返した `runId`)を渡す
- **キャンセルは CLI の手順どおり**: worker を fence してから `--status failed --result cancelled`。
  完了済み・キャンセル済みのタスクには何もしない(冪等、`cancelled: false` + warning)
- worktree やターミナルの削除は行わない(残す。後片付けは人間側の判断)
- worker fence に失敗しても `warnings` に記録して task のキャンセルは進める。
  確定だけ失敗したら `cancel_incomplete`(fence 済みの worker 一覧を `detail` に載せる)

### 観測用 read-only

| ツール | 内容 | 対応 orca コマンド |
| --- | --- | --- |
| `orca_status` | ランタイム準備状態(入力なし) | `orca status --json` |
| `orca_list_worktrees` | ワークツリー一覧(repo / limit) | `orca worktree list --json` |
| `orca_get_worktree` | 1 件のワークツリー詳細 | `orca worktree show --json` |
| `orca_list_agents` | worktree 横断のエージェント一覧 | `orca worktree ps --json` |

未登録(足場のみ): `orca_delegate`(低レベルすぎる委譲) / `orca_message`(check / reply / inbox 込みの send)。
送信は `orca_send_message` として公開しているので、そちらを使ってください。

### 挙動の約束

- **入力はすべて argv 配列**で、セレクタや自由文は 1 要素としてそのまま渡す(shell 文字列は作らない)
- **どのツールもワーカーの完了を待たない。** 完了監視は呼び出し側の poll に委ねる
- 大きな欄は既定で切り詰める(`orca_list_agents` の `prompt` は 200 文字、
  `orca_get_task_result` の worker 出力は 4000 文字、`specPreview` は 200 文字)
- CLI が `ok:false` を返したときは `code` をそのまま応答に載せる(`isError: true`)。
  例: `run_required` / `run_not_found` / `worktree_not_found`(+ `data.nextSteps` など)
- ジョブ層の失敗は別の語彙: `task_not_found` / `task_id_missing` / `run_create_failed` /
  `outcome_required` / `cancel_incomplete`
- orca CLI は**呼び出し元ターミナルを 1 つの Run にバインド**する。違う Run への変更は
  `consumer_fenced` で拒否されるため、介入ツールだけが必要に応じて `run-use` で
  バインドを切り替えて 1 回だけ再試行する( poll / 観測ツールは切り替えない)

### 使用例(典型的な流れ)

1. `orca_status` でランタイムが起動しているか確認する
2. `orca_delegate_task({ spec })` で委譲 → `{ taskId, state: "running" }` を即受け取る
3. `orca_get_task_status({ taskId })` を数分おきに poll する(他作業を挟んでよい)
4. 方針を変えたいときだけ `orca_send_message({ subject, body, run, taskId })` で指示を出す
5. 取り消すときだけ `orca_cancel_task({ taskId, reason })` を使う(worker を止めて task を cancelled にする)
6. `state: "completed"` になったら `orca_get_task_result({ taskId })` で成果を受け取る
7. 状況確認が欲しいときだけ `orca_list_worktrees` / `orca_list_agents` を使う

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
│  │  ├─ command.ts     # 子プロセス実行の最下層(--json 付与・JSON パース・タイムアウト)
│  │  ├─ client.ts      # 型付き orca CLI クライアント(runner 注入可能)
│  │  ├─ job.ts         # 非同期 Job API の内部モデル(正規化 + submit/poll/result)
│  │  └─ schemas.ts     # ツール入力の zod スキーマ
│  └─ tools/
│     ├─ result.ts      # 共通の CallToolResult ヘルパー(text / isError)
│     ├─ job.ts         # orca_delegate_task / orca_get_task_status / orca_get_task_result
│     ├─ intervene.ts   # orca_send_message / orca_cancel_task(変更系コマンドはここだけ)
│     ├─ status.ts      # orca_status
│     ├─ worktrees.ts   # orca_list_worktrees / orca_get_worktree
│     ├─ agents.ts      # orca_list_agents(worktree ps の平坦化)
│     ├─ delegate.ts    # orca_delegate(未登録の足場)
│     └─ message.ts     # orca_message(未登録の足場)
├─ tests/               # orca ランタイム不要の単体テスト(job.test.ts は偽 client)
├─ AGENTS.md            # エージェント向け開発規約
├─ README.md
├─ package.json
└─ tsconfig.json        # 開発用(noEmit) / tsconfig.build.json: ビルド用
```

## トラブルシューティング

- `orca 起動失敗: orca CLI が見つかりませんでした` → PATH か `ORCA_BIN` を確認
- 終了コード非ゼロ → ツールの応答に stderr が含まれます(`orca status` でランタイム起動確認)
- MCP クライアントに接続されない → `npm run dev` で手動起動し、stdio 接続であることを確認
