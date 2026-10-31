# 座(Run binding)の所有権分離と ask 承認 — orca-mcp / orca-artifacts 対応

## 1. 目的

呼び出し側(orca-mcp)と Commander が**同じ Run の座(coordinator binding)を取り合う構造的競合**
を設計で排除し、人間の承認を **ask / reply(メッセージ経路)** に統一する契約を固める。
対象は 2 リポジトリ:

1. **orca-mcp**(このリポジトリ)— 依頼文(`COMMANDER_PROMPT`)・公開 API・poll の修正
2. **orca-artifacts** — `AGENTS.md` の承認・中止・cancel 節の文言修正

決定の根拠は 2026-10-21 の実機測定(§3)。測定が直接消した選択肢(最小修正案)と
採らなかった理由も記録する(§5)。

## 2. 用語

- **座 / coordinator seat**: 1 つの Run につき 1 つの terminal だけが持つバインド。
  `run-create` を実行した terminal が最初の座を持つ。`run-use` は座の**奪取**(§3 の実測)。
- **coordinator レベル mutation**: `task-create` / `worker-start` / `gate-create` / `send` /
  `task-update`(自分の task 以外)/ `gate-resolve` など、Run スコープを変更する操作。
  座なしでは **dispatch 中の worker でも拒否される**(§3.3)。
- **メッセージ系操作**: `ask` / `reply` / `check` / `worker_done` / heartbeat / 読み取り。
  座と無関係に成功する(§3.4・§3.5)。

## 3. 根拠 — 2026-10-21 実機測定(runtime 1.4.222)

テスト Run `run_a1ce91163bcf`(objective: `seat-test-01`)と 4 組の test pane で実施。
自分の terminal の binding は一度も触っていない。

### 3.1 座は単一で、`run-use` は奪取型

- T1 が `run-create` → `coordinator_handle: T1`、`consumer_generation: 1`。
- T2 が `run-use --id <run>` → `coordinator_handle` が **T2 に替わり**、`consumer_generation: 2`。
- 奪われた側からの mutation → `consumer_fenced`
  (`This coordinator terminal is no longer bound to Run <runId>.`)。
- 座の取り合いは双方向で再現(T1 が取り返す → 今度は T2 が fenced)。

### 3.2 読み取りは座と無関係

- fenced 状態の terminal から `gate-list --run <run>` → `"ok": true`。
  依頼者の poll(読み取り)は座を奪われても止まらない。止まるのは mutation のみ。

### 3.3 決定打 — dispatch 中の worker でも座なしでは mutation 全不可

active supervised Dispatch を持たせた pane T6(座なし・一度も coordinator でない)から:

| プローブ | 結果 |
| --- | --- |
| `task-create --run <run> --parent <自分のtask>`(自分の部分木への子タスク作成) | `consumer_fenced` — 拒否 |
| `task-create --run <run>`(兄弟タスク作成) | `consumer_fenced` — 拒否 |

**dispatch 権限では coordinator レベル mutation は一切許されない**。つまり共有
{{runId}} モデルでは、Commander が仕事をするには必ず座が要る = 呼び出し側と**構造的に排他**。
「依頼文から run-use 指示を削るだけ」の最小修正は、仕事が始まらないので消えた。

### 3.4 `ask` は dispatch 限定・メッセージ経路・ゲートではない

- `orchestration ask` は実在(`--question / --resume <message_id> / --to run:<id> /
  --options <CSV> / --timeout-ms`)。ただし **active supervised Dispatch がないと
  `dispatch_inactive` で拒否** — asker は必ず dispatch 中(= 実際の Commander / worker)。
- ask を送っても **`gate-list` には現れない**(`"gates": [], "count": 0`)。
  coordinator の受信箱(`check --json`)に **メッセージ(`type: "question"`,
  `thread_id: msg_…`)** として届き、payload に `taskId` / `dispatchId` / `question` /
  `options` が入る。
- 回答経路は **`reply --id <msg_id> --body`**。reply で asker のブロックが解け、
  `answer: "approve"` / `timedOut: false` で返る(ブロック経路を直接確認)。
