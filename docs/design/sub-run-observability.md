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
| 4 | §5-a「`run-list` の page 挙動」 | 応答は `result.runs[]` + `result.nextCursor`(base64 の keyset `{createdAt,id}`)。help 文の「line cursor」は実体と違う | `--limit` / `--cursor` を client に実装。poll 側は `--limit 50` 1 回(ページングしない) |
| 5 | §5-b「`coordinator_handle` の一意性」 | live で 5 件中 2 件が `coordinator_handle: null`。terminal 再利用で古い Run が同じ handle を持つリスクは残る | null は照合不能として除外。呼び出し元 Run 自身を除外。対象タスクの `created_at` より **24 分以上前**の Run を除外(task-list はローカル時刻、run-list は UTC なので厳密比較しない)。上限 `MAX_SUB_RUNS = 3` |
| 6 | Phase 2 が poll / cancel のみ | 目的は「poll / cancel / **結果回収**」なのに `orca_get_task_result` が抜けていた | result にも sub-run 集約を入れた(`includeChildren: true` 時に合算、`sourceRunId` 付き) |
| 7 | 「`childCount == 0` のときだけ追加探索」 | 親 Run にも sub-run にも子がある場合、childCount > 0 で sub-run が invisible のまま残る | 探索条件を「worker / dispatch が 1 件以上あるとき」に変更(queued では走らせない)。`includeSubRuns: false` で無効化できる |
| 8 | — | `run-list` / `run-show` は読み取り専用なので poll ハンドラーで呼んでよい(AGENTS.md の「poll / result の読み集め」) | 変更系(run-use 等)は sub-run 集約では呼ばない。cancel の task-update だけ対象 run 名義 |

### 実装で追加した応答フィールド

- poll: `subRuns[]`(runId / objective / coordinatorHandle / taskCount / rootTaskIds)、`subRunsDiscovered`、children 行の `sourceRunId`
- cancel: `subRunsDiscovered` / `subRuns`、tasks 行の `runId`、上限判定は sub-run 込みの件数
- result: `subRunsDiscovered` / `subRuns` / `warnings`、children 行の `sourceRunId`

### 残る既知の限界

- 孫以降(sub-run 内の sub-run)は `children` に出さない(呼び出し元 Run の direct children semantics を保つ)。
- `coordinator_handle` 照合は run lineage が無いことへの代替ハック。Orca 本体に `parentRunId` が入れば §6 の要求へ置換できる。
