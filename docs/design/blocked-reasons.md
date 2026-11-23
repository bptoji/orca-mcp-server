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
| `ask_undelivered` | ask は回答済みだが asker の dispatch 受信箱で回答が未読(Orca が配達していない) | 説明 / `{ messageId, question, fromHandle, createdAt, recoveryCommand }` |
| `task_report` | task または子 task が `blocked` で `result` が非空 | `result`(2000 字まで) |
| `agent_auth` | 出力末尾に認証エラーの文言(下の「認証切れ」) | 説明 / `{ dispatchId, agent, terminalHandle, matchedPattern, outputTail, turnUnobserved }` |
| `agent_prompt` | worker が `requiresAttention`(終端 / exited の worker は除く。**pending の asker は除外**) | 入力待ちの説明 / `detail.outputTail`(30 行 / 1500 字)、`outputHash`、`looksLikePrompt`、`observedAt`、`activity` |
| `turn_unobserved` | 指示文を受け付けたのに作業を始めていない worker(下の節) | 説明 / `{ dispatchId, agent, terminalHandle, suspectedCause, outputTail }` |
| `unknown` | 上のどれにも当たらない | 根拠なし |

- `agent_prompt` の `worker-read` は、`blocked` またはゲート無しの attention のときだけ、最大 2 worker。
  失敗しても poll は壊さず `warnings` に残す。
- 親が `running` でも、子 task が `blocked` なら拾う。

### ask(2026-10-22 追加・実装済み)

- 座分離契約(`docs/design/run-seat-ownership.md` §7)では承認を ask(`orchestration ask --to run:<run>`)に
  統一し、ゲートを作らせない。ask はメッセージ承認で、asker は `--resume` で回答まで待つため
  `blocked` の典型原因になる。
- poll は `orchestration check --run <run> --peek --types question`(check は Run バインドスコープだが
  run-use はしない — 担当でなければ `consumer_fenced` / `run_required` を `warnings` に残す)で読み、
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
  `kind: ask` から外し、warnings に記録する**(同じ ask への 2 回目以降の返信の防止。呼び出し Run の task-list に現れない
  sub-run 由来の ask は判定不能なので残す)。peek で `consumer_fenced` の意味
  (fenced-on-peek が caller teardown を示すのか)は未確定。

### 回答の配達確認(`ask_undelivered`、2026-11-08 追加・実装済み)

- **実測(2026-11-07 / 11-08、Orca 1.4.250)**: approve を reply しても Commander が読まない事象が 2 件。
  回答は asker の dispatch 受信箱に `read: 0` / `delivered_at: null` で残り、ask 行は呼び出し Run の受信箱で
  unread のまま(poll は `decision_gate` を出し続け、もう一度 reply しても `duplicate: true` で届かない)。
- **原因は Orca の配達先判定**(`src/main/runtime/orchestration/mailbox/routing/mailbox-owner.ts` の `resolve()`、
  1.4.253 のソースでも同じ): terminal が Run を coordinate していると `run:` 受信箱しか見ず、`dispatch:` 宛ての
  メールを `null` に解決して配達しない。座分離契約の Commander は子 Run の coordinator なので必ず該当する。
  10 月までの ask はブロック型(asker が回答を自分で読む = `read: 1`)だったので表に出なかった。
  1.4.250 の ask は Dispatch からだと即座に返り("End your turn; Orca wakes you")、wake を待つと上の不具合で止まる。
- 予防は Commander Prompt: ask は必ず `--wait --timeout-ms 540000`、タイムアウト・中断は `--resume` を繰り返す、
  receipt の "End your turn" に従わない(`commanderSpec` のテストで固定)。
- 検出は poll: pending に見える ask ごとに `orca orchestration inbox --terminal dispatch:<asker dispatch> --full --json`
  (読み取り専用、バインド不要。最大 5 件・同じ受信箱は 1 回)で `thread_id` = ask の messageId、`from_handle` が
  `run:` の回答行を探す。回答無し → 従来どおり `ask`。回答あり・`read: 1`(簡易表示は `handled: true`)→
  受け取り済みなので `asks[]` から外して warnings。回答あり・未読 → `asks[]` から外し `undeliveredAsks[]` と
  `kind: ask_undelivered` に回す(phase は `decision_gate` にせず、`implementation` / `starting` / `settling` なら
  `blocked`。`attentionRequired: true`)。inbox が読めなければ従来どおり `ask` に残して warnings。
- asker の worker は `ask_undelivered` のときも `agent_prompt` に出さない(二重掲載の排除)。
- 回復は人手: asker の pane で `orca orchestration ask --resume <messageId> --json` を実行させる
  (回答済みなのですぐ返る)。MCP から pane へ打ち込む機能(`terminal send`)は作らない(低レベル API を公開しない方針)。
- `orca_reply_message` も事後確認をする: asker の handle(dispatch-show の `assignee_handle`)を coordinator に持つ
  Run を run-list で探し、あれば `delivery.wakeLikelyBlocked: true` + warnings + `nextAction`(上の --resume 案内)。
  読み取りだけで、失敗しても reply の結果は変えない(`wakeLikelyBlocked: null` + warnings)。