- タイムアウト後も **`ask --resume <msg_id>`** で回答を回収できる(resume の既定
  timeoutMs は 600000 = 10 分と実測)。

### 3.5 測定からの含意

- 「取り合い」は指示のミスではなく、共有 Run + 座が排他という構造の必然。
- 「停止して報告」は現行設計では**終端状態**(resume 指示でも再委譲でも同じ依頼文 →
  同じ挙動で再発。constraints で上書きしても座なしでは仕事が始まらない)。
- よって契約は **座の所有権を Run 単位で分離** する形にしかない(§5)。

## 4. 問題の構造(現行の 3 層の矛盾)

```
依頼文(COMMANDER_PROMPT):   「普通の子タスク・worker・ゲートは {{runId}} を再利用。
                             run-scoped 操作の前に run-use --id {{runId}}」
artifacts AGENTS.md:         「子 Run を 1 つだけ作り全 worker をそこに。親 Run に
                             run-use するな。承認は ask(--to run:<親Run>)。
                             依頼者は orca_resolve_gate({messageId,…}) で答える」
orca-mcp 公開 API:            ゲート専用(orca_resolve_gate は messageId を受けない。
                             ask の送受信 API は未登録。orca_message の reply は足場のみ)
```

実測で確定した矛盾点:

| # | 矛盾 | 実測による判定 |
| --- | --- | --- |
| 1 | 依頼文の run-use 指示 × 座の排他 | 座の奪取は実在(§3.1)。しかも dispatch 中でも座なしでは mutation 全不可(§3.3)なので、共有 Run モデルでは取り合いは避けられない |
| 2 | artifacts の「依頼者は orca_resolve_gate({messageId,…}) で答える」 | 二重に誤り: その引数は存在しない(git log -S messageId で 0 件)、かつ ask は gate-list に出ないので gate-resolve では解けない(§3.4)。正しい回答手段は `reply`(実測)で、orca-mcp はそれを公開していない |
| 3 | artifacts の「poll や承認の回答が止まります」 | 過剰: poll(読み取り)は止まらない(§3.2)。止まるのは cancel / gate-resolve 等の mutation |
| 4 | artifacts の `orca_cancel_task({graceful: true})` | `graceful` という引数は存在しない(schemas.ts は `{taskId, run?, reason?, mode: stop\|abandon, cascade, includeSubRuns}`。git log -S graceful で 0 件)。中止依頼は `orca_send_message` による送信(現行 AGENTS.md の設計どおり)に統一すべき |

## 5. 決定

**座の所有権を Run 単位で分離し、承認を ask に統一する。**

1. **親 Run の座 = 呼び出し側が終身保持。** Commander は親 Run に対して
   run-use も mutation もしない(依頼文から run-use 指示を削除)。
2. **Commander は自分が作った子 Run で仕事をする。** 子 Run の座は
   run-create した terminal(= Commander)が独占。子タスク・worker・承認待ちは
   すべて子 Run 内。
3. **worker はメッセージ系だけ。** worker_done / heartbeat / ask(子 Run 宛)/
   読み取りは座なしで成功する(実測)。worker は Run を作らない・mutation しない。
4. **人間の承認 = ask → reply。** ゲートは依頼文が作らせない
   (「意味を 2 通りにしない」の契約レベル遵守)。
5. 呼び出し側が子 Run の座に触るのは **cancel(=  teardown)の時だけ**。
   既存の runMutation 機構で座を奪って worker fence → task failed。
   fenced 側(Commander)は「取り合いが起きた」という意味ではなく
   「teardown が始まった」という意味の fence を受け取る → 停止して報告が
   正常ルートに戻れる復帰路(cancel → 再委譲)と結合する。

採らなかった案と理由:

- **案 A(artifacts をゲート方式に書き替える、orca-mcp 変更ゼロ)** — §3.3 で消えた。
  ゲート方式でも座の取り合いは消えない(ゲートの解決のたびに必ず起きる)。
- **共有 Run のまま座を譲り合うプロトコル(呼び出し側が退席する)** — 「退席」に相当する
  コマンドが存在しない(run-use は別 Run への取り直しのみで、退席は未確認)。さらに
  退席しても呼び出し側の介入(gate-resolve / cancel / send)のたびに座を取り返す →
  競合の転位にしかならない。
