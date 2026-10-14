# sub-run 観測・取消の復元 — 実装計画

Status: 実装済み(2026-10-13 / 起案時の設計は §7 のとおり是正して実装した)
起案日: 2026-10-13
対象: orca-mcp Job API(v2, 11ツール → 実装後 13ツール)+ COMMANDER_PROMPT
目的: Commander が sub-run を作っても、caller の poll / cancel / 結果回収が壊れないようにする。

## 1. 問題(2026-10-13 HTTP 実機テストで確定)

`orca_delegate_task`(repo 省略, title=orca-cli-survey, agent=dsh)で起きたこと:

| # | 事象 | 証拠 |
|---|---|---|
| 1 | Commander(dsh)が sub-dispatch で `run-create` を実行し子 Run `run_8d1d20524d42` を作成。呼び出し側 Run は `run_6a42e93d341d`、Commander task は `task_7ec3d98f5473` | Commander の Thinking 実物。「Run ownership: Do not create new Runs」と Orca ガイド SUB-DISPATCH 節(`Bind your own Run first: run-create ...`)の矛盾を自行解釈で解決したと記述 |
| 2 | 子 Task 6件は `--parent task_7ec3d98f5473` **付き**で作成されていたが、親 run の `orca_get_task_status` は `childCount: 0` | 実測。task-list は run スコープのため |
| 3 | 子 ID(例 `task_7ad4247620dc`)の poll は `run=run_8d1d20524d42` を与えたときだけ成功。親 run 指定・run 無しはすべて `task_not_found (taskCount: 1)` | 実測 |
| 4 | orca-mcp に run 列挙ツールが無く、子 Run ID の発見経路が MCP 側に存在しない(UI の `worker-task_*` 名前か、prompt 文字列からの復元のみ) | ツール一覧(11個)に相当なし。CLI には `run-list` / `run-show` が**実在する** |
| 5 | cancel cascade は子 Run の worker に届かない可能性が高い(未実施だが構造上明白) | `orca_cancel_task` は task ツリー追跡、run を跨がない |

補足事実(guide 検証済み、`projects/orca-cli-guide/docs/orchestration.md`):

- `orca orchestration run-use --id <run_id> --json` — 「Bind this coordinator to an existing Run」。**準拠ルートは Orca に実在する**。
- `task-create` には `--run <run_id>` があり、バインド不要で既存 run に作れる。
- unbound terminal では run-scoped コマンドが `run_required` で失敗し、エラー文が「Use orchestration run-create or run-use first.」と **run-create を筆頭に勧げる**。dsh の逸脱はほぼ構造的必然。
- Run は `coordinator_handle`(作成者のターミナル handle)を持つ(`run-current --json` の `result.run.coordinator_handle`)。**sub-run 照合のキーとして使える**。

続報(クローズまでの実測、2026-10-14):