### 指示文が送信されない worker(`turn_unobserved`、2026-11-23 実装済み)

#### 事象と過去の記録

- 子 Run の Codex worker が動き出さず、人間が pane で Enter を押すと動き出す。`worker-show --full` の `worker.effects[]` に
  `{ kind: "dispatch_input", state: "accepted" }` に続いて `{ kind: "dispatch_input", state: "turn_unobserved" }` が残る。
- 過去の子 Run の記録:

  | 日付 | agent | `dispatch_input` |
  | --- | --- | --- |
  | 11/08 | claude ×6 | `accepted` |
  | 11/09 | codex ×2 | `accepted` |
  | 11/14 | claude / copilot | `accepted` |
  | 11/14 | codex | `accepted` → `turn_unobserved` |
  | 11/22 | codex ×3 | `accepted` → `turn_unobserved` |

- 11/22 の 3 体は 10:14:12 に起動し、transcript の最初の user メッセージ(指示文の送信)は 10:20:29(手で Enter を押した時刻)。
  Commander の起動指定(`agent: codex` / `worktree: current` / `timeoutMs: 60000`)は正常な 11/09 と同じで、Codex も 11/04 から
  0.166.0 のまま。原因は Orca 側(入力の送り方)にある。orca-mcp / orca-artifacts は子 worker の入力に関与しない。

#### 再現(2026-11-23、使い捨て Run `run_4083ade097c4`、Orca 1.4.268 / Codex 0.166.0)

- ルートの terminal から Codex を **1 体** 起動 → 11.5 秒で `ready` / `input_accepted`、そのまま完了(再現しない)。
- **同時に 3 体** 起動 → 2 体が receipt `state: outcome_unknown` / `stage: turn_start_unobserved`(exit 1)。
  `lastError`: "Dispatch input (text and Enter) was written, but codex's turn start was not observed (waited up to 30s). …
  may hold the prompt unsent in its composer: check with `terminal read` before resending."
- 止まっている間の値:
  - worker-list: `workerState: start_unknown` / `dispatchStatus: pending` / `projection.stage.detail: turn_start_unobserved` /
    `activity: done` / `outcome: in_progress`(= 従来の正規化では running)/ `liveness: live` / attention なし。
  - worker-show: `observation.agentWait: null`(Orca は待ちと判定しない = 既存の `agent_prompt` では拾えない)。
  - task-list: task の status は `blocked`(従来の poll は `kind: unknown` だけを出していた)。
  - 画面: 起動バナーと **空の入力欄**(`›` だけ)。待機中の Codex なら出る placeholder "Ask Codex to do anything" も出ない。
  - `worker-read --source auto` は transcript が無く terminal に落ちる(`fallbackReason: session_not_reported`)。
- 1 体に `orca terminal send --text "\r"` で Enter を送る → 指示文どおりに作業を始めて完了。もう 1 体は約 4 分放置しても止まったまま
  (自然には直らない)で、Enter を送ると同じく完了した。指示文は画面に出ないまま Codex 内に保持されている。
- Enter の後も `workerState: start_unknown` / `stage.detail: turn_start_unobserved` は完了まで変わらず、`activity` だけが `working` になる。
  完了すると `succeeded` / `settled`。

#### 判定(読み取りのみ。pane へは打ち込まない)

`effects[]` は起動時のスナップショットで完了後も残る(11/22 の 3 体)ので使わない。今の状態を表す worker-list の値で候補を決める。

1. **候補**: `projection.stage.detail === "turn_start_unobserved"` かつ `activity !== "working"`、終端でない、liveness が `exited` でない、
   pending の asker でない、attention が立っていない(立っていれば既存の `agent_prompt` に任せる)。worker-list だけで決まるので
   worker-show の 3 件枠には依存しない。
2. **出力末尾を読む**(候補ごとに `worker-read`、**専用の枠で最大 2 件**。止まった worker にだけ使うので `agent_prompt` の枠と分けた)。
   読めなくても `turn_unobserved` は出す(原因は `unknown`、失敗は warnings)。
3. **1 worker 1 判定**(先に当たったものだけ出す):
   1. 最下部 8 行に作業中の表示(`esc to interrupt`)→ 何も出さない(activity が遅れているだけ)。
   2. 認証エラーの文言 → `agent_auth`(`turnUnobserved: true`)。ログインできていなければ Enter を押しても進まない。
   3. 入力欄より上が承認プロンプトらしい → `agent_prompt`(`turnUnobserved: true`)。
   4. Codex の入力欄(最下部の `›` の行)が空 / preamble の書き出し(`You are working inside Orca`)/ `[Pasted Content` →
      `turn_unobserved`(`suspectedCause: "submit_missing"`)。実測は「空」。
   5. それ以外 → `turn_unobserved`(`suspectedCause: "unknown"`)。