- **ask とゲートの併存(リポジトリが選ぶ)** — 契約レベルで 2 通りの意味が残るので却下。
  `orca_resolve_gate` は既存ジョブ互換として残すが、依頼文はゲートを作らせない
  (将来の deprecate は呼び出し側の移行を見て判断)。

## 6. 新契約 — `COMMANDER_PROMPT` 改訂案(src/orca/job.ts)

変更するのは `Gate ownership` 節と `Run ownership and sub-run policy` 節。
Guide 読み込み・Responsibilities・Completion boundary・subtask spec の自己完結性の
各節は現行のまま(`{{goal}} / {{repo}} / {{constraints}} / {{runId}}` の注入も維持)。

```text
Run ownership:
The caller observes, approves, and cancels through exactly ONE Run: {{runId}}.
Its coordinator seat stays with the caller for the whole job. Your terminal
never holds it: never run "run-use --id {{runId}}", and never perform
mutations against {{runId}} (task-create, worker-start, gate-create, send).
Your terminal holds no seat there, so those mutations are refused with
consumer_fenced — and taking the seat would block the caller.

Do all of your work inside your own child Run:

1. Create it once, with the caller's job marker at the start of the objective:

   orca orchestration run-create --objective "orca-mcp-parent: run={{runId}} task=<your task id> <short objective>" --json

   The terminal that creates a Run becomes its coordinator seat; the seat of
   your child Run is yours and stays with you.

2. Create every child task and start every worker inside that child Run:

   orca orchestration task-create --run <childRunId> --parent <your task id> --spec ...
   orca orchestration worker-start --run <childRunId> --task <child task id> --agent <worker agent>

3. Record the child Run id in your final report, and finish every task inside
   it, so the caller's poll and cancel cover it.

Never create a Run to bypass a nested worker depth limit, a circuit-broken
dispatch, a failed dispatch, or a missing Run binding: the version-matched
guide says a new Run does not reset depth and must not route around those
boundaries. Workers must not create Runs at all — they report and escalate
instead.

A mutation that fails with "No Run is bound" or run_required means your own
terminal lost its binding: re-bind once with "run-use --id <childRunId>" and
retry once. A mutation that fails with consumer_fenced means someone else
holds the seat — for your child Run that is the caller tearing the job down.
Stop, report the exact error, and wait. Do not fight for the seat.

Human approval — ask the caller:
You own the human-facing decisions. Request approval with an ask. An ask is
message-based, needs no seat, and blocks until the caller replies:

  orca orchestration ask --to run:{{runId}} --question '<question>' --options approve,reject --timeout-ms <n> --json

- An ask is only available while your supervised Dispatch is active.
- Do not create gates for human approval, and do not create a gate on your own
  task. gate-list does not show asks.
- If the ask times out, keep waiting with the same message id:
  orca orchestration ask --resume <messageId> --json
  Do not re-ask the same question.
- Never proceed without the answer, and never substitute your own judgement
  for a missing answer.

If ask fails (for example dispatch_inactive) or fails repeatedly, stop the
approval-requiring operation, report the exact error, and wait for explicit
intervention. Never proceed as if approval had been granted.
```

依頼文側で消える・置き換わる現行の文言:

- 「Reuse that Run for ordinary child tasks, supervised workers, and decision gates」→ 削除(子 Run 必須に置き換え)。
- 「Before any run-scoped operation, verify the current binding and bind to the existing Run」 → 削除(§3.3 で正しくないことが確定: 座なしでは mutation が通らないし、通そうとすれば座を奪う)。
- 「Before any run-scoped operation … create a dedicated approval child task inside {{runId}} … run gate-create --task」(Gate ownership 節)→ ask 節に置き換え。
- 「A worker acting as an autonomous coordinator may create and manage a child Run when the guide …」→ 「may」ではなく全 Commander が子 Run を作る規則に置き換え。worker による Run 作成は禁止を明記。

## 7. orca-mcp 側の修正

