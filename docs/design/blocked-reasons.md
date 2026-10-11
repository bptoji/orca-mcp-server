# blocked の理由を poll で返す設計案

`orca_get_task_status` が `state: "blocked"` / `phase: "decision_gate"` を返しても、`gates` が空で
判断材料が無いことがある。原因と対処をまとめる。

## 問題

1. `estimatePhase` が `blocked` なら無条件で `decision_gate` にする。ゲート以外の `blocked`
   (Commander の `task-update --status blocked` 報告、例: `nested_worker_depth_exceeded`)でも
   「ゲートを参照」と案内してしまう。
2. ゲート取得が `gate-list --task <対象> --run <run>` で狭い。子タスクに付いたゲートが見えない。
3. `question` を 200 字で切るため、承認可否の判断材料が足りない。
4. エージェント側のツール承認待ちは `attentionNotes` に「terminal を確認して」と出るだけで、中身が出ない。

## 方針(読み取りのみ。変更系コマンドは呼ばない)

### ゲート取得

- `gate-list --run <run>` で取得し、`task_id` が「対象タスク + 直接の子タスク」のものだけに絞る。
- 各ゲートに `taskId` を足す。`question` は 2000 字まで。既存の `id / status / options` は維持。

### `blockedReasons[]`

出す条件: `blocked`、pending ゲート、worker の `requiresAttention` のいずれか。
要素は `{ kind, taskId, summary, detail? }`。`kind` は次の優先順。

| kind | 条件 | summary / detail |
| --- | --- | --- |
| `gate` | pending のゲート | 質問文 / `{ gateId, options }` |
| `task_report` | task または子 task が `blocked` で `result` が非空 | `result`(2000 字まで) |
| `agent_prompt` | worker が `requiresAttention` | `worker-read` の末尾(30 行 / 1500 字) |
| `unknown` | 上のどれにも当たらない | 根拠なし |

- `agent_prompt` の `worker-read` は、`blocked` またはゲート無しの attention のときだけ、最大 2 worker。
  失敗しても poll は壊さず `warnings` に残す。
- 親が `running` でも、子 task が `blocked` なら拾う。

### phase

- pending ゲートがあるときだけ `decision_gate`。
- `blocked` でゲートが無いときは新しい phase `blocked`(人間の判断とは限らない停止)。

### nextAction

| kind | 案内 |
| --- | --- |
| `gate` | `question` / `options` を確認し `orca_resolve_gate` |
| `task_report` | 報告を読み、`orca_send_message` で指示するか `orca_cancel_task` |
| `agent_prompt` | エージェント側の承認が必要。MCP からは解除できない |
| `unknown` | `orca_get_task_result` と terminal を確認 |

## 前提(実機で未確認)

- `blocked` の task 行に `result` が入ること。
- `gate-list --run` だけで子タスクのゲートが `task_id` 付きで返ること。

確認できない経路は `unknown` に倒し、過大な主張をしない。

## 検証

- モック runner で kind ごとの単体テスト(`tests/job.test.ts`)。
- `npm run typecheck` / `npm test`。
