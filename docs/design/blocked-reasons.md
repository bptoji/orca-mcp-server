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
| `ask` | 呼び出し Run の受信箱に pending の ask(`type: question`) | 質問文 / `{ messageId, question, options, taskId?, fromHandle, createdAt }` |
| `task_report` | task または子 task が `blocked` で `result` が非空 | `result`(2000 字まで) |
| `agent_prompt` | worker が `requiresAttention`(終端 / exited の worker は除く。**pending の asker は除外**) | 入力待ちの説明 / `detail.outputTail`(30 行 / 1500 字)、`outputHash`、`looksLikePrompt`、`observedAt`、`activity` |
| `unknown` | 上のどれにも当たらない | 根拠なし |

- `agent_prompt` の `worker-read` は、`blocked` またはゲート無しの attention のときだけ、最大 2 worker。
  失敗しても poll は壊さず `warnings` に残す。
- 親が `running` でも、子 task が `blocked` なら拾う。

### ask(2026-10-22 追加・実装済み)

- 座分離契約(`docs/design/run-seat-ownership.md` §7)では承認を ask(`orchestration ask --to run:<run>`)に
  統一し、ゲートを作らせない。ask はメッセージ承認で、asker は `--resume` で回答まで待つため
  `blocked` の典型原因になる。
- poll は `orchestration check --run <run> --peek --types question`(runMutation 経由。check は
  Run バインドスコープのため、復旧の run-use は呼び出し元自身の Run への再バインドだけ)で読み、
  `type === "question"` の行を `asks[]` に正規化する(`messageId` = `thread_id` / `question` /
  `options` / `taskId` / `dispatchId` / `fromHandle` / `createdAt`)。
- **ask が pending の asker worker は `agent_prompt` に出さない**(二重掲載の排除。asker は ask の
  `--resume` 中なので pane ではなく ask の回答が先)。`taskId` は payload の JSON(`{taskId, dispatchId, …}`)から
  取り、asker task が sub-run 由来(呼び出し元 Run の task 部分木に属さない)でも行は出す。
- 回答は `orca_reply_message({ messageId, body, run })`。ask が見つからなければ `ask_not_found`、
  `taskId` 点検で親 Run の部分木に属さなければ `ask_task_mismatch`(変更前に拒否。sub-run 由来は
  `taskId` を外して解決する)。
- ask の「まだ pending か」の確定は受信箱の unread(peek)が根拠 — ただし reply の後も ask 行は
  しばらく受信箱に残る(2026-10-22 E2E 実測: 完了直後の poll で `asks=1`、2 回目の reply も
  `duplicate: false` / `answer_message_id: null` で通った。のちに peek / `--all` ともに行は消える)。
  そのため **asker task がすでに終端(`completed` / `failed` / `cancelled`)の ask は `asks[]` と
  `kind: ask` から外し、warnings に記録する**(重ね返信の防止。呼び出し Run の task-list に現れない
  sub-run 由来の ask は判定不能なので残す)。peek で `consumer_fenced` の意味
  (fenced-on-peek が caller teardown を示すのか)は未確定。

### phase

- pending のゲート**か ask** があるときだけ `decision_gate`。
- `blocked` でどちらも無いときは新しい phase `blocked`(人間の判断とは限らない停止)。

### nextAction

| kind | 案内 |
| --- | --- |
| `gate` | `question` / `options` を確認し `orca_resolve_gate` |
| `ask` | `question` / `options` を確認し `orca_reply_message({ messageId, body, run })` で回答する(タイムアウト後も asker は `--resume` で待つので遅れて届いてよい) |
| `task_report` | 報告を読み、`orca_send_message` で指示するか `orca_cancel_task` |
| `agent_prompt` | エージェントが入力待ち(承認プロンプトまたは Commander の待機)。MCP からは解除できない。`detail.outputTail` と `looksLikePrompt` で見極める。待機中なら `orca_send_message` / cancel |
| `unknown` | `orca_get_task_result` と terminal を確認 |

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
- Orca が `requiresAction` を立てない承認プロンプトもある(実機実測: git 承認で `activity: waiting` / attention 空)。
  そのため **`activity: "waiting"` の worker も候補**にし、`worker-read` の末尾が承認プロンプトらしい
  (`looksLikePrompt`)ときだけ `agent_prompt` を出す。プロンプトらしくなければ何も出さない
  (Commander が子の完了待ちで waiting のときの誤検知を避ける)。

- `looksLikePrompt` が `false` で hash が変化し続けるなら動作中、`true` なら pane で人間が答える。

## 前提(実機で未確認)

- `blocked` の task 行に `result` が入ること。
- `gate-list --run` だけで子タスクのゲートが `task_id` 付きで返ること。

確認できない経路は `unknown` に倒し、過大な主張をしない。

## 検証

- モック runner で kind ごとの単体テスト(`tests/job.test.ts`)。
- `npm run typecheck` / `npm test`。