### 7.1 `COMMANDER_PROMPT` の差し替え(§6)

`commanderSpec` のテストで文言を固定する(既存の固定テストに改訂版を反映)。

### 7.2 ask の受信表示(poll)

- poll ハンドラーに `orchestration check --json` を追加する(読み取りなので
  AGENTS.md の「poll / result の読み集め」の列挙に check を追記する)。
  呼び出し側(= 親 Run の coordinator)の受信箱に type: `question` として届く(§3.4)。
- 正規化して poll 応答に載せる:
  - `blockedReasons[]` に `kind: "ask"`(docs/design/blocked-reasons.md に kind 追加)、
    `detail` に `messageId`(thread_id) / `question` / `options` / `payload.taskId` / `payload.dispatchId`。
  - `asks[]` 行(または blockedReasons の detail に含めるかは実装時に決める)。
  - pending 判定(回答済み・期限切れスレッドを除外する条件)は実機の check 応答の
    フィールドで確定する(§9 の E2E で確認)。

### 7.3 `reply` の公開(新ツール `orca_reply_message`)

- inputSchema(厳密): `{ messageId, body, taskId? }`。
  - `body` は ask の `--options` で出した選択肢の値(`approve` / `reject` など)を
    入れる規則をツール説明に書く。
  - `taskId` は点検用: `payload.taskId` と一致しない ask への reply は
    `ask_task_mismatch` で**変更前に**拒否する(既存 `gate_task_mismatch` と同じ形)。
    指定なしは点検しない(既定の挙動を変えない)。
- client: `replyMessage()` → `["orchestration", "reply", "--id", <messageId>, "--body", <body>]`。
  `orca_message`(未登録の足場)の reply 実装を client / job 層に昇格する。
  check も同様に昇格(poll が使う)が、orca_message 自体は引き続き登録しない。
- JobError 語彙に `ask_task_mismatch` を追記。`run_required` / `consumer_fenced` /
  "No Run is bound" は既存の `runMutation` が reply にもそのまま効く
  (reply は mutation なので座が必要 — 呼び出し側は親 Run の座を保持しているのが
  新契約で、奪われる経路は存在しない)。
- `orca_resolve_gate` は現行のまま(既存ジョブ互換)。新契約のジョブでは使われない。

### 7.4 変更不要(既存機構の継続確認)