- Commander は sub-run 内に**自分の coordinator task**(例 `task_a9c5f6f06805`)も作成しており、**受信箱の実効宛先が sub-run 側に移動する**。呼び出し側から `run=<親run>` 宛の `send_message` は消費され続けた(capture #12)。
- `--to dispatch:<id>` の検証が run 指定によって**両方向に矛盾して失敗**した: `run=親` → 「dispatch is in 子Run」(recipient_run_mismatch)、`run=子` → 「dispatch belongs to 親Run」(dispatch_run_mismatch)。**Orca send 検証のバグ候補**。唯一通ったのは `to=<term_handle>` 直指定。
- worker_done は sub-run から**親 run へ正しく配送された**(lifecycle.action: completed)。報告経路は壊れない — 壊れるのは観測(§1 #2-5)と指令経路(inbox)。
- 子6件の結末: 3 succeeded + 3 failed(Claude 401 / API 同時要求タイムアウト)。**Commander が失敗分を直接執筆して回収**し、全成果物をコミット済みで worker_done(succeeded)。gate は caller の「merge/push 不要」指示で却下解決 — ゲート文言に上流指示を反映する運用が機能した。

## 2. 設計方針(3点セット)

観測の正しさは**ツール側で保証**し、プロンプトは「正しい手順 + 禁止 + 開示義務」を短く書く。自行解釈が起きても caller が壊れない状態を作る。

1. **run-list / run-show を MCP ツールとして公開**(`orca_list_runs` / `orca_get_run`)。
2. **sub-run 自動集約**: `get_task_status` と `cancel_task` が、Commander のターミナル handle を `coordinator_handle` に持つ run を発見し、その run 内の `parent == taskId` タスクを children / cascade に含める。Orca 本体を変えずに capture #9 を消す。
3. **COMMANDER_PROMPT 改修**: `{{runId}}` / `{{taskId}}` の注入と、Run ownership 節の手順書化(案A')。

## 3. フェーズ別実装

### Phase 1 — run-list / run-show ツール公開

- `src/orca/job.ts`(または `client.ts` の現行ラッパー様式に合わせる): `listRuns({limit?, cursor?})` → `orca orchestration run-list --json`、`showRun(runId)` → `run-show --id <id> --json`。
- `src/tools/runs.ts`(新規): `orca_list_runs` / `orca_get_run` を登録。既存 `src/tools/*.ts` の登録様式・エラー変換(`command.ts` 経由)に従う。
- `src/orca/schemas.ts`: 入出力型。run 要素は最低限 `{id, objective, coordinator_handle?, createdAt}`(実 JSON に合わせて緩く許容)。
- ツール説明文には「**run は poll/cancel の境界。子 Run を疑ったらこれで列挙する**」の趣旨を書く。

### Phase 2 — sub-run 自動集約

`getTaskStatus`(job.ts)強化:

1. 従来通り親 run で task を取得し children を集約(既存)。
2. **新規**: `childCount == 0` のときだけ追加探索(通常系のコスト増を避けるヒューリスティック。要否は後述 §5)。
   - `listRuns()` → `coordinator_handle ∈ {assigneeHandle, workers[].terminalHandle}` の run を抽出(自分自身 = 親 run は除外)。
   - 各 sub-run で `task-list --run <sub>` → `parent == taskId` のタスクを `children[]` にマージ。
   - マージ要素に `sourceRunId: <subのrunId>` を付与(ツール説明文・README に記載)。
3. gates は sub-run のものも併記(`gate-list --run <sub>`)。resolve_gate は既に `run` 引数を取り、親 run 名義で解決できることを実測済み。

`cancelTask`(job.ts)強化:

- cascade 対象を「task ツリー ∪ (coordinator_handle 照合した sub-run 内の `parent == taskId` サブツリー)」に拡張。子から順に既存の worker-stop → task-update(failed/cancelled)手順を复用。
- cancel 結果に `subRunsDiscovered: [runId...]` を含め、何処まで止めたか監査可能にする。

### Phase 3 — COMMANDER_PROMPT 改修

`commanderSpec`(job.ts L695 付近):

```diff
   return COMMANDER_PROMPT
     .replace("{{goal}}", input.spec)
     .replace("{{repo}}", input.repo ?? "the current repository")
-    .replace("{{constraints}}", constraints);
+    .replace("{{constraints}}", constraints)
+    .replace("{{runId}}", runId)
+    .replace("{{taskId}}", taskId);
```

**順序の注意**: 現状 spec は task-create の内容として作るが、`taskId` は task-create **後**でしか分からない。`delegateTask` の流れを

1. run-create → 2. task-create(spec はプレースホルダのまま or 仮)→ 3. `task-update --spec`(runId/taskId を埋めた最終版)→ 4. worker-start

に変更するか、worker-start 時に spec を上書きできるならそちら。実装時に Orca の対応コマンドを確認して選ぶこと(未確認事項 §5-c)。

Run ownership 節(`COMMANDER_PROMPT` L676-680)差し替え(案A' 最終):

```diff
 Run ownership:
-You are already dispatched inside a Run and a task. Do not create new Runs.
-Create child tasks with --parent set to your task, inside your own Run, and
-delegate them to supervised workers. A new Run fragments the job the caller is
-polling and cancels.
+The caller polls, collects results and cancels through exactly ONE Run: {{runId}}.
+Your task is {{taskId}}, inside it.
+
+Before creating any child task, bind your terminal to that Run:
+
+  orca orchestration run-use --id {{runId}} --json     # verify with: run-current
+
+(Or pass --run {{runId}} on each task-create / worker-start.)
+Only after the binding is confirmed, create child tasks with --parent {{taskId}}.
+
+Never run `run-create` for sub-workers: children belong in {{runId}}, which is
+the only Run the caller's polling, cancel cascade and gates cover automatically.
+If you see "No Run is bound. Use orchestration run-create or run-use first.",
+that means run-use — NEVER run-create. If binding keeps failing, do not
+improvise: finish what you can inside {{runId}} and report the blocker.
+If you ever did create another Run, list its exact id in your final report.
```

- 旧文の「invisible」主張は廃す(run-list 公開後は事実と異なる)。自動カバレッジの話に言い換え済み。
- `run-create` を勧げる CLI エラー文への先回り指示を実句で書き込む(dsh の逸脱経路の実測に基づく)。

### Phase 4 — テスト

ユニット(`tests/job.test.ts` 追加、既存の fake CLI 応答様式):

- `listRuns` / `showRun` のコマンド組み立てと JSON パース。
- sub-run 集約: coordinator_handle 一致/不一致/親 run 自身除外/parent フィルタ/`sourceRunId` 付与の子供マージ。
- cancel cascade が sub-run タスクを含む順序(子→親)で実行されること。
- `commanderSpec` に runId/taskId が注入され、`{{...}}` が残らないこと。
- プロンプト回帰: Run ownership 節に `run-create` 禁止と `run-use` 手順の文言が存在すること(文字列アサートで十分)。

ライブ/スモーク(`scripts/` に追加 or e2e.mjs 拡張、**実機のみで確認できる項目**):

1. 小 spec で delegate → Commander が sub-dispatch するまで待つ → **親 run の poll で `childCount > 0` / `children[].sourceRunId`**。
2. その状態で `orca_cancel_task`(cascade)→ sub-run の worker terminal が実際に止まることを `list_agents` で確認。
3. 意図的に `run-create` させた逸脱ケース(プロンプトで指示)→ `orca_list_runs` で発見でき、レポート開示義務の文言が守られるか目視。

### Phase 5 — ドキュメント

- README: ツール表を 13 に、sub-run 集約と `sourceRunId` の挙動、run 境界の説明を追記。
- 本ファイルを Status: Implemented に更新 or supersedes 相当の ADR があれば repo 慣習に従う。

## 4. 完了条件(受け入れ基準)

1. Commander が sub-run を作っても、親 run の `get_task_status` で children が全て見える(`sourceRunId` 付き)。
2. `orca_cancel_task` cascade で sub-run の worker が止まる(実機確認)。
3. 新ツール 2 つが tools/list に現れ、HTTP/stdio 両トランスポートで動作。
4. COMMANDER_PROMPT に runId/taskId が注入され、プレースホルダ漏れがない。
5. 既存テスト全通過 + 上記新規テスト。

## 5. 未確認事項・リスク(実装前に潰す)

- a. `run-list` の page 挙動と応答サイズ(`--limit/--cursor`)。poll 毎の追加 CLI コスト — 「childCount==0 のときだけ」で足りるか、`aggregateSubRuns: false` オフセット引数の要否。
- b. `coordinator_handle` の一意性。ターミナル reuse / takeover-legacy で別 job の run が誤マッチしないか。マッチ時に objective/createdAt も併せて検証する安全策を入れる。
- c. task-create 後の spec 書き換え手段(`task-update --spec` の有無)または worker-start での spec 上書き可否。**未確認。実装のブロッカー候補なので最初に検証**。
- d. `worker-start` に `--run` があるか(task-create にあるのは確認済み)。プロンプトの括弧書きを実在に合わせて修正。
- e. Orca 側の別件バグ(本計画のスコープ外・報告のみ): worker preamble の task ID 表記に不正な末尾が付く(`task_...he`、capture #7)。ID を鵜呑みにさせる UI/プロンプト改善として Orca へ報告。

## 6. スコープ外

- Orca 本体の run lineage(`parentRunId`)実装 — 対称性としては正しい位置だが、今回の照合ハックで実用上足りるため要求として分離。
- worker の claude 承認プロンプト停止(capture #11)— 検知はできており解除は UI 前提。別件。
- ORCA_MCP_AUTH_TOKEN の強度(4文字)更新 — デプロイ運用の話。

## 7. 実装時のレビューで確定した事実(起案の設計をここへ是正した)

実機 `orca 1.4.222` の `--help` と live JSON で検証した。起案のままだと直らない部分があった。

| # | 起案 | 実測で確定した事実 | 実装 |
|---|---|---|---|
| 1 | §1-2「子 Task 6件は `--parent task_7ec3d98f5473` 付きで作られていた」 | **事実では無い**。`task-list --run run_8d1d20524d42` の 7 件は root `task_a9c5f6f06805`(`parent_id: null`)+ 子 6 件の `parent_id` は **その root**。呼び出し元 Run の Commander task を指す行は 1 件も無い | Phase 2 の「sub-run 内で `parent == taskId`」は 0 件しか拾えない。照合は `coordinator_handle` → sub-run 内の **root 特定**(`parent` が run 内に無い + `created_by_terminal_handle` が Commander の handle)に置き換えた |
| 2 | §5-c「`task-update --spec` の有無がブロッカー候補」 | **存在しない**。`task-update` は `--id / --status / --result / --run / --from / --retry-request` のみ(valid status: pending / ready / dispatched / completed / failed / blocked) | Phase 3 の「task-create 後に spec 書き換え」は不可能。`{{taskId}}` は注入しない(`worker-start --spec` でも taskId は起動後に決まるため鶏卵)。`{{runId}}` だけ注入し、自分の task id は dispatch preamble と `task-list --run <run>` で確認させる手順にした |
| 3 | §5-d「`worker-start` に `--run` があるか」 | **ある**(`--task` / `--spec` / `--run` / `--parent` / `--deps` を確認) | プロンプトの `worker-start --run {{runId}} --task <child>` は実在の構文 |
| 4 | §5-a「`run-list` の page 挙動」 | 応答は `result.runs[]` + `result.nextCursor`(base64 の keyset `{createdAt,id}`)。help 文の「line cursor」は実体と違う | 当初は `--limit 50` 1 回(ページング無し)。§8 の P3 で `nextCursor` を辿るページング(`MAX_SCAN_PAGES = 5`)に置き換え、打ち切りは `subRunScanComplete: false` + warning で正直に出す |
| 5 | §5-b「`coordinator_handle` の一意性」 | live で 5 件中 2 件が `coordinator_handle: null`。terminal 再利用で古い Run が同じ handle を持つリスクは残る | null は照合不能として除外。呼び出し元 Run 自身を除外。対象タスクの `created_at` より **24 分以上前**の Run を除外(task-list はローカル時刻、run-list は UTC なので厳密比較しない)。上限 `MAX_SUB_RUNS = 3` |
| 6 | Phase 2 が poll / cancel のみ | 目的は「poll / cancel / **結果回収**」なのに `orca_get_task_result` が抜けていた | result にも sub-run 集約を入れた(`includeChildren: true` 時に合算、`sourceRunId` 付き) |
| 7 | 「`childCount == 0` のときだけ追加探索」 | 親 Run にも sub-run にも子がある場合、childCount > 0 で sub-run が invisible のまま残る | 探索条件を「worker / dispatch が 1 件以上あるとき」に変更(queued では走らせない)。`includeSubRuns: false` で無効化できる |
| 8 | — | `run-list` / `run-show` は読み取り専用なので poll ハンドラーで呼んでよい(AGENTS.md の「poll / result の読み集め」) | 変更系(run-use 等)は sub-run 集約では呼ばない。cancel の task-update だけ対象 run 名義 |
| 9 | 「Gate 作成に失敗し、Commander が独力で処理する事態が発生した」(review8 §7.1 の前提) | **Gate 作成は成功していた**。`gate_e3de81e4d0d4` は sub-run `run_8d1d20524d42` の `task_a9c5f6f06805` に `status: pending` で存在し、呼び出し元 Run `run_6a42e93d341d` の `gate-list` は 0 件だった(2026-10-13 作成 → 2026-10-14 現在も pending)。事故は「作れない」ではなく「**sub-run の Gate が呼び出し元から見えなかった**」 | gate 行に `runId`(行の `run_id` 優先、無いときは照合 Run 名義で補完)、`blockedReasons[].detail.runId` を追加。`orca_resolve_gate` は gateId と run の組が一致しなければ `gate_run_mismatch` で**変更前に**拒否する |

### 実装で追加した応答フィールド

- poll: `subRuns[]`(runId / objective / coordinatorHandle / taskCount / rootTaskIds)、`subRunsDiscovered`、children 行の `sourceRunId`
- poll: gates 行の `runId`(ゲートの所属 Run)、gate 由来 `blockedReasons[].detail` の `gateId` / `runId` / `options`
- cancel: `subRunsDiscovered` / `subRuns`、tasks 行の `runId`、上限判定は sub-run 込みの件数
- result: `subRunsDiscovered` / `subRuns` / `warnings`、children 行の `sourceRunId`

### 残る既知の限界

- 孫以降(sub-run 内の sub-run)は `children` に出さない(呼び出し元 Run の direct children semantics を保つ)。
- `coordinator_handle` 照合は run lineage が無いことへの代替ハック。Orca 本体に `parentRunId` が入れば §6 の要求へ置換できる。
- gate 行の `runId` は CLI の `run_id` を優先する。行に `run_id` が無い CLI 版では「そのゲートを照合した Run」名義の
  補完になるため、sub-run 集約が動かない環境(caller gate のみ)では呼び出し元 Run 名義で返る。

## 8. review9 承認後の P1–P6 実装(2026-10-14)

review9 の「条件付き実装承認」(`orca-mcp_review9.txt` §2–§7)どおりの実装記録。P7(`orca_get_run` の include*)は
レビュー9 の指示どおり延期した。

| Phase | 実装 | 要点 |
|---|---|---|
| P1 | `COMMANDER_PROMPT` の Run ownership / gate 手順を改修 | 既存 Run を再利用 / 深さ・circuit-break・失敗 dispatch・binding 回避で Run を作らない / `run-use --takeover-legacy` は別操作(新しい Run を作る許可ではない)/ 自律 coordinator が child Run を作れるのは guide が許すときだけ + objective マーカー + 最終報告 / gate 作成失敗は binding 確認 → 1 回だけ安全に再試行 → だめなら承認を進めず停止して人間に依頼 |
| P2 | 所有関係の判定 `classifySubRunOwnership` | `verified` は coordinator_handle + pane key + incarnation の 2 系統一致・矛盾なし。objective マーカー(`SUB_RUN_MARKER_PREFIX`)は**発見の候補**で、単独では `verified` にしない(誰でも書ける)。別 Run を指すマーカーは `conflicting` |
| P3 | `scanRunRows` / `scanWorkerRows` の cursor ページング | `MAX_SCAN_PAGES = 5` / `MAX_WORKER_PAGES = 3`。打ち切りは `subRunScanComplete` / `subRunsTruncated` / `subRunScanPageCount` / `subRunScanRunCount` / `subRunOwnershipComplete` と warning で出す |
| P4 | cancel の対象を `verified` に限定 | 検証失敗の sub-run が 1 件でもあれば preflight で `cancel_ownership_unverified`(**破壊的操作ゼロ**)。逃げ道は `includeSubRuns: false` / `cascade: false`。同一 dispatch は 1 回だけ(`fencedDispatchIds`) |
| P5 | 停止後の読み直し `residualLiveWorkers` | 生存 worker を `residualWorkers[]` に載せ、1 件でもあれば `fullyStopped: false`。探索を打ち切った場合も `fullyStopped: false` |
| P6 | gate 作成失敗時の手順を prompt に固定 | 「gate 作成失敗 → binding 確認 → 安全な再試行 → 失敗 → 停止して人間に依頼」までを書き、承認の代행을禁止 |

- 来歴の対応表は `terminal list`(`handle` / `tabId` / `leafId` / `ptyId` / `incarnationId`)から作る 1 回だけ。
  読めなければ `verified` を出さない(警告だけ添えて `probable`)。
- 実測で一致した来歴(2026-10-14、`run_8d1d20524d42` の root と Commander terminal):
  `created_by_pane_key == tabId:leafId`、`created_by_process_incarnation == ptyId:incarnationId`。
- 未実施: P7(観測 API の include* 拡張)、P8 の実機 E2E(gate 解決 / cancel の実走)。
  実機 E2E は `gate_e3de81e4d0d4`(master merge / push の承認)を解決する操作を含むため、人間の承認なしには走らせない。

### 8-1. P8 実機 E2E(2026-10-14、claude / repo orca-mcp / 子 worktree 隔離)

`gate_e3de81e4d0d4` には一切触れていない(新規ジョブ自身のゲートだけを解決した)。

| 実行 | 内容 | 実測 |
|---|---|---|
| 検証 A(`scripts/observe-subrun.mjs`) | 既存の sub-run を read-only で観測 | `subRunScanPageCount 2` / `subRunScanRunCount 82`(50+32 を cursor で読み切り)、`run_8d1d20524d42` の `ownership: verified`(`pane key` と `process incarnation` 一致)、`gates[0].runId = run_8d1d20524d42`、`warnings: []` |
| E2E #1(`scripts/e2e.mjs`) | submit → poll → result → cancel(README のみ変更 goal) | `task_a5dc3b5f18b1 / run_ec6d76009ca2` が 15 poll(~11 分)で completed。`subRunScanComplete: true`(2 ページ / 83 件)、`subRunsDiscovered: 0`。cancel 用ジョブは `cancelled: true` / `fullyStopped: true` / `residualWorkers: []`、cancel 後 `state: failed`(= cancelled) |
| E2E #2(gate 強制 goal) | gate-create を作らせる goal で poll → gate 解決 | Commander が `gate_8888c7461b08` を **呼び出し元 Run(`run_52e3ee6a9aec`)内に**作成(poll の `gates[].runId` と `blockedReasons[].detail` に出る)。解決は初回 `run_required`(後述)で失敗し、`run-use` 復旧後に `status: resolved` で成功 → 子タスクが `queued` へ進んだ |

- **実測で出たバグと修正**: gate-resolve が `run_required`("No Run is bound. Use orchestration
  run-create or run-use first.")で落ち、`runMutation` が `consumer_fenced` しか復旧しなかった。
  バインドは pane の実体化で失われる(委譲成功後の gate-resolve で発生)。`runMutation` は
  `run_required` / "No Run is bound" も `run-use` + 1 回再試行の対象に含めた(§8-1 の E2E #2 で復旧を実証)。
- **バインドはターミナル共有の状態**(プロセスをまたいで動く)。E2E #2 では 2 本目の delegate が
  同じターミナルを別 Run へ再バインドしたため、後から別プロセスで解決すると `Gate not found` になった。
  「ゲートの Run を名指しで `run-use` して、そのまま同じプロセスで解決する」が正解(実測で成功)。
- 残る未検証: sub-run を**作る** goal での verified 判定(検証 A が実データで確認済み)、
  `cancel_ownership_unverified` の実機発火(ユニットテストで固定)。

### 8-2. review10 対応後の実機 E2E(2026-10-14、§9 の Fix 判定)

review10 §135 の「既存 pending Gate を変更せずに観測する E2E」と「テスト専用 Gate を作成・解決する E2E」を走らせた。
`gate_e3de81e4d0d4` は観測のみで一切解決していない。

| 実行 | 内容 | 実測 |
|---|---|---|
| 観測 E2E(`scripts/observe-subrun.mjs`) | 既存ジョブ `task_15a13a6091a7 / run_52e3ee6a9aec` を read-only で観測(変更系コマンド 0 回) | 終了コード 0。`subRunWorkerScanComplete: true`(新フィールド)、`subRunScanPageCount 2` / `subRunScanRunCount 86`、`gates[0] = gate_8888c7461b08 resolved`、`warnings: []` |
| E2E #3(`scripts/e2e.mjs`、gate 強制 goal) | submit → poll → gate 解決(taskId 付き)→ result → cancel | `task_c933ef99db6d / run_038410b6f8a1`。poll#22 で child `task_4a614dd1d2e3`、poll#23 で `phase: decision_gate` / `gate_fc673fa1c76a` を**呼び出し元 Run 内に**検出し `taskId` を渡して解決(`isError: false`)→ 子 completed → Commander completed(`provenance: worker_report`、`filesModified: ["README.md"]`)。`subRunScanComplete: true`(2 ページ / 88 件)、`subRunWorkerScanComplete: true` |
| E2E #3 の cancel ジョブ | `task_bb5c7d4f1b24` を cascade cancel | `cancelled: true` / `fullyStopped: true` / `residualWorkers: []` / `cancelErrorCode: null`(=`cancel_discovery_incomplete` は発火せず)、cancel 後 `state: failed` |

- 新フィールドは result 応答にも出ている(`subRunScanComplete` / `subRunWorkerScanComplete` / `subRunOwnershipComplete`)。
- 未発火の実機検証: `cancel_discovery_incomplete`(ユニットテストで固定)。`gate_task_mismatch` は §11 で実機発火を確認した。
  自 task への gate-create は `task_not_startable`(実測で 2 回目)なので、ゲートは子 task に作られる。

## 9. review10 対応(2026-10-14、cancel 周辺と gate の境界)

review10 が「Fix 前に優先して修正すること」と挙げた 3 点への対応。テストは 262 → **268**。

| # | 指摘 | 対応 |
|---|---|---|
| 1 | worker 一覧のページングが途中で終わっても検知できない | `scanPaged()` に集約し **完走判定と `stopReason` を返す**(`page_limit` / `has_more_without_cursor` / `cursor_repeat`)。worker 側は `subRunWorkerScanComplete` に載せ、cancel は打ち切り時に `fullyStopped: false`。停止後の読み直しは読めない/打ち切った Run を `residualWorkers[]` に `status: "scan_incomplete"` として残す |
| 2 | cancel 前の worker 一覧取得失敗が握りつぶされる | 失敗を `discoveryFailures` に保持し(従来は `captureSubRuns` の結果で上書きされて消えていた)、cascade + includeSubRuns の構成では **preflight で `cancel_discovery_incomplete` を返して変更ゼロ**。対象は 呼び出し元 Run の worker-list 失敗・ページング打ち切り・worker がいるのに handle が取れない・sub-run 探索の run-list 失敗。逃げ道は `cascade: false` / `includeSubRuns: false` |
| 3 | gate 解決の job 所有権を検証していない | 認可の前提を README / AGENTS.md / ツール説明に明文化(単一ユーザー・信頼クライアント前提、HTTP 公開はトークン必須で承認権限は運用側)。`orca_resolve_gate` に任意の `taskId` を追加し、指定時はゲートの task がその task または `task-create` 部分木に属さなければ `gate_task_mismatch` で**変更前に**拒否(既定の挙動は変えない = 既存 API との互換) |

- ページング異常のテスト: 同じ cursor が戻る応答は 2 ページで打ち切り(`cursor_repeat`)、
  `page.hasMore: true` に対して `nextCursor` が無い応答は打ち切りとして warning に出す。
- 打ち切りの worker scan を持つ cancel は `subRunWorkerScanComplete: false` + `fullyStopped: false`
  (`residualWorkers[]` に `scan_incomplete`)で返ることをテストで固定。

## 10. review11 対応(2026-10-14、cancel の安全側判定)

review11 は §1・§2 を「修正済み」と評価し、残る 3 点(優先度順)を挙げた。テストは 268 → **271**。

| # | 指摘 | 対応 |
|---|---|---|
| 1 | `workerList` が使えないときに cancel が進み、完全成功を返せる経路が残っている | 探索の前提から「走れない」を除外しない。cascade + includeSubRuns の構成では **client に workerList / runList が無い**、**呼び出し元 Run が特定できず worker-list を読めない** も `cancel_discovery_incomplete` の理由にして変更ゼロ(逃げ道は `cascade: false` / `includeSubRuns: false`) |
| 2 | gate の `taskId` 照合は任意の誤操作防止であり厳密な認可ではない | README・AGENTS.md・ツール説明・schema 説明に「`taskId` 省略時は点検しない / Run をまたぐ親子関係は検証しない」を明記 |
| 3 | 異常系の回帰テスト | 追加: 呼び出し元 Run の worker-list がページ上限 → cancel 前に拒否(変更ゼロ)、`workerList` 不在の client で cascade cancel を断る(cascade: false は通す)、worker-list を読み直せる Run が無い cancel は `fullyStopped: false`。既存の fence 失敗テスト 3 件は探索前提(worker-list / run-list)を備えた client に更新 |

- 停止後の読み直しも安全側に寄せた: 読み直せる Run が 1 つも無い場合は検証不能として `fullyStopped: false` + warning。
- review11 の次段階の提案(実機 E2E で「sub-run 内の gate 検出 → 解決 → Commander 再開」と「sub-run を含む cancel」)を
  2026-10-14 に実機で回した。結果は §11。

## 11. review11 対応後の実機 E2E(2026-10-14、sub-run を意図的に作る goal)

goal: Commander に `run-create` で sub-run を作らせ、その Run 内に gate を配置させ、解決後に README へ追記させる
(`task_b89398db9e90` / `run_33d5cf3391b1`、sub-run `run_98b5cc233180`、child `task_a6b0ca486935`、gate `gate_21c198d36a6a`)。

| 観測 | 結果 |
|---|---|
| sub-run 発見 | poll#13 で `subRunsDiscovered: 1`、scan 2 p / 90 runs、`subRunWorkerScanComplete: true` |
| 所有検証 | poll#13 は `subRunOwnershipComplete: false`(root 来歴が揃う前)→ poll#14 以降 `true`(`verified`)。cancel 対象の条件が実機で機能した |
| sub-run の gate 検出 | poll#17 で `phase: decision_gate` / `gates: 1`、`gates[0].runId = run_98b5cc233180`(呼び出し元 Run と違う Run のゲートを拾った) |
| gate 解決 | **`gate_task_mismatch` で連続拒否**。ゲートの task は sub-run 内の `task_a6b0ca486935` で、呼び出し元 Run の Commander task の部分木に属さない — review11 §3 の「Run をまたぐ親子は検証できない」が実機で出た |
| sub-run を含む cancel | sub-run の child は `cancelled`(`run_98b5cc233180` 名義で確定)。Commander の `task-update` は `task_not_startable`("cannot move to failed while supervised Dispatch ctx_92e039fe1ec8 is active")で落ち `cancel_incomplete` |

是正(テスト 271 → **272**):

- **`worker-stop` の `stop_unknown` を停止成功に数えていた**: receipt は `state: "stop_unknown"` /
  `processAction: "none"` なのに dispatch は active のまま。旧実装は fence 成功として `fullyStopped: true` と
  報告し、後続の `task-update` が CLI に拒否された = 停止漏れを成功と報告していた。
  `UNCONFIRMED_FENCE_STATES`(`stop_unknown / abandon_unknown / unknown / failed / error`、状態無しを含む)を
  fence 失敗として数え、`cancel_incomplete`(`fullyStopped: false`)+ warning に落とすよう直した
- **`gate_task_mismatch` のメッセージに sub-run の逃げ道を明記**(「sub-run のゲートは呼び出し元 Run の
  task 部分木に属さないので taskId を外して解決する」)。README のトラブルシュートにも同じ根拠を追記
- **`scripts/e2e.mjs` はゲートの所属 Run が呼び出し元 Run と違うとき `taskId` を渡さない**
  (sub-run のゲートは点検させない)。ログには `taskId=none(sub-run)` を出す
- **`mode: "abandon"` は同じ job で完走した**(2026-10-14 実測): stop 版は `stop_unknown` → `cancel_incomplete`、
  abandon 版は `abandoned` → `cancelled: true` / `fullyStopped: true` / `residualWorkers: []`。
  `worker-abandon` はプロセス停止を主張しない fence なので、CLI が task 確定を拒否しない