4. **出力**: `detail` は `{ dispatchId, agent, terminalHandle, stage, activity, observedAt, outputTail, outputHash, suspectedCause }`。
   phase は `blocked`(`implementation` / `starting` / `settling` から寄せる)、`attentionRequired: true`。
   優先順は `agent_prompt` の次、`unknown` の前。
5. **Commander の起動**で receipt が `outcome_unknown` / `turn_start_unobserved` なら、`orca_delegate_task` の warnings に
   「poll の turn_unobserved に従って pane で Enter」を足す(従来どおり再委譲は促さない)。

| suspectedCause | 案内(nextAction) |
| --- | --- |
| `submit_missing` | Orca で `detail.terminalHandle` の pane を開いて Enter を 1 回押す。承認プロンプトやエラーが出ていたら押さない |
| `unknown` | pane を確認し、起動中なら待つ |

MCP から Enter は送らない(`orca terminal send` の help は「ほかのエージェントの入力欄に打ち込まない」。承認プロンプトに
Enter が届く事故も避ける。`orca_send_message` はメール経路でこの入力欄には届かない)。

#### 認証切れ(`agent_auth`、エージェント共通)

認証切れは Codex に限らず、作業の途中でも起きる(途中ならターン開始は観測済みで `turn_unobserved` は付かない)ので独立の kind にする。

- **対象**: 出力末尾を読んだ worker(`turn_unobserved` の候補と `agent_prompt` の候補 = flagged / waiting / agentWait あり)。
  候補に入らない worker(attention も waiting も無いまま止まった worker)は拾えない。必要なら `outputHash` が変わらない worker を
  呼び出し側が報告する運用で補う。
- **判定**: 作業中の画面(`esc to interrupt`)にはかけない(ツール出力の 401 で誤検知する)。出力の最下部 8 行(Codex は入力欄より上)を
  文言表で照合する。agent は worker-list の `projection.provider.id`(1.4.268 は `{ id, model }` のオブジェクト)。

  | agent | 文言 | 根拠 |
  | --- | --- | --- |
  | claude | `Login expired` / `Not logged in` / `Please run /login` | 2026-10-08 実測(AGENTS.md) |
  | dsh | `No API key for provider` | 実測(pi-ai) |
  | codex | `codex login` / `Not signed in` / `sign in again` | 未確認(推測) |
  | copilot | `gh auth login` / `not authenticated` | 未確認(推測) |
  | 共通 | `401 Unauthorized` / `authentication_error` / `invalid api key` | 未確認。入力欄を切り分けられる画面(Codex)だけで使う |

  文言は大小文字を区別しない。一致した文言は `detail.matchedPattern` に載せる(推定であることを示す)。
- **入力欄の切り分け**: Codex は最下部の `›` の行を入力欄とし、残った指示文の中身は判定に使わない(spec に `401` / `login` が
  含まれても `submit_missing` のまま。単体テストで固定)。claude / copilot の入力欄の書式は未確認なので切り分けず、
  共通の文言を使わない。
- **出力**: `detail` は `{ dispatchId, agent, terminalHandle, matchedPattern, outputTail, outputHash, turnUnobserved, … }`。
  優先順は `agent_prompt` の前、phase は `blocked`、`attentionRequired: true`。
- **案内**: ログインを直す(claude は Orca 側のアカウント紐づけで解消した実測あり)。直しても worker は自動では再開しないので、
  pane で再開させるか `orca_cancel_task` で止めて delegate し直す。

#### 残っている未確認

- claude / dsh 以外の認証切れの画面(文言表の推測部分)。出会ったら `worker-read --source terminal --json --full` を保存して更新する。
- claude / copilot が同じ止まり方をしたときの画面(今は `suspectedCause: unknown` になる)。
- 同時起動で止まる原因そのもの(Orca 本体の入力の送り方)。Orca 側への報告材料: Codex 0.166.0 のまま 11/09 は正常、11/14 以降に発生、
  同時 3 体の起動で 2 体が再現。

### phase

- pending のゲート**か ask** があるときだけ `decision_gate`。
- `blocked` でどちらも無いときは新しい phase `blocked`(人間の判断とは限らない停止)。

### nextAction

| kind | 案内 |
| --- | --- |
| `gate` | `question` / `options` を確認し `orca_resolve_gate` |
| `ask` | `question` / `options` を確認し `orca_reply_message({ messageId, body, run })` で回答する(asker は `--wait` / `--resume` で自分で読む) |
| `ask_undelivered` | `orca_reply_message` をもう一度呼ばない。asker の pane で `ask --resume <messageId>` を実行させる |
| `task_report` | 報告を読み、`orca_send_message` で指示するか `orca_cancel_task` |
| `agent_prompt` | エージェントが入力待ち(承認プロンプトまたは Commander の待機)。MCP からは解除できない。`detail.outputTail` と `looksLikePrompt` で見極める。待機中なら `orca_send_message` / cancel |
| `agent_auth` | ログインを直す。worker は自動で再開しないので pane で再開させるか cancel → delegate し直す |
| `turn_unobserved` | `submit_missing` なら pane で Enter を 1 回押す(承認プロンプトやエラーなら押さない)。`unknown` なら pane を確認 |
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