- cancel の cascade + sub-run 対応(PR #8): 呼び出し側が子 Run の座を奪って
  worker fence → task failed。新契約下でもこの経路だけが子 Run の座に触る(§5.5)。
- sub-run 発見(coordinator_handle 照合 + objective マーカー): 変更なし。
  request.md への childRunId 記録は人間と Commander の記録用で、機械の発見経路は
  変えない(orca-mcp にリポジトリ読み取りは存在しない)。
- `worker-start --run <childRunId>` は既に存在(実測済み)。
- nested worker depth 制限は Run 構造と独立(既知の実測事項)。

### 7.5 テストと E2E

- vitest(モック runner): poll が check を呼んで ask 行を出す / reply の
  taskId 点検 / `COMMANDER_PROMPT` 固定テスト / schemas の厳密性。
- 実機 E2E は §3 の手順を流用: run-create → task-create → dispatch →
  ask(子 Run の座を保った Commander から `--to run:<親Run>`)→ check → reply →
  asker の `answer` 確認 → task-update failed → pane close。

## 8. orca-artifacts AGENTS.md 側の修正

行別修正表(現行 191 行):

| 行 | 現行 | 修正案 |
| --- | --- | --- |
| 7 | 優先順位条項(Constraints > orca-mcp 固定指示 > AGENTS.md) | 変更なし(防御条項として残す。新契約下では両者一致する) |
| 21–26 | 構造の図(親 Run → Commander の task → 子 Run → Worker) | 変更なし(**新契約と一致**) |
| 28 | 「Commander は自分の **子 Run を 1 つだけ**作り、Worker の task・worker はすべてその中に作ります(作り方と親 Run への通知は orca-mcp の指示どおり)」 | 作り方を具体化: 「`run-create --objective` で 1 つ作る(objective の先頭に orca-mcp の指示どおりのマーカー)。子 Run の座は自分の terminal が持ち、run-use の取り返しは不要(必要になったら契約違反として報告)」 |
| 29 | 「親 Run に `run-use` してはいけません。依頼者の席を奪い、poll や承認の回答が止まります。」 | 「親 Run に `run-use` してはいけませんし、親 Run への task-create / send などの mutation も行いません(座なしでは拒否されます)。座は依頼者が終身保持します。読み取りは止まりませんが、依頼者の cancel と承認の回答は座を必要とします。」 |
| 30 | 「依頼者は orca-mcp の `orca_resolve_gate({ messageId, resolution, run })` で答えます」 | 「依頼者は orca-mcp の `orca_reply_message({ messageId, body })` で答えます(答えは `--options` で出した選択肢の値を body に書く)」 |
| 31 | 「自分の task に `gate-create` してはいけません…。親 Run にもゲートを作りません。」 | 「ゲートは使いません(承認は ask)。`gate-list` に ask は現れません(実測)。」 |
| 32 | 「待ち時間の上限は 1 回あたり 30 分」 | 実測修正: resume 時の待ち時間は既定 10 分(実測)。上限の断言は外すか、実機再測定後に値を戻す(§10) |
| 34 | 「heartbeat と `worker_done` は、dispatch の preamble に書かれたコマンドどおり親 Run に送ります」 | 変更なし(ただし preamble の宛先が親 Run であることの実機確認を §10 に残す) |
| 85 | PowerShell 5.1 の長い `--spec` の注意 | 変更なし |
| 97 | `--options "approve,reject"` | 変更なし(**CSV で正しい** — 実測と一致。gate-create の JSON オプション規則は artifacts 側では使わない) |
| 171 | 「依頼者は orca-mcp の `orca_cancel_task({ taskId, reason, graceful: true })` で中止を依頼し…」 | `graceful` という引数は存在しない(実測)。 「依頼者は orca-mcp の `orca_send_message` で中止を依頼し、Commander には件名 `cancel requested` のメッセージが届く」に統一 |
| 182 | 「依頼者が `graceful` なしで `orca_cancel_task` を呼ぶと、Commander も含めて強制的に止められ、記録は残りません。」 | 「`orca_cancel_task` には中止依頼モードがなく(mode 既定 `stop`、cascade 既定 `true`)、呼ぶと cascade 強制停止になり記録は残りません。中止を依頼するには `orca_send_message` を使います。」 |
| 191(worker 手順) | 「人間向けの承認ゲートは作りません。承認や判断が必要な場合は、preamble の `ask` で Commander に質問してください」 | 変更なし(ask は dispatch 中の worker も使える(実測)。宛先は preamble どおり子 Run 宛) |

追加の 1 行(任意): 「`consumer_fenced` が子 Run で起きたときの正しい解釈」—
「自分の子 Run で fenced が出たら、それは依頼者が teardown(cancel)を始めた合図です。
座を取り返さず停止して報告してください。」(§5.5 の復帰路と結合する)。

## 9. 移行手順と依存順

1. **orca-mcp 側が先**(契約の基準側): `COMMANDER_PROMPT` 改訂 + poll の ask 表示 +
   `orca_reply_message` 公開を 1 ブランチで実施 → 実機 E2E。
2. **artifacts AGENTS.md はその後に修正**(§8)。新 API 名(`orca_reply_message`)が
   確定してから変える。移行期間中の食い違いは優先順位条項(Constraints)で救済されるが、
   現行 artifacts の ask 節は存在しない引数を指しているので、
   reply 公開まで artifacts 側の承認は動かない点を利用側に明示する。
3. weever 側の `AGENTS.md`(`COMMANDER_PROMPT` の説明・blockedReasons kind・
   公開 API 表)と `docs/design/blocked-reasons.md`(kind: ask 追加)を同 PR で更新。

## 10. 検証項目・残る未実測

- [x] 子 Run の座を保持した terminal から親 Run 宛の `ask`(`--to run:<親Run>`)が
      通るか → **§13 E2E で確認**(Commander は子 Run の座から `ask --to run:<親>` を送り、
      行は親 Run の受信箱に届いた。行の `payload.taskId` は親 Run の Commander task を指す)。
      併せての「--to を省略した場合に dispatch の owning Run(= 親 Run)が宛先になる」
      という help 記述の実機確認は未実施(E2E は明示指定だった)。
- [x] 子 Run の座を保った terminal から**親 Run 宛の `worker_done` / heartbeat** が
      届くか → **§13 E2E で確認**(結果の `provenance: worker_report` が届き、
      報告に「ask への approve 回答を受領して完了」とある。heartbeat は未確認)。
- [ ] worker の自分の task への `task-update`(事後報告)が座なしで通るか。
      通らない場合も、worker_done が本体なので契約は「worker は報告のみ」で成立するが、
      cancel 機構の「worker fence → task failed」が呼び出し側 run-use 前提であることは
      変わらない。
- [ ] `ask` のタイムアウト上限(artifacts AGENTS.md の「30 分」の根拠)。
      実測は resume 時の既定 10 分のみ。
- [x] ~~`check` の pending 判定(回答済みスレッドが check に含まれることの確認 —
      §3 で過去スレッドも表示された)~~ → §12 で実装済み: `--peek --types question` は
      unread のみを返す(回答済み・既読済みは現れない)。§3 で過去スレッドも見えたのは
      `--all` 相当の表示。reply の点検は `--all` で読む(回答済み行の確認に使う)。
      **§13 で再修正**: reply 直後も回答済みの行はしばらく受信箱に残る(peek に現れる)、
      のちに peek / `--all` ともに消える。旧記録の「回答済みは peek に現れない」は
      この削除後の観測と整合する。
- [ ] 座を「離す」操作の存在(契約では使わないが、記録しておく)。
- [ ] peek(受信箱読み取り)に対する `consumer_fenced` の意味 — fenced が caller
      teardown を示すのか(読み取りは本来座と無関係 §3.2 のため。§12 の runMutation 経由は
      2026-10-31 に撤回し、poll は再バインドせず warnings に留める)。
- [x] ask → reply までの MCP 経路 E2E(asker の `answer` 確認までの実機確認) → **§13**。

## 11. 測定痕跡(記録用)

- Run `run_a1ce91163bcf` / objective `seat-test-01` / 2026-10-21。
- failed 確定済み task: `task_7bd8b70312b8`、`task_c223f6155f01`、`task_d5efdbc17f5d`
  (probe で作られたタスクは fenced で未作成、追加の残骸なし)。
- test pane 4 組(`seat-test-t1`〜`t6` 相当)はすべて close 済み。
  測定者自身の terminal binding は不変。
- 2026-10-22 追加分: Run `run_1e32ec292d45`(座分離 + ask/gate 挙動の再測)、
  check 応答(`messages` 平坦行 / `type: question` / payload JSON 文字列)の fixture は
  `tests/job.test.ts` の 2026-10-22 実測 fixture として固定。
- 2026-10-22 E2E 追加分: Run `run_8e8a0f8a48e4`(claude Commander が停滞 → 失敗例)、
  Run `run_5d8a736c0196`(ask → reply → 完了の成功例、子 Run `run_093f793a0c47`)。
  詳細は §13。

## 12. 実装記録(2026-10-22、orca-mcp 側)

§7 の修正を実装した。設計時の未確定点に実測で確定した差異と補足を残す。

### 12.1 check の応答構造(§7.2 の確定)

- `orchestration check --run <run> --json` の応答は **`result.messages` の平坦行**(他の
  envelope 形式のばらつきを `extractMessages()` が `messages` / `items` / `data` で吸収)。
  ask 行は `type: "question"`、`thread_id` がメッセージ id、`payload` は
  **JSON 文字列**(`{taskId, dispatchId, question, options}`)— `toAskRow()` で
  parse して正規化する(`messageId / threadId / question / options / taskId /
  dispatchId / fromHandle / toHandle / createdAt / deliveredAt`)。
- pending 判定は `--peek` + `--types question` の **unread だけ**が根拠(§10 の確定)。
- check は Run バインドスコープ(2026-10-22 実測: 別 Run にバインドされた terminal から
  `check --run <run>` は `consumer_fenced`)。当初は poll の ask 受信を runMutation 経由にし、
  復旧の run-use を「呼び出し元自身の Run への再バインド」と位置づけたが、runMutation は渡された Run が
  呼び出し元のものかを確かめない。**2026-10-31 実測**: 他人の Run ID で poll しただけで run-use が走り、
  その Run の `coordinator_handle` が呼び出し元ターミナルに書き換わった(`consumer_generation` 1 → 2、
  元の担当は受信箱を失った)。是正後は poll の check は runMutation を通さず、`consumer_fenced` /
  `run_required` は ask を読まずに `warnings` に残す。他の失敗も `warnings` に留めて poll を壊さない。
- poll 応答には `asks[]`(正規化行)+ `kind: "ask"` の `blockedReasons` 両方を出す
  (§7.2 の「どちらか」は両方に確定)。pending asker の worker は `agent_prompt`
  から除外(二重掲載の排除)。

### 12.2 reply の実装(§7.3 の確定)

- inputSchema は設計の `{ messageId, body, taskId? }` に **`run` を必須で追加**
  (resolveGate と同じ先例)。check / reply も Run バインドスコープで、点検で読んだ
  受信箱の Run と reply 先が一致しなければ誤返信になる。
- reply の前点検は `check --all` で読む(§13 の実測で修正: reply 直後も回答済みの行は
  しばらく受信箱に残るため、--all の利点は限定的。存在点検としては peek / --all
  どちらでも通る。--all は旧記録に合わせた保守)。
  見つからなければ `ask_not_found`(JobError 新語彙)で**変更前に**拒否。
- `taskId` 点検は呼び出し元 Run の task 部分木(`collectDescendants`)に
  `payload.taskId` が属するかで判定し、属さなければ `ask_task_mismatch`。
  **sub-run 由来の ask は呼び出し元 Run の task-list に現れない**ので、その場合は
  呼び出し側が `taskId` を外して解決する(ツール説明に記載)。
- reply 本体は `runMutation` 経由(`reply` は mutation なので座が必要)。
  応答は `{ok, messageId, threadId, answerMessageId, answerBody, duplicate, taskId,
  runId, body, warnings, note}`。
- 登録: `src/tools/intervene.ts` に `orca_reply_message`(
  annotations `readOnlyHint: false` + `destructiveHint: false`)。登録数は 14 個。

### 12.3 テスト

- `commanderSpec` 固定テスト(座分離 + ask 承認の文言)、`extractMessages` /
  `toAskRow` の正規化(fixture 2026-10-22 実測)、poll の ask 受信(check 呼び出し引数
  `{"run": …, "mode": "peek", "types": ["question"]}` の固定 + 失敗 → warnings)、
  reply の順序 / `ask_not_found` / `ask_task_mismatch` / sub-run ask なし taskId /
  fenced → run-use → 再試行、schemas の strictObject。293 件すべて green
  (`npm run typecheck` / `npm run build` も通過)。

### 12.4 orca-artifacts 側(§8)

- §8 の行別修正表は **2026-10-22 に実装済み**(orca-artifacts リポジトリ PR #1、マージ
  `08cea34`)。AGENTS.md / README を座分離契約 + ask / reply に合わせ、ルート adr/ に
  `20261022-1350-follow-orca-mcp-seat-separation-and-reply.md`(前回 `20261018-1741` を
  supersedes)を追加。誤りと確定した旧記録(`orca_resolve_gate` での回答、30 分上限、
  `graceful`、`cancel requested` 自動送信)は ADR に列挙した。reqs/<ID>/ フォルダは
  依頼フローを通していないため設けていない。

## 13. 実機 E2E 記録(2026-10-22、ask → reply の MCP 経路)

scripts/e2e.mjs を ask 契約対応に更新して実機実行(runtime 1.4.229)。2 回走らせた。

### 13.1 走らせた経路(成功例: `run_5d8a736c0196` / Commander = codex)

1. `orca_delegate_task`(goal に「完了前に親 Run へ ask(--options approve,redo)で
   承認を求め、approve が返るまで --resume で待つ」を明記)→ `state: running`。
2. poll#3 から sub-run を発見(`run_093f793a0c47`、ownership は `verified` に確定)、
   子タスク 1 件が `children[]` に現れる。
3. poll#10 で **`asks[]` に ask が届き `phase: decision_gate`**(asker = 親 Run の
   Commander task、`fromHandle: "dispatch:ctx_…"`、`toHandle: "run:<親Run>"`)。
   行の形は §12.1 の fixture どおり(payload JSON 文字列の正規化も一致)。
