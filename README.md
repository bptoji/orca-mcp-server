# orca-mcp

[Orca](https://github.com/stablyai/orca) の CLI(`orca`)を MCP 経由で操作するための
MCP サーバーです。**コーディングのゴールを Commander エージェントと supervised な
マルチエージェントワーカーへ委譲する、Orca CLI のオーケストレーションゲートウェイ**として、
タスク委譲・進捗確認・判断ゲート解決・キャンセルを MCP クライアント
(Claude Code / Claude Desktop / dsh など)から利用できます。

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
低レベルすぎる API(`orca_create_worktree` / `orca_start_agent` / `orca_send_terminal` など)は
外部に出さず、内部実装に隠しています。

### Job API

| ツール | 役割 | 内部で呼ぶもの | 待つ? |
| --- | --- | --- | --- |
| `orca_delegate_task` | **submit**(Commander API) | run-create(未指定時) → task-create(固定 Commander 指示 + goal + repo + constraints) → supervised worker-start | 待たない |
| `orca_get_task_status` | **poll** | task-list / dispatch-show / worker-list / gate-list | 待たない |
| `orca_get_task_result` | **result** | task-list / dispatch-show / worker-read | 待たない |

```
orca_delegate_task({
  spec: "ユーザー認証機能を追加する",
  repo: "name:my-project",
  constraints: ["既存APIを変更しない", "テストを追加する", "マージはしない"]
})
  → { "taskId": "task_abc123", "state": "running", "runId": "run_…",
      "commander": true, "commanderAgent": "codex", "dispatchId": "disp_…",
      "target": { "kind": "supervised_worker", "worktree": "new-child", "agent": "codex" },
      "warnings": [], "nextAction": "poll with orca_get_task_status({ … })" }

orca_get_task_status({ taskId: "task_abc123" })
  → { "taskId": "task_abc123", "state": "running", "phase": "implementation",
      "rawStatus": "dispatched",
      "commander": { "agent": "codex", "status": "running", "dispatchId": "disp_…" },
      "workers": [ { "agent": "codex", "status": "running", "dispatchId": "disp_…" } ],
      "childCount": 2, "returnedChildCount": 2, "childrenTruncated": false,
      "children": [
        { "taskId": "task_backend", "title": "Implement backend", "state": "completed",
          "workers": [ { "agent": "claude", "status": "completed", "dispatchId": "disp_…" } ] },
        { "taskId": "task_tests",   "title": "Write tests",       "state": "running",
          "workers": [ { "agent": "codex", "status": "running", "dispatchId": "disp_…" } ] }
      ],
      "gates": [], "attentionRequired": false, "attentionNotes": [],
      "nextAction": "poll again with orca_get_task_status" }

orca_get_task_result({ taskId: "task_abc123", includeChildren: true })
  → { "state": "completed", "result": "認証機能を実装しました",
      "outputs": [ { "dispatchId": "disp_1", "source": "transcript", "text": "…", "cursor": "…" } ],
      "includeChildren": true, "childrenTruncated": false,
      "children": [
        { "taskId": "task_backend", "state": "completed", "result": "backend done",
          "outputs": [ { "dispatchId": "disp_…", "agent": "claude", "text": "…" } ] },
        { "taskId": "task_tests",   "state": "completed", "result": "tests green",
          "outputs": [ { "dispatchId": "disp_…", "agent": "codex", "text": "…" } ] }
      ] }
```

- `state`: `queued / running / blocked / completed / failed / cancelled`(CLI 生の値は `rawStatus`)
  - **`cancelled` は MCP 側の論理状態**。Orca 側の task は `status: failed` + `result: "cancelled: <reason>"`
    で記録される(CLI に native の `cancelled` status が無いため)。デバッグで task 行を見るときは
    `failed` として見える前提で読んでください
- `phase`: `queued / starting / implementation / decision_gate / settling / finished`
  (Commander 配下の worker も含めて推定する)
- worker-start だけ失敗しても **タスクは生き続ける** → `state: "queued"` + `warnings` で返す
- CLI 側の失敗はコードごと転送する(例: `run_not_found` + `data.orchestrationRequestId`)
- `children` は Commander が `task-create` で分解した**直接の子タスク**(direct children、`parent_id` が
  対象タスクと一致するもの)とその worker。1 回の poll で「Commander の下で何が起きているか」が見える。
  `childCount` は実件数、`returnedChildCount` が返した件数(上限 20)、`childrenTruncated` で打ち切りを伝える
- **孫以降(deep DAG)は `children` に現れない**。Commander → child A → grandchild A-1 のような深い構造では、
  A-1 は child A 自身の poll / result で見る。Commander Prompt は「深い連鎖より並列の波」を推奨しているので
  MVP では direct children だけで十分としている
- `attentionRequired` / `attentionNotes` は worker 側の「人間側の対応が必要そう」の合図
  (`projection.attention.requiresAction`)。ゲートが pending でないのに progress が止まる典型は、
  エージェントのターミナルに出る**ツール承認プロンプト**で worker が止まっているケース
  (E2E で `orca skills get orchestration --full` の承認待ちにより `running` のまま停止した)。
  `attentionNotes` の `terminal(read) で確認` をたどってください
- `orca_get_task_result` は既定で Commander だけ読む。`includeChildren: true` で**直接の子タスク**の
  `result` と出力も集約する(子 10 件・worker-read 8 件まで)。孫以降は集約しない

#### Job API における委譲の仕組み

`orca_delegate_task` は、外部Agentから受け取ったゴールを Orca 内の Commander Agent に渡す非同期 API です。Commander Agent がゴールを解釈してタスクを分解し、必要に応じて複数の supervised Worker（サブエージェント）へ差配します。

```text
外部Agent
  → orca_delegate_task
  → Commander Agent
      → タスク分解・Worker選択・並列実行・レビュー
      → supervised Worker（Codex / Claude など）
```

通常の利用では、ゴールと必要な制約だけを渡してください。個々の Worker を直接選択・起動することは、この API の利用者側では行いません。`orca_delegate_task` は **常に Commander を起動する API** で、既存の `terminal` / `worktree` への直接 dispatch は受け付けません(schema が拒否する)。低レベルな直接 dispatch が必要なら内部用の `tools/delegate.ts` を使ってください。

内部では `run-create`（run 未指定時）→ `task-create`（固定の Commander 指示 + goal + repo + constraints を spec へ焼く）→ `worker-start --worktree new-child --agent <commanderAgent>` の順で Commander を起動します。完了を待たずに返された `taskId` を使って `orca_get_task_status` で進捗を確認し、完了後に `orca_get_task_result` で結果を取得してください。

Commander への指示には、Orca 公式の推奨として「orchestration を変更する前に `orca skills get orchestration --full` で現在のバージョンに合った guide を読む」節を固定で焼いています(CLI flag はバージョンで変わるため、記憶した構文を使わせない)。

`worker-start` が失敗した場合もタスクは保持され、`state: "queued"` と `warnings` が返ります。
`queued` は放置しても進みません(dispatch が無い = Commander 未起動)。`orca_get_task_status` の
`nextAction` が「delegate し直すか cancel する」を明示するので、そのどちらかを選んでください。
`worker-start` は worktree 作成 + setup hook + エージェント起動 + 初ターン観測まで同期で走るため、
このコマンドだけ transport 側の timeout を **180 秒**に広げています(既定 30 秒では SIGKILL された実測あり)。

**`repo` は repo セレクタで渡す**(E2E で実機確認)。`id:<repoId>` と `path:<repo home>` は解決できるが、
**worktree の displayName(`name:weever`)や worktree の path は `repo_not_found`** になる
(worktree ではなく repo 側で解決されるため)。現在の worktree から選ぶには
`orca worktree current --json` の `result.worktree.repoId` を使ってください。

**`commanderAgent` は「注入されたプロンプトを非対話で消費できるエージェント」である必要がある**
(E2E 実機確認)。`worker-start --agent` は Orca 側で設定されたエージェント名のみ受け付ける:

- `claude` / `codex` — supervised worker として動作する(実機で worker 契約の確認まで完了)
  - `claude`: タスク遂行は問題なし。`orca skills get …` などの**ツール承認プロンプト**で止まりやすい
  - `codex`: 注入された preamble + TASK を消費し、`worker_done` を `--outcome` / `--task-id` /
    `--dispatch-id` 付きで正しく組み立てる。ただし `orca orchestration send` 実行前に
    **Codex 側の承認プロンプト**が出て、承認されるまで報告が届かない
    (初回プロンプトも composer に置かれるだけで、Enter が必要だった)
- `dsh` — 起動はするが **dsh-tui(対話)が起動して dispatch が `failed`** になる(注入プロンプトを消費しない)
- `dsh headless` のような追加引数は **`agent_unconfigured`** で拒否される(`worker-start` にエージェント
  引数を渡すフラグが無い)

**承認プロンプトは MCP 側から解雇できない**: `orca terminal send` はエージェントの承認プロンプトへの
入力を `agent_prompt_blocked` で拒否する(人間が UI で答える設計)。E2E を止めずに通したいなら
エージェント側の許可設定(Claude Code は `Bash(orca:*)` の allow、Codex は `~/.codex/config.toml` の
approval policy / allowlist)を先に緩めてください。

`dsh --profile headless "<task>"`(1 タスク回答して stdout に出す)を Commander にしたい場合は、
その起動コマンドを Orca 側のエージェント設定に登録してから `commanderAgent` で指定してください
(設定キーは `agentCmdOverrides`、CLI からの設定コマンドは無く UI 設定のみ)。
**dsh を ACP で supervised worker にする経路は上の「dsh を ACP で動かす」節が本体です。**

### 介入(intervene)

委譲したジョブに**明示的に頼まれたときだけ**手を出す 3 個です。poll / result / 観測ツールは変更を一切行いません。

| ツール | 役割 | 内部で呼ぶもの | 破壊的? |
| --- | --- | --- | --- |
| `orca_send_message` | ワーカーへの指示補足・質問・エスカレーション | `orchestration send`(必要なら `run-use` でバインド切替) | いいえ |
| `orca_resolve_gate` | 判断ゲートを承認/却下して Commander を進める | gate-list → `orchestration gate-resolve`(必要なら `run-use` でバインド切替) | いいえ |
| `orca_cancel_task` | ジョブを止めてキャンセル扱いにする(**既定で子孫へ cascade**) | worker-stop / worker-abandon → `task-update --status failed` | はい |

```
orca_send_message({ subject: "方針変更", body: "実装は src/ のみに限定", run: "run_…",
                    taskId: "task_abc123", type: "status" })
  → { "ok": true, "messageId": "msg_1c7834109a5e", "runId": "run_…", "type": "status" }

orca_send_message({ subject: "done", body: "実装とテスト完了", type: "worker_done",
                    outcome: "succeeded", taskId: "task_abc123", dispatchId: "disp_…", run: "run_…" })
  → { "ok": true, "messageId": "msg_…", "type": "worker_done", "outcome": "succeeded" }

orca_resolve_gate({ gateId: "gate_333059a5ece6", resolution: "approve", run: "run_…" })
  → { "gateId": "gate_333059a5ece6", "resolved": true, "status": "resolved",
      "resolution": "approve", "taskId": "task_abc123", "runId": "run_…" }

orca_cancel_task({ taskId: "task_abc123", reason: "方針変更" })   // cascade 既定 true
  → { "taskId": "task_abc123", "state": "cancelled", "cancelled": true, "fullyStopped": true,
      "cascade": true, "taskCount": 3, "mode": "stop",
      "tasks": [ { "taskId": "task_deep", "state": "cancelled", "fenced": [ … ] },
                 { "taskId": "task_backend", "state": "cancelled", "fenced": [ … ] },
                 { "taskId": "task_abc123", "state": "cancelled", "fenced": [ … ] } ],
      "workers": [ { "taskId": "task_deep", "dispatchId": "ctx_…", "action": "stop", "resultState": "stopped" }, … ],
      "warnings": [] }
```

- `type` は CLI が受け付ける種別のみ(`status / dispatch / worker_done / merge_ready / escalation /
  handoff / decision_gate / question / heartbeat`)。**`worker_done` には `outcome` と `dispatchId` が必須**
  (欠ければ `outcome_required` / `dispatch_id_required`)で、`worker_done` 以外に `outcome` を付けると
  `outcome_not_allowed` — いずれも CLI に叩き合う前に MCP 側で弾く
- 宛先 `to` は `run:<id>` / `dispatch:<id>` / `@all` / `@codex` / `@worktree:<id>`、省略時は Run の受信箱
- MCP 側は Run バインドを持たないので `run`(`orca_delegate_task` が返した `runId`)を渡す
- **ゲートは Run バインドスコープ**(`gate-resolve` に `--run` が無い)なので `orca_resolve_gate` の
  `run` は必須。Run に gate が無ければ `gate_not_found`、解決済みなら何もしない(冪等)
- Commander Prompt は「承認ゲート無しでは merge / push / deploy をしない」と約束しているため、
  **ゲートを解決する API が無いとジョブが途中で詰まる**(blocked / decision_gate の `nextAction` が指す)
- **キャンセルは CLI の手順どおり**: worker を fence してから `--status failed --result cancelled`。
  完了済み・キャンセル済みのタスクには何もしない(冪等、`cancelled: false` + warning)
- `mode: "abandon"` は `orca orchestration worker-abandon`("Fence a worker without claiming its process
  stopped" — 生きている可能性のある資源を残し、プロセスにも filesystem にも触らない)に対応する。
  公開ドキュメントの掲載有無は CLI バージョンで変わるため、**ローカル版での確認を根拠にしている**
  (実機 1.4.220 で `orca orchestration worker-abandon --help` を確認済み)。迷ったら `stop` を使う
- **cancel は 2 段階(preflight → mutation)**: まず対象全タスクの dispatch を読み切ってから叩く。
  1 タスクに dispatch が **3 件を超える場合は何も変更する前に `cancel_dispatch_scope_too_large`** で断る
  (silent slice で黙って切ると、dispatch を生かしたまま task だけ failed になり `cancelled: true` に見える)。
  同様に子孫が 12 件を超える場合は `cancel_scope_too_large` — 子孫を 12 件で切ると post-order の末尾である
  Commander だけが対象から漏れ、「一部しか止めていないのに `cancelled: true`」になるため。
  `detail` に `taskCount` / `dispatchIds` が出るので、`cascade: false` か個別 cancel を選べる
- **Commander の worker が止められなければ cancel 成功を返さない**: 対象タスクの fence に 1 件でも
  失敗したら `cancel_incomplete`(`state: "partial"`, `cancelled: false`, `fullyStopped: false`)で、
  **対象 task は更新しない**。Commander はこれ以上 orchestration を進める主体なので、走りたままの
  cancel 宣言は危険(子 worker をさらに作り得る)。子タスクの fence 失敗は `warnings` に留めて進め、
  `fullyStopped: false` で「実プロセス停止の保証なし」を正直に出す
- **cancel はジョブ単位**: 既定 `cascade: true` で、Commander が分解した**子孫タスクとその worker を
  子から順**に止める(親だけ止めて子 Worker を走らせたままにしない)。`cascade: false` なら対象だけ。
  子タスクの確定失敗は `warnings` に留め、Commander の確定は進める
- worker fence に失敗しても `warnings` に記録して task のキャンセルは進める。
  確定だけ失敗したら `cancel_incomplete`(fence 済みの worker 一覧を `detail` に載せる)
- worktree やターミナルの削除は行わない(残す。後片付けは人間側の判断)
- **変更系は MCP サーバー内で直列化する**: Run バインドはプロセス共有の状態なので、
  `run-use` + 再試行の並びを他リクエストと挟まない(並行 cancel で binding が書き換わる競合を避ける)

### 観測用 read-only

| ツール | 内容 | 対応 orca コマンド |
| --- | --- | --- |
| `orca_status` | ランタイム準備状態(入力なし) | `orca status --json` |
| `orca_readiness` | 委譲の前提チェック(runtime / orchestration / orchestration skill) | `orca status --json` + `orca skills installed --json` |
| `orca_list_worktrees` | ワークツリー一覧(repo / limit) | `orca worktree list --json` |
| `orca_get_worktree` | 1 件のワークツリー詳細 | `orca worktree show --json` |
| `orca_list_agents` | worktree 横断のエージェント一覧 | `orca worktree ps --json` |

```
orca_readiness({ commanderAgent: "codex" })
  → { "ready": false,
      "checks": [ { "name": "orca runtime", "ok": true, "detail": "app.running=true …" },
                  { "name": "orchestration enabled", "ok": true, "detail": "capabilities: 12 orchestration.*" },
                  { "name": "orchestration skill installed", "ok": true, "detail": "installed skills: 319" },
                  { "name": "orchestration available to codex", "ok": false,
                    "detail": "orchestration skill providers: agent-skills, claude" } ],
      "missing": ["orchestration available to codex"],
      "commanderAgent": "codex",
      "nextAction": "Run: orca skills install --skill orchestration --agent codex" }
```

`orca_readiness` は**何もインストールしない**(勝手に skill を配らない)。足りないものは
`missing` と `nextAction`(人間が実行するコマンド)で返すだけ。
`commanderAgent` を渡すと、そのエージェントが orchestration skill を読めるか
(`skills installed` の `providers` 列挙)まで見る — codex を起動するのに skill が
claude 側にしか無い、という状態を委譲前に気づける。
`orca_delegate_task` の既定 `commanderAgent` は `codex` なので、上の例のような状態では
delegate 前に `orca_readiness({ commanderAgent: "codex" })` で気づける(実ホストで観測された形)。

`orca_delegate` と `orca_message` は内部実装として保持しており、MCP ツールとしては公開していません。
送信は `orca_send_message` を使ってください。

readiness の providers 判定は**同じ skill 名の行を union** して見る(E2E で踏んだ)。
`orca skills install --skill orchestration --agent codex` は共有 root(`~/.agents/skills`)へ copy され、
その後に codex 宛てを入れると `skills installed` が `orchestration` を **2 行**(providers
`agent-skills, claude` と `codex`)で返す。1 行目だけ見ると codex を false negative にする。
`--agent codex` の install 自体は `--json` 非対応(`--json` は `--dry-run` のみ)で、
git の env(`GIT_CONFIG_COUNT`)が汚れていると clone に失敗する。

### 挙動の約束

- **入力はすべて argv 配列**で、セレクタや自由文は 1 要素としてそのまま渡す(shell 文字列は作らない)
- **どのツールもワーカーの完了を待たない。** 完了監視は呼び出し側の poll に委ねる
- 大きな欄は既定で切り詰める(`orca_list_agents` の `prompt` は 200 文字、
  `orca_get_task_result` の worker 出力は 4000 文字、`specPreview` は 200 文字)
- CLI が `ok:false` を返したときは `code` をそのまま応答に載せる(`isError: true`)。
  例: `run_required` / `run_not_found` / `worktree_not_found`(+ `data.nextSteps` など)
- ジョブ層の失敗は別の語彙: `task_not_found` / `task_id_missing` / `run_create_failed` /
  `outcome_required` / `outcome_not_allowed` / `dispatch_id_required` / `cancel_incomplete` /
  `cancel_scope_too_large` / `cancel_dispatch_scope_too_large` / `gate_not_found`
- orca CLI は**呼び出し元ターミナルを 1 つの Run にバインド**する。違う Run への変更は
  `consumer_fenced` で拒否されるため、介入ツールだけが必要に応じて `run-use` で
  バインドを切り替えて 1 回だけ再試行する( poll / 観測ツールは切り替えない)

### 使用例(典型的な流れ)

1. `orca_readiness({ commanderAgent })` でランタイム・orchestration・skill の前提を確認する
2. `orca_delegate_task({ spec, constraints })` で委譲 → `{ taskId, state: "running", commander: true }` を即受け取る
3. `orca_get_task_status({ taskId })` を数分おきに poll する(他作業を挟んでよい)。
   `children` に Commander が分解した子タスクと worker の state が出る
4. 方針を変えたいときだけ `orca_send_message({ subject, body, run, taskId })` で指示を出す
5. `state: "blocked"` / `phase: "decision_gate"` になったら `orca_resolve_gate({ gateId, resolution, run })`
   で承認/却下して Commander を進める
6. 取り消すときだけ `orca_cancel_task({ taskId, reason })` を使う(既定で子孫 worker も子から順に止める)
7. `state: "completed"` になったら `orca_get_task_result({ taskId })` で成果を受け取る。
   ワーカー個々の成果まで欲しければ `includeChildren: true`
8. 状況確認が欲しいときだけ `orca_list_worktrees` / `orca_list_agents` を使う

## スクリプト

| コマンド | 内容 |
| --- | --- |
| `npm run dev` | tsx で開発実行(ビルド不要) |
| `npm run build` | `tsc` で `src/` を `dist/` へビルド |
| `npm start` | `node dist/index.js` |
| `npm run typecheck` | 型チェックのみ(src + tests) |
| `npm test` | vitest 1 回 |
| `npm run test:watch` | vitest watch |

### dsh を supervised worker にするブリッジ(`scripts/dsh-headless-worker.mjs`)

`dsh` を `worker-start --agent dsh` で起動すると dsh-tui(対話)が立ち上がり、注入プロンプトが
consumed されずに dispatch が `failed`(stage `agent_readiness`)になります。非対話の
`dsh --profile headless` はタスクを **argv** で要求するため、Orca のターミナル注入では届きません
(`-` で stdin 経路にすると PTY は EOF を送らないので永久待ちになる)。

そこで `scripts/dsh-headless-worker.mjs` が「注入テキストを stdin から拾い(4 秒 idle / 30 秒上限)、
`node <dsh bin.js> --profile headless <task>` を **argv 配列**で起動する」ブリッジになります
(shell 文字列は作りません)。Orca のエージェント起動コマンドをこれに向けます:

```
node C:\<repo-dir>\orca-mcp\scripts\dsh-headless-worker.mjs
```

**実機で確認した前提 2 つ**:

1. **注入は readiness の後に行われる**。agent hooks を持たない dsh には stdin が 1 バイトも届かない
   (実測 120 秒で 0 字)。なのでラッパーは `worktree current` → `terminal list`(path 照合で自分の
   ターミナル)→ `run-list` → `task-list --run` → `dispatch-show`(`assignee_handle` 一致)で
   **自分のタスクを逆引き**する(`task-list` は Run バインドが必要。新ターミナルは未バインド)。
2. **dispatch は `agent_readiness` で `failed` になる**ため `worker_done` を送っても完走できない。
   ラッパーは報告を **`task-update --status success --result …`** に切り替える(ゲートウェイの poll は
   task 状態を読むので届く)。worker 側の観測(`worker-list` の attention 等)は dsh では使われない。

`dsh --profile headless` は credential を要求する(`~/.deepseek/config.json` の `apiKey`、または
`DEEPSEEK_API_KEY`)。無い場合は `MISSING_CREDENTIAL` で即 exit する。

### dsh を ACP で supervised worker / Commander にするブリッジ(`scripts/dsh-acp-worker.mjs`)

`dsh --profile acp` は **ACP(Agent Client Protocol)の JSON-RPC stdio サーバー**です
(`%DSH_HOME%\profiles\acp`、`dsh --profile acp --help` = "Serve automation clients over Agent Client Protocol stdio")。
**Orca のターミナル注入を直接向けると pane に `{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}`
が出てタスクが始まらない**(実測)。なので「注入テキストを `session/prompt` に載せ直す」このブリッジが要ります。

```
node C:\<repo-dir>\orca-mcp\scripts\dsh-acp-worker.mjs
```

headless 版に対する利点(**すべて実機で確認**):

| 観点 | headless | acp ブリッジ |
| --- | --- | --- |
| ターン | 1 タスク 1 プロセス | 同一セッションでマルチターン(後続 send が 2 ターン目) |
| 承認プロンプト | 人間待ちになり得る | `session/request_permission` を **ブリッジが `allow_once` で機械応答** |
| モデル / effort | dsh は自前 config | `session/set_config_option` で外部から選択(`worker-start --model/--effort` は dsh 不可の救済) |
| MCP 注入 | 不可 | `session/new` の `mcpServers` に orca-mcp を渡せる(`DSH_ACP_MCP`) |
| 停止 | プロセス kill | `session/close` / `session/cancel` |
| 永続 | なし | `session/list` / `session/resume`(**プロセスを跨いで文脈が復元**することを実測) |

環境変数(すべて省略可): `DSH_ACP_PROFILE`(既定 `acp`)・`DSH_ACP_PERMISSION`(`allow_once` 既定)/
`DSH_ACP_MODEL`(`"provider/model"`）・`DSH_ACP_EFFORT`・`DSH_ACP_MCP`(JSON 配列)・
`DSH_ACP_IDLE_EXIT_MS`(ターン後に次の注入を待つ上限、既定 30 分)・`DSH_ACP_MAX_TURNS`(既定 40)。

**前提 — ローカル LLM へのルーティング(実機)**: `DEEPSEEK_API_KEY` が無いマシンでも動くよう、
`.dsh/profiles/acp/cordis.patch.yml` にローカルゲートウェイを焼いています。
**テンプレは `docs/templates/acp-cordis.patch.example.yml`**(プレースホルダ版。実体の IP は置かない)。

```yaml
- id: llm-pi-ai
  config:
    providers:
      vllm:
        api: openai-completions
        baseURL: http://<local-gateway>/v1
        headers:
          Authorization: Bearer local   # ← keyless の決め手
- id: acp
  config: { provider: vllm, model: <model-id> }
- id: agent-default-model
  config: { provider: vllm, model: <model-id> }
- id: llm-deepseek
  disabled: true
```

- dsh-tui と同じ `apiKeyEnv: VLLM_API_KEY` 写法は**新しいプロセスでは使えない**
  (key は dsh-tui を起動したプロセスの env にしか無く、子に引き継がれない)。
- 手宣言ルートで `apiKeyEnv` を省くと pi-ai が `No API key for provider: <route>` で落とす
  (README の "configured-but-keyless" は installed catalog ルート側の話)。
- 回避は `headers.Authorization`: pi-ai の `getClientApiKey` は **authorization ヘッダが非空なら
  key を `"unused"` として通す**(`dsh-llm` の予約ヘッダは `user-agent` のみで素通し)。
- プロファイル patch は**起動時のみ**反映(acp-app が HMR 無効)。変更後はプロセス再起動。

実機で確認した挙動: `initialize` → `session/new`(configOptions にローカルモデルが並ぶ)→
`session/prompt` が `stopReason: end_turn` で完走 → `tool_call`/`tool_call_update` のツールループ →
同一接続の 2 ターン目で文脈維持 → 別プロセスの `session/resume` 後も文脈維持。

**承認の自動応答は shape が命**(実測で踏んだ): `session/request_permission` への応答は
`{ "outcome": { "outcome": "selected", "optionId": "allow-once" } }`。
`{ "outcome": { "selected": "allow-once" } }`(よくある誤記)にすると**拒否扱いで tool が `failed` になり、
エージェントは「人間が拒否した」と解釈して止まる**。拒否は `{ "outcome": { "outcome": "cancelled" } }`。

**dsh は agent hooks を持つ**(2026-10-06 以降): `orca agent hooks status --json` の `dsh` が
`installed`(`C:\Users\<you>\.dsh\cordis.patch.yml` の orca-managed 節 → `~/.orca/agent-hooks/dsh-hooks.json`)。
なので headless 節に書いた「dsh は stdin を 1 バイトも受け取れない / dispatch が `agent_readiness` で
`failed`」は**hooks 導入前の記述**です。ブリッジは両経路に備え、preamble に
`worker_done` → 拒否されたら `task-update` の順の報告指針を焼きます。

**ただし `agent_readiness` は今も通らない**(2026-10-08 実測)。原因は hooks の有無ではなく **launch token**:

| 起動 | `dispatch.launch_token_hash` | dispatch 結果 |
| --- | --- | --- |
| `--agent codex`(登録コマンド) | 入る(`222b05cd…`) | `state: ready` / `stage: input_accepted` |
| `--agent dsh` + `agentCmdOverrides`(ブリッジ) | **空** | `agent_readiness` で `failed`(`terminal_handle_stale` / `timeout`) |

pane の env には token が入っていて hooks も `launchTokenHash` を返す(実測)が、
**dispatch 側に token が記録されない**ため readiness の照合が成立しない。
= `agentCmdOverrides` で起動コマンドを差し替えた worker は、現状 `worker_done` を送れる
live dispatch に到達できない。

**なので dsh worker の報告経路は `task-update` が本体**(preamble がそれを指示する):

- `--status` の有効値は `pending / ready / dispatched / completed / failed / blocked`(`success` は無い)
- 報告が `consumer_fenced` になるのは「その terminal が Run に未バインド」のとき。
  **自分の terminal だけ** `orca orchestration run-use --id <run>` で 1 回バインドして再試行する
- `worker-release` / `worker-list` の後始末は Coordinator 側の仕事(worker に課しない)

ゲートウェイの poll は task 状態を読むので、`task-update` の報告はそのまま呼び出し側に届く。

**E2E 実測(2026-10-08、`node scripts/e2e.mjs --agent dsh`)**:

```
readiness ready=true missing=[]            … dsh が共有 skills root を読む判定が ok
delegate  state=queued dispatch=ctx_a15fbb9f376c
          warnings=["worker-start receipt state=failed stage=agent_readiness lastError=timeout …"]
```

worker の pane 側はブリッジが起動し、注入の逆引き → ACP セッション → skill 読込 →
read/pwsh のツール実行 → 最終応答まで完走し、`session/request_permission` も `allow_once` で
自動応答されています(**pane に承認停止が出ない**)。止まるのは dispatch の readiness だけです。

`worker-start` は readiness 失敗を **`ok:true` の receipt + 終了コード 1** で返すので、
`command.ts` は stdout の `ok:true` を transport 成功として扱い(`isOkEnvelope`)、
`delegateTask` は `state: "queued"` + 正直な warning(stage / lastError / 報告経路)に落とします。
終了コードを主人にすると receipt が丸ごと `non_zero_exit` になり、失敗理由が
「終了コード 1」だけになっていました(E2E で踏んだ)。

`orca_readiness` は `commanderAgent: "dsh"` を**共有 skills root 経由**で ok にします
(dsh は `~/.agents/skills` を scan するので `skills installed` の providers 列挙に `dsh` は出ない)。

### E2E(実ランタイム検証)

`npm test` は orca ランタイムを起動しません。**実環境通し**は `scripts/e2e.mjs` が
MCP サーバーを stdio で起動して、`readiness → delegate → poll → gate → result → cancel` を
通します(実エージェントが動くので 10〜30 分)。

```powershell
npm run build
node scripts/e2e.mjs --minutes 30            # repo は `orca worktree current` の repoId から自動選択
node scripts/e2e.mjs --repo id:<repoId> --agent claude --cleanup
```

- 手順: `orca_readiness` → `orca_delegate_task`(Commander 起動)→ 30 秒間隔の `orca_get_task_status` →
  pending gate は `approve (e2e)` で `orca_resolve_gate` → `orca_get_task_result({ includeChildren: true })` →
  2 本目を途中で `orca_cancel_task`(cascade と `fullyStopped` を確認)
- 全ステップの観測は `e2e-transcript.json` に残ります
- `state: "queued"` で止まった場合は worker-start 失敗が原因なので、その場で cancel して終了します
- 後片付けは child worktree を表示するだけ(`--cleanup` を付けると `orca worktree rm` まで実行)

#### E2E で実測した挙動(そのまま実装に反映済み)

| 実測 | 対応 |
| --- | --- |
| `repo` に worktree の `name:` / worktree path を渡すと `repo_not_found` | repo セレクタの解説を追加(`id:<repoId>` / `path:<repo home>` を使う) |
| `worker-start` が 30 秒で SIGKILL され `queued` に着地(worktree は作られて残る) | `worker-start` だけ transport timeout を 180 秒に |
| Claude Code の承認プロンプト(`orca skills get …`)で Commander が `running` のまま停止 | poll が `attentionRequired` / `attentionNotes` を出す。Commander Prompt に「答えられない承認待ちで止まらず `--help` へ退避する」節 |
| Commander が自分の Run を使わず新しい `run-create` を試みる | Commander Prompt に Run ownership(新しい Run を作らない / `--parent` は自分の task) |
| 実 worker の cancel は `fullyStopped: true`、worker-stop は冪等(2 回目の fence も成功) | README の cancel 節に反映 |
| `worker-start` は readiness 失敗を **`ok:true` の receipt + 終了コード 1** で返す | `isOkEnvelope` で transport 成功として扱い、delegate は `queued` + 正直な warning(stage / lastError / 報告経路)に落とす |
| 同じ skill 名の行が複数(`agent-skills, claude` と `codex`)に分かれ、1 行目だけだと false negative | providers を **union** して判定(E2E が readiness で止まった実測) |
| codex は既定設定(`approval_policy` 未設定)で承認プロンプトに停止。`approval_policy="never"` + `sandbox_mode="workspace-write"` は逆に**コマンドを自動拒否**して「環境ポリシーにより拒否」と報告する | 完走には `--approve-for-me`(承認要求を workspace-write sandbox の自動レビューへ流す)。`agentDefaultArgs.codex` に設定し、`~/.codex/config.toml` は無変更 |

#### 承認/sandbox 選択肢の実測ラダー(codex-cli 0.160.1 / 新規 git worktree)

| 設定 | `orca skills get orchestration --full` | worktree への書き込み |
| --- | --- | --- |
| `--approve-for-me` | exit 0 | 成功 — **sandbox(workspace-write)を保ったまま通る** |
| `-s workspace-write -c approval_policy="never"` | `rejected: blocked by policy` | 拒否(自動拒否) |
| `-s danger-full-access -c approval_policy="never"` | exit 0 | 成功(sandbox 無し) |
| `--dangerously-bypass-approvals-and-sandbox` | exit 0 | 成功(sandbox 無し。codex 側が "EXTREMELY DANGEROUS / externally sandboxed 環境専用" と明記) |

`--approve-for-me` は `codex`(対話 TUI)にも `codex exec` にも存在する。自動レビューはモデル判定なので
たまにコマンドを拒否する(その場合は worker が拒否を報告して止まらない)。

#### E2E 完走記録(2026-10-08 / `--agent codex` / `agentDefaultArgs.codex = "--approve-for-me"`)

```
readiness  ready=true missing=[]
delegate   state=running  task_70de0802ffa1 / run_cf1a8d9cd0b6  warnings=[]
poll       #1-#5 running(implementation) → poll 終了 state=completed(phase=finished, polls=6)
result     state=completed
worker pane  git diff / git status / orca orchestration check を**承認プロンプトなし**で実行し、
             `orca orchestration send --type worker_done` → "Sent msg_3ed2ddd8bbcf"
cancel       2 本目を delegate → poll#1 running(workers=1) → cancel cancelled=true fullyStopped=true
             cancel 後 state=failed(MCP 側の論理 cancelled の実体)
cleanup      worktree rm: E2E cancel 検証 / E2E README 検証記録
```

#### E2E 完走記録(2026-10-08 / `--agent codex` / 承認設定を緩めた一時的な実行)

`~/.codex/config.toml` に `approval_policy="never"` + `sandbox_mode="danger-full-access"` を
入れた状態での完走(実行後に復元)。上の `--approve-for-me` 完走が本運用の記録。

```
readiness ready=true missing=[]
delegate  state=running  taskId=task_d6f10b7d1061 runId=run_1ee39fc4ee51  warnings=[]
poll#1..#3 running(phase=implementation) → poll#4 state=completed phase=finished
result    state=completed
cancel    2 本目を delegate → poll#1 blocked(workers=1) → cancel cancelled=true fullyStopped=true
          cancel 後 state=failed(MCP 側の論理 cancelled の実体)
cleanup   worktree rm: E2E cancel 検証 / E2E README 検証記録
```

`--agent dsh` は readiness の launch token で dispatch が `agent_readiness` に失敗するため
同じ完走はしない(上の dsh 節参照)。worker 側の作業自体は pane で完走している。

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
│     ├─ intervene.ts   # orca_send_message / orca_resolve_gate / orca_cancel_task(変更系はここだけ)
│     ├─ status.ts      # orca_status
│     ├─ readiness.ts   # orca_readiness(runtime / orchestration / skill の前提チェック)
│     ├─ worktrees.ts   # orca_list_worktrees / orca_get_worktree
│     ├─ agents.ts      # orca_list_agents(worktree ps の平坦化)
│     ├─ delegate.ts    # orca_delegate(内部実装)
│     └─ message.ts     # orca_message(内部実装)
├─ tests/               # orca ランタイム不要の単体テスト(job.test.ts は偽 client)
├─ scripts/
│  └─ e2e.mjs           # 実ランタイム E2E(readiness → delegate → poll → gate → result → cancel)
├─ AGENTS.md            # エージェント向け開発規約
├─ README.md
├─ package.json
└─ tsconfig.json        # 開発用(noEmit) / tsconfig.build.json: ビルド用
```

## トラブルシューティング

- `orca 起動失敗: orca CLI が見つかりませんでした` → PATH か `ORCA_BIN` を確認
- 終了コード非ゼロ → ツールの応答に stderr が含まれます(`orca status` でランタイム起動確認)
- MCP クライアントに接続されない → `npm run dev` で手動起動し、stdio 接続であることを確認
