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
要素は `{ kind, taskId, role, summary, detail? }`。`role` は `commander`(対象タスク = Commander)/ `child`(直接の子タスク)。`kind` は次の優先順。

| kind | 条件 | summary / detail |
| --- | --- | --- |
| `gate` | pending のゲート | 質問文 / `{ gateId, options }` |
| `task_report` | task または子 task が `blocked` で `result` が非空 | `result`(2000 字まで) |
| `agent_prompt` | worker が `requiresAttention`(終端 / exited の worker は除く) | 入力待ちの説明 / `detail.outputTail`(30 行 / 1500 字)、`outputHash`、`looksLikePrompt`、`observedAt`、`activity` |
| `unknown` | 上のどれにも当たらない | 根拠なし |

- `agent_prompt` の `worker-read` は、`blocked` またはゲート無しの attention のときだけ、最大 2 worker。
  失敗しても poll は壊さず `warnings` に残す。
- 親が `running` でも、子 task が `blocked` なら拾う。

### 入力待ちの見分け方(`agent_prompt`)

`requiresAttention`(categories: `input`)は「承認プロンプト」とは限らない。Commander が子の完了後に
ターンを終えて待機しているだけのこともある(実機実測)。また worker の `activity` / `attention` は
agent hooks の通知から作る projection で、画面の描画とは別経路。承認を手入力で通した後に次の通知が
届かないと、画面が動いていても `waiting` のまま古い値が残り得る(実測: 最終観測が約 12 分前のまま `waiting`)。

- **観測時刻だけでは区別できない**。「ずっと入力待ち」と「動き出したが通知が届かない」はどちらも
  古い `waiting` に見える。`observedAt` は「新しければ信頼できる」の判断材料に留まる。
- 区別には pane の出力を使う:
  - `outputTail`: 末尾が承認プロンプトで止まっているか、Thinking / tool 実行の行か。
  - `outputHash`: 出力末尾のハッシュ。**前回 poll の値と比べて**変化があれば動いている。
  - `looksLikePrompt`: 末尾が承認プロンプトらしい文言(`Do you want to proceed` / `(y/n)` など)か。
    **文言からの推定で確定情報ではない**(見逃し・誤検知あり)。
- **ハッシュの比較は呼び出し側の責務**。MCP は stateless(poll は短時間で返す約束 / HTTP も stateless)なので
  前回値を持たない。呼び出し側は poll ごとに `outputHash` を覚え、同じ値が続いたら人間に通知する。
  比較の手間を肩代わりする `previousOutputHash` 入力(`outputChanged` を返す)は、運用で必要になってから足す(未実装)。
- `looksLikePrompt` が `false` で hash が変化し続けるなら動作中、`true` なら pane で人間が答える。

### phase

- pending ゲートがあるときだけ `decision_gate`。
- `blocked` でゲートが無いときは新しい phase `blocked`(人間の判断とは限らない停止)。

### nextAction

| kind | 案内 |
| --- | --- |
| `gate` | `question` / `options` を確認し `orca_resolve_gate` |
| `task_report` | 報告を読み、`orca_send_message` で指示するか `orca_cancel_task` |
| `agent_prompt` | エージェントが入力待ち(承認プロンプトまたは Commander の待機)。MCP からは解除できない。`detail.outputTail` と `looksLikePrompt` で見極める。待機中なら `orca_send_message` / cancel |
| `unknown` | `orca_get_task_result` と terminal を確認 |

## 前提(実機で未確認)

- `blocked` の task 行に `result` が入ること。
- `gate-list --run` だけで子タスクのゲートが `task_id` 付きで返ること。

確認できない経路は `unknown` に倒し、過大な主張をしない。

## 検証

- モック runner で kind ごとの単体テスト(`tests/job.test.ts`)。
- `npm run typecheck` / `npm test`。