4. `orca_reply_message({ messageId, body: "approve", run })` → `ok: true`。
5. 次の poll で `state: completed` / `phase: finished`。結果の `provenance: worker_report`
   には「**親 Run への ask は 1 回のみ、msg_a4abd33034ab に approve 回答を受領して
   追記を保持**」と明記されていた(asker 側が answer を消費した実機確認)。
6. 2 本目の cancel ジョブは `fullyStopped: true` で停止、`--cleanup` で子 worktree を削除。

§10 の 3 項目(子 Run 座からの ask 通達、子 Run 座からの worker_done、ask → reply の
MCP 経路 E2E)をこの 1 回で確認した。

### 13.2 E2E で見つかった欠陥と修正(実装済み、テスト 297 件 green)

- **完了 task の `assignee_handle` は null になる**(実測: 完了 task 行は
  `assignee_handle: null`)。そのままだと result / cancel の sub-run 照合が handle 無しで
  空になり、**完走後の result で `children: []` / `subRunsDiscovered: 0` になる**(実測)。
  → `commanderHandlesWithDispatch()` を追加: task 行に handle が無いときだけ
  `dispatch-show` の `assignee_handle`(完了後も残る)で補う。result と cancelTask の
  両方に適用。テスト: 完了 task でも dispatch-show 経由で sub-run の子を拾う /
  dispatch-show にも無ければ拾えない(handle 無し = 照合不能)。
