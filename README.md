# orca-mcp

[Orca](https://github.com/stablyai/orca) の CLI(`orca`)を MCP 経由で操作するための MCP サーバーです。

**「この機能を作って」と頼んだら、Orca の中でエージェントが仕事をして、その進捗と結果を受け取れる**
ゲートウェイです。あなたが渡すのは「作ってほしいもの」と「守ってほしい制約」だけ。
読み取り・実装・テストは Commander と呼ばれるエージェントが受け持ち、必要なら複数のワーカー
(Codex / Claude / dsh など)に割り振ります。

利用者の手順は **頼む → 聞く → 受け取る** の 3 つだけです。

| やりたいこと | ツール | 返ること |
| --- | --- | --- |
| 頼む | `orca_delegate_task` | `taskId`(即返る。仕事はここで始まる) |
| 聞く | `orca_get_task_status` | 今の状態と、Commander が分解した子タスク・ワーカーの進捗 |
| 受け取る | `orca_get_task_result` | 完了後の成果(ワーカー個々の成果も集約できる) |
| 途中で手を出す(任意) | `orca_send_message` / `orca_resolve_gate` / `orca_cancel_task` | 指示の追加 / ゲートの承認 / 停止 |

**1 回の MCP 呼び出しでワーカーの完了を待つことはありません。**(30 分ブロックし続ける設計にしていません)

```
あなた(MCP クライアント)
  → orca_delegate_task        … 「作ってほしいもの」と制約を渡す(即 return)
  → Commander Agent           … 読み解いて、タスクに分解し、ワーカーに配る
      → supervised Worker(Codex / Claude / dsh …)
  → orca_get_task_status      … 進捗を poll(他作業を挟んでよい)
  → orca_get_task_result      … 完了後に成果を受け取る
```

MCP クライアント(Claude Code / Claude Desktop / dsh など)から使えます。

## 目次(使う順)

1. [セットアップ](#セットアップ)
2. [Orca 側のエージェント設定](#orca-側のエージェント設定)(ここで最も詰まります)
3. [使い方(典型的な流れ)](#使い方典型的な流れ)
4. [ツールリファレンス](#ツールリファレンス)
5. [つまったときの引き出し](#つまったときの引き出し)
6. [開発](#開発)

**dsh を使いたい人**は [dsh を Commander / Worker に使う](#dsh-を-commander--worker-に使う) を先に読んでください(設定が 1 行必要です)。

---

## セットアップ

### 必要環境

- Node.js **>= 20**(開発は v24 で検証)
- PATH 上に `orca` CLI(または `ORCA_BIN` 環境変数でバイナリパスを指定)
- 大半の操作は起動中の Orca ランタイムが必要(未起動なら `orca open`)

### インストール

```bash
npm install
npm run build     # src → dist
npm test          # vitest(orca ランタイム不要の単体テスト)
```

### MCP クライアントへの登録

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
ビルドに依存したくない開発中は `"command": "npx"` + `"args": ["tsx", "src/index.ts"]` でも動きます。

### 頼む前のチェック

頼む前に `orca_readiness` を実行してください。**何もインストールしません**(勝手に skill を配らない)。
足りないものは `missing` と、人間が実行する `nextAction` で返ります。

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

`commanderAgent` を渡すと、そのエージェントが orchestration skill を読めるか(`skills installed` の
`providers` 列挙)まで見ます。**同じ skill 名の行は union して判定する**(共有 root 経由で読める場合、
providers 列挙にそのエージェント名は出ない)。`orca_delegate_task` の既定 `commanderAgent` は `codex` です。

---

## Orca 側のエージェント設定

`orca_delegate_task` は `worker-start --agent <commanderAgent>` で Commander を起動します。
`--agent` に渡せるのは **Orca 側で設定されたエージェント名だけ**です(MCP 側でエージェントの引数を
組み込むフラグは無い)。設定キーは `agentCmdOverrides` / `agentDefaultArgs` で、**設定は Orca の UI からのみ**
(CLI からの設定コマンドは無い)。

| 目的 | 設定 |
| --- | --- |
| **codex を Commander / Worker に(既定)** | `agentDefaultArgs.codex = --approve-for-me` を推奨。これがないと Codex 側の**承認プロンプト**でジョブが止まります |
| **claude を Commander / Worker に** | `agentDefaultArgs.claude = --permission-mode acceptEdits --allowedTools Bash Read Edit Write Glob Grep`。設定なしだと `orca skills get …` などの**ツール承認プロンプト**でジョブが止まります |
| **copilot を Commander / Worker に** | `agentCmdOverrides.copilot = node` + `agentDefaultArgs.copilot = "C:\<repo-dir>\orca-mcp\scripts\copilot-launcher.mjs" --allow-all-tools`。launcher を挟まないと **folder trust の促し**で `agent_readiness` が止まります |
| **dsh を Commander / Worker に** | `agentCmdOverrides.dsh = node "C:\<repo-dir>\orca-mcp\scripts\dsh-tui-launcher.mjs"` — launcher を挟まないと readiness を通過できません |
| **dsh を ACP 機能付きで**(任意) | `agentCmdOverrides.dsh = node "C:\<repo-dir>\orca-mcp\scripts\dsh-acp-worker.mjs"` — 下の [ACP ブリッジ](#dsh-を-acp-で動かす任意のブリッジ) |
| **対話で dsh-tui を使う** | 設定不要。`dst .`(エイリアス)で起動すれば `agentCmdOverrides` を通しません |

- `"dsh headless"` のような追加引数は `agent_unconfigured` で拒否されます。
- 承認プロンプトは **MCP 側から解除できません**。`orca terminal send` はエージェントの承認プロンプトへの
  入力を `agent_prompt_blocked` で拒否します(人間が UI で答える設計)。上の設定で事前に潰してください。
- copilot の **folder trust**(`Confirm folder trust`)は env `COPILOT_ALLOW_ALL=true` でのみ解除されます。
  上の launcher がそれを焼きます(`agentDefaultEnv` の設定経路は UI に見当たりません)。
  設定の根拠・実測の経緯は [AGENTS.md](./AGENTS.md) にまとめてあります。

---

## 使い方(典型的な流れ)

1. `orca_readiness({ commanderAgent })` — 前提を確認する
2. `orca_delegate_task({ spec, constraints })` — 頼む(委譲する) → `{ taskId, state: "running" }` を即受け取る
3. `orca_get_task_status({ taskId })` — 数分おきに poll する(`children` に Commander が分解した子タスクと worker が出る)
4. 方針を変えたいときだけ `orca_send_message({ subject, body, run, taskId })`
5. `state: "blocked"` / `phase: "decision_gate"` になったら `orca_resolve_gate({ gateId, resolution, run })`
6. 取り消すときだけ `orca_cancel_task({ taskId, reason })`(既定で子孫 worker も子から順に止める)
7. `state: "completed"` になったら `orca_get_task_result({ taskId })`。ワーカー個々の成果まで欲しければ `includeChildren: true`
8. 状況確認が欲しいときだけ `orca_list_worktrees` / `orca_get_worktree` / `orca_list_agents` / `orca_status`

**poll / result / 観測ツールは変更を一切行いません。** 変更系は `orca_delegate_task` と介入 3 個だけです。

---

## ツールリファレンス

公開 API は 11 個です。低レベルすぎる API(`orca_create_worktree` / `orca_start_agent` /
`orca_send_terminal` など)は外部に出さず、内部実装に隠しています。

### Job API

| ツール | 役割 | 内部で呼ぶもの | 待つ? |
| --- | --- | --- | --- |
| `orca_delegate_task` | **submit**(Commander API) | run-create(未指定時) → task-create(固定 Commander 指示 + goal + repo + constraints) → supervised worker-start | 待たない |
| `orca_get_task_status` | **poll** | task-list / dispatch-show / worker-list / gate-list | 待たない |
| `orca_get_task_result` | **result** | task-list / dispatch-show / worker-read | 待たない |

```
orca_delegate_task({
  spec: "ユーザー認証機能を追加する",
  repo: "id:<repoId>",
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

**読み方の要点**

- `state`: `queued / running / blocked / completed / failed / cancelled`(CLI 生の値は `rawStatus`)
  - **`cancelled` は MCP 側の論理状態**です。Orca 側の task は `status: failed` +
    `result: "cancelled: <reason>"` で記録されます(CLI に native の `cancelled` が無い)。
- `phase`: `queued / starting / implementation / decision_gate / settling / finished`
- `children` は Commander が分解した**直接の子タスク**(`parent_id` 一致)とその worker。
  `childCount` は実件数、`returnedChildCount` が返した件数(上限 20)、`childrenTruncated` で打ち切りを伝えます。
  **孫以降は出ません**(その子の poll / result で見る)。
- `attentionRequired` / `attentionNotes` は worker 側の「人間側の対応が必要そう」の合図。
  ゲートが pending でないのに progress が止まる典型は、エージェントのターミナルに出る**ツール承認プロンプト**です
  (`attentionNotes` の `terminal(read) で確認` をたどってください)。
- `orca_get_task_result` は既定で Commander だけ読みます。`includeChildren: true` で直接の子タスクの
  `result` と出力も集約します(子 10 件・worker-read 8 件まで)。
- 大きな欄は既定で切り詰めます(`specPreview` 200 字、worker 出力 4000 字、`orca_list_agents` の `prompt` 200 字)。

**`repo` の渡し方** — `repo` は **repo セレクタ**です。`id:<repoId>` と `path:<repo home>` は解決できますが、
worktree の displayName(`name:weever`)や worktree path は `repo_not_found` になります。
repoId は `orca worktree current --json` の `result.worktree.repoId` で取れます。

**`commanderAgent` の条件** — 注入されたプロンプトを**非対話で消費できる**エージェントである必要があります。
`claude` / `codex` は supervised worker として動作します(承認設定は上の節)。`dsh` は下の
[dsh の節](#dsh-を-commander--worker-に使う)の設定が必要です。

**worker-start が失敗してもタスクは消えません** — `state: "queued"` + `warnings` で返ります。
`queued` は放置しても進みません(dispatch が無い = Commander 未起動)。`nextAction` が
「delegate し直す / cancel する」を明示するので、どちらかを選んでください。
`worker-start` は worktree 作成 + setup hook + エージェント起動 + 初ターン観測まで同期で走るため、
このコマンドだけ transport 側の timeout を **180 秒**に広げています。

### 介入(intervene)

委譲したジョブへ**あなたが明示的に介入を決めたときだけ**使う 3 個です。

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
      "tasks": [ { "taskId": "task_deep", "state": "cancelled", "fenced": [ … ] }, … ],
      "workers": [ { "taskId": "task_deep", "dispatchId": "ctx_…", "action": "stop", "resultState": "stopped" }, … ],
      "warnings": [] }
```

- `type` は CLI が受け付ける種別のみ(`status / dispatch / worker_done / merge_ready / escalation /
  handoff / decision_gate / question / heartbeat`)。**`worker_done` には `outcome` と `dispatchId` が必須**
  (欠ければ `outcome_required` / `dispatch_id_required`、`worker_done` 以外に `outcome` を付けると
  `outcome_not_allowed` — いずれも CLI に送る前に MCP 側で弾きます)
- 宛先 `to` は `run:<id>` / `dispatch:<id>` / `@all` / `@codex` / `@worktree:<id>`、省略時は Run の受信箱
- MCP 側は Run バインドを持たないので `run`(`orca_delegate_task` が返した `runId`)を渡してください
- **ゲートは Run バインドスコープ**(`gate-resolve` に `--run` が無い)なので `orca_resolve_gate` の `run` は必須。
  Run に gate が無ければ `gate_not_found`、解決済みなら何もしません(冪等)
- Commander Prompt は「承認ゲート無しでは merge / push / deploy をしない」と約束しています。
  **ゲートを解決する API がないとジョブは途中で詰まります**(blocked / decision_gate の `nextAction` が指します)
- **cancel はジョブ単位**(既定 `cascade: true`)。Commander が分解した**子孫タスクとその worker を子から順**に
  止めます(親だけ止めて子 Worker を走らせたままにしない)。`cascade: false` なら対象だけ
- cancel は 2 段階(preflight → mutation)。子孫が 12 件を超える場合は `cancel_scope_too_large`、
  1 タスクの dispatch が 3 件を超える場合は `cancel_dispatch_scope_too_large` で、**何も変更する前に**断ります
  (`detail` に `taskCount` / `dispatchIds` が出るので `cascade: false` か個別 cancel を選べます)
- **Commander の worker が止められなければ cancel 成功を返しません** — 対象タスクの fence に 1 件でも失敗したら
  `cancel_incomplete`(`state: "partial"`, `cancelled: false`, `fullyStopped: false`)で対象 task は更新しません。
  成功応答の `fullyStopped` が「実プロセスを全部止められたか」です
- `mode: "abandon"` は `orca orchestration worker-abandon`(資源を残しプロセスにも filesystem にも触らない)に対応します。
  迷ったら `stop` を使ってください
- worktree やターミナルの削除は行いません(後片付けは人間側の判断)

### 観測用 read-only

| ツール | 内容 | 対応 orca コマンド |
| --- | --- | --- |
| `orca_status` | ランタイム準備状態(入力なし) | `orca status --json` |
| `orca_readiness` | 頼む前のチェック(runtime / orchestration / orchestration skill) | `orca status --json` + `orca skills installed --json` |
| `orca_list_worktrees` | ワークツリー一覧(repo / limit) | `orca worktree list --json` |
| `orca_get_worktree` | 1 件のワークツリー詳細 | `orca worktree show --json` |
| `orca_list_agents` | worktree 横断のエージェント一覧 | `orca worktree ps --json` |

`orca_delegate` と `orca_message` は内部実装として保持しており、MCP ツールとしては公開していません。
送信は `orca_send_message` を使ってください。

### 挙動の約束

- **入力はすべて argv 配列**。セレクタや自由文は 1 要素としてそのまま渡します(shell 文字列は作りません)
- **どのツールもワーカーの完了を待ちません**。完了監視は呼び出し側の poll に委ねます
- CLI が `ok:false` を返したときは `code` をそのまま応答に載せます(`isError: true`)。
  例: `run_required` / `run_not_found` / `worktree_not_found`(+ `data.nextSteps`)
- ジョブ層の失敗語彙: `task_not_found` / `task_id_missing` / `run_create_failed` / `outcome_required` /
  `outcome_not_allowed` / `dispatch_id_required` / `cancel_incomplete` / `cancel_scope_too_large` /
  `cancel_dispatch_scope_too_large` / `gate_not_found`
- orca CLI は**呼び出し元ターミナルを 1 つの Run にバインド**します。違う Run への変更は `consumer_fenced` で
  拒否されるため、介入ツールだけが必要に応じて `run-use` でバインドを切り替えて 1 回だけ再試行します
  (poll / 観測ツールは切り替えません)。変更系は MCP サーバー内で直列化します

---

## dsh を Commander / Worker に使う

`dsh` を `worker-start --agent dsh` で起動すると dsh-tui(対話)が立ち上がり、**dispatch が
`agent_readiness` で失敗して task が `failed` に落ちます**。dsh-tui は注入を受け取れますが、**pane の起動コマンドに dsh-tui を直接指定すると readiness のゲートを通過できません**(実測)。
launcher を挟むと通過します。

そこで **dsh 用の launcher を向けます**:

```
node C:\<repo-dir>\orca-mcp\scripts\dsh-tui-launcher.mjs
```

実測(`agentCmdOverrides.dsh` をここへ向けて `worker-start --agent dsh --worktree new-child`):

```
worker-start  state=ready stage=input_accepted   ← 15 秒で ready
poll#1 dispatched → poll#2 dispatched → poll#3 completed
result = {"provenance":"worker_report","outcome":"succeeded", …}
```

注入はそのまま dsh-tui のプロンプト欄に入り、中のエージェントがワークを完走して `worker_done` で
報告します。**この運用に ACP ブリッジは不要です。**

**Commander(`commanderAgent: "dsh"`)としても完走します**(E2E 実測)。

```
readiness ready=true → delegate running → poll#7 children=1 → poll#9 completed
result children=1 → cancel cancelled=true fullyStopped=true
```

| 目的 | 設定 |
| --- | --- |
| 対話で dsh-tui を使う | 設定不要。`dst .`(エイリアス)で起動する — `agentCmdOverrides` を通しません |
| Commander / Worker として使う(既定) | `node …\scripts\dsh-tui-launcher.mjs` |
| ACP 機能が要るとき | `node …\scripts\dsh-acp-worker.mjs`(下の節) |

launcher の仕事は 4 つだけです: dsh-tui の Node エントリを解決する(`npm root -g` → PATH)、
`stdio: "inherit"` で pane の PTY を TUI に渡す、TUI の終了まで pane の foreground プロセスとして生存する、
終了コードを伝えて診断ログを残す。**注入も ACP も報告も一切しません。**

> **未解明点(正直に書いておきます)**: pane の起動コマンドが **dsh-tui 自身だと readiness を通過できず**、
> **node 経由の launcher を挟むと通過する**、という差は再現できていますが**機構は解明していません**。
> 観測された結果上の差は「dispatch に launch token が記録され `stage: input_accepted` に到達するか」です。
> 原因が判明したらこの節を更新してください。

### 報告の決まり(worker 側)

- **報告の本体は `worker_done`**(`--outcome` / `--task-id` / `--dispatch-id` 付き)。
  dispatch が生存中の `task-update --status completed` は CLI が拒否します
  ("cannot move to completed while supervised Dispatch … is active")
- `task-update` は dispatch が無い / 落ちた後の**事後報告専用**です。`--status` の有効値は
  `pending / ready / dispatched / completed / failed / blocked`(`success` は無い)
- 報告が `consumer_fenced` になったら、**自分の terminal だけ** `orca orchestration run-use --id <run>` で
  1 回バインドして再試行します
- `worker-release` / `worker-list` の後始末は Coordinator 側の仕事です(worker に課しません)

### `workerReportPending`(poll が完了を取り逃さないための補助)

worker-start が readiness で失敗すると task は即 `failed` になりますが、pane 側のワークは完走して
後から報告が届くことがあります。`orca_get_task_status` は **launch token 無しで失敗した dispatch +
生存 worker** の場合に `workerReportPending: true` と `workerReportNote` を添えます(**`state` は偽装しません**)。
poll を打ち切る前に数回待ってください。**launcher 運用では通常この経路は出番なし**です
(通常どおり `worker_done` で settlement されます)。

### dsh を ACP で動かす(任意のブリッジ)

`dsh --profile acp` は ACP(Agent Client Protocol)の JSON-RPC stdio サーバーです。
**Orca のターミナル注入を直接向けると pane に `-32700 Parse error` が出て始まらない**ので、
「注入テキストを `session/prompt` に載せ直す」ブリッジを挟みます。使うのは次の機能が要るときだけです。

| 観点 | launcher | acp ブリッジ |
| --- | --- | --- |
| 注入 | dsh-tui のプロンプト欄へ素通し | `session/prompt` に載せ替え |
| 承認プロンプト | dsh-tui 側の設定次第 | `session/request_permission` を**ブリッジが `allow_once` で機械応答** |
| ターン | 1 pane 1 セッション | 同一セッションでマルチターン(後続 send が 2 ターン目) |
| モデル / effort | dsh 自前 config | `session/set_config_option` で外部から選択 |
| MCP 注入 | 不可 | `session/new` の `mcpServers` に orca-mcp を渡せる |
| 永続 | なし | `session/list` / `session/resume`(プロセスを跨いで文脈が復元) |

環境変数(すべて省略可):

| 変数 | 既定 / 意味 |
| --- | --- |
| `DSH_ACP_PROFILE` | `acp` |
| `DSH_ACP_PERMISSION` | `allow_once`(権限要求への応答) |
| `DSH_ACP_MODEL` / `DSH_ACP_EFFORT` | 未指定(`"provider/model"` 形式) |
| `DSH_ACP_MCP` | 未指定(JSON 配列で MCP サーバーを注入) |
| `DSH_ACP_IDLE_EXIT_MS` | 1800000(ターン後に次の注入を待つ上限) |
| `DSH_ACP_MAX_TURNS` | 40 |
| `DSH_ACP_QUICK_FIRST_MS` | 1500(起動直後の注入 probe) |
| `DSH_ACP_LOOKUP_MS` | 180000(dispatch 照合の上限。**短くすると worker pane が対話フォールバックに落ちる**) |
| `DSH_ACP_TUI_BIN` / `DSH_ACP_TUI_ARGS` | 対話フォールバックで起動する dsh-tui の Node エントリと引数 |
| `DSH_ACP_NO_FALLBACK` | 未指定(設定すると対話フォールバックを無効化) |

- ブリッジは「短い probe で注入を見る → dispatch を照合する → どちらも無ければ dsh-tui へ素通し」で
  対話 pane と worker pane を判別します(`ORCA_AGENT_LAUNCH_TOKEN` は対話 pane にも入るので判別に使いません)。
  対話で dsh-tui を使いたい人の正解は `dst .` です。
- `session/request_permission` への応答は形(shape)が命です: `{ "outcome": { "outcome": "selected", "optionId": "allow-once" } }`。
  `{ "outcome": { "selected": "allow-once" } }` にすると**拒否扱いで tool が `failed` になります**。
- **ローカル LLM(key 不要)へルーティング**するには `.dsh/profiles/acp/cordis.patch.yml` にゲートウェイを焼きます。
  テンプレは `docs/templates/acp-cordis.patch.example.yml`(key 不要で通す決め手が `headers.Authorization`)。
  プロファイル patch は**起動時のみ**反映されるので、変更後はプロセスを再起動してください。
- 1 タスク 1 プロセスで完結させたい旧経路(`scripts/dsh-headless-worker.mjs`)は、注入を stdin で拾って
  `dsh --profile headless <task>` を argv で起動するブリッジです。credential を要求します
  (`~/.deepseek/config.json` の `apiKey` または `DEEPSEEK_API_KEY`、無ければ `MISSING_CREDENTIAL` で exit)。
  通常の worker 運用は launcher を使ってください。

---

## つまったときの引き出し

| 症状 | 原因 | 対処 |
| --- | --- | --- |
| `state: "queued"` から進まない | worker-start 失敗(dispatch が無く Commander 未起動) | `nextAction` の指示どおり delegate し直すか cancel する |
| `state: "failed"` / `stage: "agent_readiness"` | pane に生きたプロセスが見えていない(dsh) | `agentCmdOverrides.dsh` を launcher に向ける。`workerReportPending: true` なら報告を待つ |
| `lastError=Agent startup blocked: agent-trust-workspace` | copilot の **folder trust** 促しで起動が止まっている | `agentCmdOverrides.copilot = node` + launcher(`COPILOT_ALLOW_ALL=true` を焼く)。`--add-dir` / `--allow-all-paths` では消えない |
| `nested_worker_depth_exceeded`(子 worker が起動しない) | Orca の **Nested worker depth** が既定 1。MCP が起動する Commander は既に depth 1 なので、その子は depth 2 で拒否される | Orca の Settings → Orchestration → "Nested worker depth" を 2 にする(既定 1 / 1 以上の整数)。`depth 2, max 1` がそのまま応答に出る |
| `running` のまま progress が止まる | エージェントの**ツール承認プロンプト**で worker が停止 | `attentionNotes` をたどって pane を確認。codex は `--approve-for-me`、claude は `agentDefaultArgs.claude` の `--permission-mode acceptEdits --allowedTools Bash …` |
| claude の worker が `dispatched` のまま動かない、pane に `Not logged in` | claude の auth 切れ(権限設定ではない) | Orca 側のアカウント紐づけ / pane で `/login` |
| `blocked` / `phase: "decision_gate"` | 承認ゲート待ち | `orca_resolve_gate({ gateId, resolution, run })` で進める |
| `consumer_fenced` | 呼び出し元の Run バインドが対象と違う | 介入ツールは自動で `run-use` して 1 回だけ再試行します。worker 側なら自分の terminal を 1 回バインド |
| `repo_not_found` | worktree の `name:` / worktree path を渡した | `id:<repoId>` か `path:<repo home>` を使う(repoId は `orca worktree current --json`) |
| `outcome_required` / `dispatch_id_required` | `worker_done` に `outcome` / `dispatchId` が無い | 両方を付けて送り直す |
| `cancel_incomplete`(`fullyStopped: false`) | Commander の worker を止められなかった | 対象 task は未更新。pane を確認して worker を止めてから cancel し直す |
| `cancel_scope_too_large` / `cancel_dispatch_scope_too_large` | 子孫 12 件超 / 1 タスク 3 dispatch 超 | 何も変更していません。`cascade: false` か個別 cancel を選ぶ |
| cancel した task が `failed` に見える | `cancelled` は MCP 側の論理状態 | 実体は `status: failed` + `result: "cancelled: <reason>"`。想定どおり |
| `gate_not_found` | その Run に gate が無い | `run` を対象 Run に直す(`gate-list` は Run バインドスコープ) |
| `orca 起動失敗: orca CLI が見つかりませんでした` | PATH / `ORCA_BIN` | PATH を確認するか `ORCA_BIN` にバイナリパスを指定 |
| MCP クライアントに接続されない | 未ビルド / stdio 設定 | `npm run build` 後に `npm run dev` で手動起動して確認 |

---

## 開発

| コマンド | 内容 |
| --- | --- |
| `npm run dev` | tsx で開発実行(ビルド不要) |
| `npm run build` | `tsc` で `src/` を `dist/` へビルド |
| `npm start` | `node dist/index.js` |
| `npm run typecheck` | 型チェックのみ(src + tests) |
| `npm test` | vitest 1 回(orca ランタイム不要) |
| `npm run test:watch` | vitest watch |

### 構成

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
├─ scripts/
│  ├─ e2e.mjs                 # 実ランタイム E2E(readiness → delegate → poll → gate → result → cancel)
│  ├─ dsh-tui-launcher.mjs    # dsh worker の既定: dsh-tui を起動して待つだけの最小 launcher
│  ├─ dsh-acp-worker.mjs      # Orca 注入 → ACP session/prompt に載せ直すブリッジ
│  └─ dsh-headless-worker.mjs # 注入 → dsh --profile headless の argv に載せ直すブリッジ(旧経路)
├─ docs/templates/acp-cordis.patch.example.yml   # ACP 用ローカル LLM ルーティングのテンプレ
├─ tests/               # orca ランタイム不要の単体テスト(job.test.ts は偽 client)
├─ AGENTS.md            # エージェント向け開発規約
├─ package.json
└─ tsconfig.json        # 開発用(noEmit) / tsconfig.build.json: ビルド用
```

### E2E(実ランタイム検証)

`npm test` は orca ランタイムを起動しません。実環境通しの検証は `scripts/e2e.mjs` が MCP サーバーを stdio で
起動して `readiness → delegate → poll → gate → result → cancel` を通します(実エージェントが動くので 10〜30 分)。

```powershell
npm run build
node scripts/e2e.mjs --minutes 30            # repo は `orca worktree current` の repoId から自動選択
node scripts/e2e.mjs --repo id:<repoId> --agent claude --cleanup
```

- 手順: `orca_readiness` → `orca_delegate_task` → 30 秒間隔の `orca_get_task_status` →
  pending gate は `approve (e2e)` で `orca_resolve_gate` → `orca_get_task_result({ includeChildren: true })` →
  2 本目を途中で `orca_cancel_task`(cascade と `fullyStopped` を確認)
- 全ステップの観測は `e2e-transcript.json` に残ります
- `state: "queued"` で止まった場合は worker-start 失敗が原因なので、その場で cancel して終了します
- 後片付けは child worktree を表示するだけ(`--cleanup` を付けると `orca worktree rm` まで実行)

E2E は `--agent codex`(`agentDefaultArgs.codex = "--approve-for-me"`)で完走を確認済みです
(readiness ok → delegate running → poll 6 回で completed → result → cancel `fullyStopped: true`)。
worker 単体の完走は claude でも確認済みです(2026-10-08、上の `agentDefaultArgs.claude` 設定で
`worker-start ready` → 承認停止ゼロ → `poll#13 completed`)。
`--agent copilot` の完走も確認済みです(2026-10-08、上の launcher 設定で
`readiness ready=true` → `delegate running` → `poll#2 completed` → cancel `fullyStopped: true`)。
**分解(decomposition)の実測**もしています(2026-10-08、`Nested worker depth = 2` で `--agent copilot`)。

```
delegate running → poll#4 children=4 → poll#7 completed
子タスク 3 件が copilot worker で state=succeeded / outcome=succeeded(並列)
result children=4 / filesModified ["README.md"]
```

depth が 1 のままだと子 worker の起動は `nested_worker_depth_exceeded` で止まります(下の引き出し参照)。

### 開発上の決まり(抜粋)

- 引数は常に **argv 配列**(`execFile(bin, argvArray)`、shell 文字列は作らない)
- stdout は MCP ワイヤー専用。ログ・診断は `console.error` へ
- 失敗はプロトコル例外にせず `isError: true` の CallToolResult で返す
- `worker-start` は readiness 失敗を **`ok:true` の receipt + 終了コード 1** で返すので、
  stdout の `ok:true` を transport 成功として扱う(`isOkEnvelope`)。終了コードを基準にすると
  receipt が `non_zero_exit` になり delegate が `queued` に落ちます
- リポジトリの文章は日本語で書く(README・AGENTS.md・ツールの title/description・テスト名)

開発規約全体は [AGENTS.md](./AGENTS.md) にあります。