- **reply の後も ask 行はしばらく受信箱に残る**(実測: 完了直後の poll で `asks=1` のまま)。
  2 回目の reply は `duplicate: false` / `answer_message_id: null` で**通ってしまう**
  (§12.2 が想定した「2 回目の reply は `duplicate: true` で冪等に返る」は実測と違う)。のちに(≈15 分後)
  peek / `--all` ともに行は消える(旧記録「回答済みは peek に現れない」はこの削除後の
  観測と整合)。→ poll は **asker task が終端(completed / failed / cancelled)の ask を
  `asks[]` と `kind: ask` から外し、warnings に記録する**。呼び出し Run の task-list に
  現れない sub-run 由来の ask は判定不能なので残す(回答待ちの可能性を捨てない)。
  クライアント側の規則も README に追記: 同じ ask への返信は 1 回に絞る。

### 13.3 副次の所見

- **claude Commander は 31 分間何もしなかった**(1 回目の E2E: `run_8e8a0f8a48e4`、
  poll 40 回すべて `children=0 / asks=0`、worker は `rawStatus: ready` / `activity: done` /
  出力 0 行、子 Run も ask も作らず、worker_done も無し。dispatch は `--cleanup` の
  worktree 削除(`operator_close`)で死んだ)。同 goal は codex では完走。
  → scripts/e2e.mjs の既定 commanderAgent は codex を明示して使う。原因(注入未達 /
  auth / モデル側の問題)は未確定で、§10 には載せない(別の再現待ち)。
- **E2E 後片付けの実機確認**: pane は cancel ジョブの Run にバインドされており、
  別 Run(`run_8e8a0f8a48e4`)への `task-update` が `consumer_fenced` で拒否 →
  `run-use --id run_8e8a0f8a48e4` → 再実行で成功。MCP の runMutation が実装する
  fenced → run-use → 再試行の手順がそのまま実機で効くことを確認した(残留 job の
  task は `failed` に確定)。
- scripts/e2e.mjs に **sweep cancel** を追加(期限到来でも 1 本目が完了していなければ
  cascade cancel。1 回目の E2E で残留 running job が残った教訓)。
