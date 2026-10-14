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
| 聞く | `orca_get_task_status` | 今の状態と、Commander が分解した子タスク・ワーカーの進捗(**sub-run の中まで拾う**) |
| 受け取る | `orca_get_task_result` | 完了後の成果(ワーカー個々の成果も集約できる) |
| 途中で手を出す(任意) | `orca_send_message` / `orca_resolve_gate` / `orca_cancel_task` | 指示の追加 / ゲートの承認 / 停止(sub-run の worker まで止める) |
| Run を見る(任意) | `orca_list_runs` / `orca_get_run` | Orca の Run 一覧と詳細(sub-run 発見の唯一の経路) |

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
- **MCP サーバー専用の Orca ターミナル**: orchestration コマンド(`run-create` など)は送信元ターミナルを要求する。
  Orca アプリ上で専用ターミナルを 1 つ立て、**その pane 内で MCP サーバーを起動する**(pane が持つ
  `ORCA_TERMINAL_HANDLE` を子プロセスの orca が継承する)。外部クライアントから起動する場合は、
  専用ターミナルの handle を `ORCA_TERMINAL_HANDLE` として起動環境に渡す。他の pane の handle は使わない
  (その pane の mailbox を操作してしまう)。ターミナルを閉じると handle は失効する。

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

### 別 PC から使う(HTTP トランスポート)

既定は **stdio** です。HTTP で立つのは `ORCA_MCP_TRANSPORT=http` を設定したときだけなので、
既存の登録(上の `command` / `args`)はそのまま使えます。

| 環境変数 | 既定 | 内容 |
| --- | --- | --- |
| `ORCA_MCP_TRANSPORT` | `stdio` | `stdio` / `http` |
| `ORCA_MCP_HTTP_HOST` | `127.0.0.1` | listen 先(`http` のときだけ参照。IPv6 は `::1` の表記で渡す) |
| `ORCA_MCP_HTTP_PORT` | `8765` | listen port(`0` で空きポート) |
| `ORCA_MCP_AUTH_TOKEN` | 未設定 | 設定したときだけ `Authorization: Bearer` を検証 |
| `ORCA_MCP_ALLOWED_HOSTS` | `localhost,127.0.0.1,[::1]` | `Host` ヘッダーの許可リスト(カンマ区切り) |
| `ORCA_MCP_ALLOWED_ORIGINS` | `localhost,127.0.0.1,[::1]` | `Origin` ヘッダーの許可リスト(カンマ区切り) |

```bash
npm run build
ORCA_MCP_TRANSPORT=http ORCA_MCP_AUTH_TOKEN=$(openssl rand -hex 32) node dist/index.js
```

エンドポイントは `/mcp` です。

```json
{
  "mcpServers": {
    "orca": {
      "type": "http",
      "url": "http://127.0.0.1:8765/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

**別 PC からは `ssh -L` で中継するのを推奨します**(サーバーはループバック専用のままにできます)。

```bash
ssh -L 8765:127.0.0.1:8765 <server>
```

クライアントは自分の `127.0.0.1:8765` へ繋ぐので、`Host` は `127.0.0.1` のままで**許可リストの追加は不要**です。
WireGuard / Tailscale を使う場合はトンネル側の IP を `ORCA_MCP_ALLOWED_HOSTS` に足します。

`ORCA_MCP_HTTP_HOST` を `0.0.0.0` や特定 NIC IP に直接 bind する構成は**非推奨**です(plain HTTP を LAN にさらす)。
使うなら TLS proxy か VPN の内側で使い、次の点を揃えてください。

- `ORCA_MCP_AUTH_TOKEN` は**必須**(未設定だと起動しません)
- `ORCA_MCP_ALLOWED_HOSTS` に**到達に使うホスト名 / IP を列挙**(入っていない `Host` は 403)
- Windows では該当 port の**受信ファイアウォールルール**が必要

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
| **copilot を Commander / Worker に** | `agentCmdOverrides.copilot = node` + `agentDefaultArgs.copilot = "C:\<repo-dir>\orca-mcp\scripts\copilot-launcher.mjs" --allow-all-tools`。launcher を挟むと folder trust の確認を求められずに起動します。挟まないと `agent_readiness` で `agent-trust-workspace` に落ちます |
| **dsh を Commander / Worker に** | `agentCmdOverrides.dsh = node "C:\<repo-dir>\orca-mcp\scripts\dsh-tui-launcher.mjs"` — launcher を挟まないと readiness を通過できません |
| **dsh を ACP 機能付きで**(任意) | `agentCmdOverrides.dsh = node "C:\<repo-dir>\orca-mcp\scripts\dsh-acp-worker.mjs"` — 下の [ACP ブリッジ](#dsh-を-acp-で動かす任意のブリッジ) |
| **対話で dsh-tui を使う** | 設定不要。`dst .`(エイリアス)で起動すれば `agentCmdOverrides` を通しません |

- `"dsh headless"` のような追加引数は `agent_unconfigured` で拒否されます。
- 承認プロンプトは **MCP 側から解除できません**。`orca terminal send` はエージェントの承認プロンプトへの
  入力を `agent_prompt_blocked` で拒否します(人間が UI で答える設計)。上の設定で承認を許可してから使ってください。
- copilot の **folder trust**(`Confirm folder trust`)は、環境変数 `COPILOT_ALLOW_ALL=true` でのみ解除されます。
  この変数は launcher が設定します(`agentDefaultEnv` を UI から設定する経路が見つかっていないため)。
  設定の根拠・実測の経緯は [AGENTS.md](./AGENTS.md) にまとめてあります。

---

## 使い方(典型的な流れ)

1. `orca_readiness({ commanderAgent })` — 前提を確認する
2. `orca_delegate_task({ spec, constraints })` — 頼む(委譲する) → `{ taskId, state: "running" }` を即受け取る
3. `orca_get_task_status({ taskId })` — 数分おきに poll する(`children` に Commander が分解した子タスクと worker が出る。Commander が sub-run を作っていた場合はその中身も `sourceRunId` 付きで拾う)
4. 方針を変えたいときだけ `orca_send_message({ subject, body, run, taskId })`
5. `state: "blocked"` / `phase: "decision_gate"` になったら `orca_resolve_gate({ gateId, resolution, run })`
6. 取り消すときだけ `orca_cancel_task({ taskId, reason })`(既定で子孫 worker も子から順に止める。**sub-run の worker も Commander より先に止める**)
7. `state: "completed"` になったら `orca_get_task_result({ taskId })`。ワーカー個々の成果まで欲しければ `includeChildren: true`
8. 状況確認が欲しいときだけ `orca_list_worktrees` / `orca_get_worktree` / `orca_list_agents` / `orca_list_runs` / `orca_status`

**poll / result / 観測ツールは変更を一切行いません。** 変更系は `orca_delegate_task` と介入 3 個だけです。

---

## ツールリファレンス

公開 API は 13 個です。低レベルすぎる API(`orca_create_worktree` / `orca_start_agent` /
`orca_send_terminal` など)は外部に出さず、内部実装に隠しています。

### Job API

| ツール | 役割 | 内部で呼ぶもの | 待つ? |
| --- | --- | --- | --- |
| `orca_delegate_task` | **submit**(Commander API) | run-create(未指定時) → task-create(固定 Commander 指示 + goal + repo + constraints) → supervised worker-start | 待たない |
| `orca_get_task_status` | **poll** | task-list / dispatch-show / worker-list / gate-list / run-list(sub-run 照合) | 待たない |
| `orca_get_task_result` | **result** | task-list / dispatch-show / worker-read / run-list(sub-run 照合) | 待たない |

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
        { "taskId": "task_sub_root", "title": "Split docs work", "state": "blocked",
          "sourceRunId": "run_8d1d20524d42",
          "workers": [ { "agent": "codex", "status": "running", "dispatchId": "disp_…" } ] }
      ],
      "subRunsDiscovered": 1,
      "subRuns": [ { "runId": "run_8d1d20524d42", "objective": "sub", "coordinatorHandle": "term_…",
                     "taskCount": 7, "rootTaskIds": ["task_sub_root"] } ],
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
- `phase`: `queued / starting / implementation / decision_gate / blocked / settling / finished`
  (`decision_gate` は pending のゲートがあるときだけ。ゲートが無い `blocked` は `blocked`)
- `gates` は対象タスクと**直接の子タスク**(sub-run 集約時はその部分木)のゲート(`taskId` と **`runId`** 付き、`question` は 2000 字まで)。
  `runId` は**そのゲートの所属 Run** です。実測では sub-run 内のゲートが `run_8d1d20524d42` に pending で、
  呼び出し元 Run の `gate-list` は 0 件でした — `orca_resolve_gate` にはこの `runId` をそのまま `run` として渡します。
- `blockedReasons[]` は止まっている理由(`{ kind, taskId, role, summary, detail? }`)。`role` は `commander`(対象タスク自身 = Commander)/
  `child`(直接の子タスク)で、どちらが止まっているかを示します。`kind` は
  `gate`(質問文 + `detail.gateId` / `detail.runId` / `detail.options`)/ `task_report`(Commander・子タスクの blocked 報告 `result`)/
  `agent_prompt`(入力待ちの worker。`detail` に `outputTail` / `outputHash` / `looksLikePrompt` / `observedAt` / `activity`。
  MCP からは解除不可。`looksLikePrompt` は文言からの推定。`outputHash` は呼び出し側が前回値と比べて動作中かを判定する)/
  `unknown`(根拠なし)。`nextAction` は最優先の kind に合わせて案内します。
  `agent_prompt` の出力取得(`worker-read`)だけが追加の読み取りで、失敗しても `warnings` に残して poll は返ります。
  Orca が attention を立てない承認プロンプトもあるため、`activity: waiting` の worker も出力末尾を読み、
  プロンプトらしいときだけ `agent_prompt`(と `attentionRequired: true`)にします。
- `children` は Commander が分解した**直接の子タスク**(`parent_id` 一致)とその worker。
  `childCount` は実件数、`returnedChildCount` が返した件数(上限 20)、`childrenTruncated` で打ち切りを伝えます。
  **孫以降は出ません**(その子の poll / result で見る)。
- **sub-run も拾います**(既定 `includeSubRuns: true`)。Commander が自分の terminal で `run-create` を作ると、
  その Run の task / worker / gate は呼び出し元 Run の `task-list` に出てきません(`task-list` は Run スコープ)。
  poll は `run-list` を **cursor でページング**して読み(実測で 60 件 + `nextCursor`)、`coordinator_handle` を照合して
  sub-run を特定し、その中の**root タスク**を `children` に合算します(行に `sourceRunId` が付くので呼び出し元 Run の子と区別できます)。
  拾った Run は `subRunsDiscovered` / `subRuns[]` に出します。`includeSubRuns: false` で止められます
- `subRuns[]` の行は**所有判定**を載せます。`coordinator_handle` 一致だけでは破壊的操作に使いません:

  | `ownership` | 意味 | `cancelEligible` |
  | --- | --- | --- |
  | `verified` | handle + `created_by_pane_key`(tabId:leafId)+ `created_by_process_incarnation`(ptyId:incarnationId)が terminal list と一致し矛盾なし | `true` |
  | `probable` | handle 一致のみ(来歴の確認が取れない) | `false` |
  | `unverified` | handle 一致なし / root が特定できない | `false` |
  | `conflicting` | 来歴が矛盾する、または objective のマーカーが別の Run を指す | `false` |

  根拠は `verificationReasons[]`、発見の経路は `discoverySource`(`explicit` / `provenance` / `handle`)。
  objective の `orca-mcp-parent: run=<caller runId> task=<your task id>` マーカーは**発見の候補**に使い、
  これだけで `verified` にはしません(誰でも書けるため)。
- スキャンの正直さも応答に出します: `subRunScanComplete`(ページ上限で打ち切ったら false)/
  `subRunsTruncated`(照合が `MAX_SUB_RUNS` 超で打ち切られた)/ `subRunScanPageCount` / `subRunScanRunCount` /
  `subRunOwnershipComplete`(全 sub-run が verified か)。
- `attentionRequired` / `attentionNotes` は worker 側の「人間側の対応が必要そう」の合図。
  ゲートが pending でないのに progress が止まる典型は、エージェントのターミナルに出る**ツール承認プロンプト**です
  (`attentionNotes` の `terminal(read) で確認` をたどってください)。
- `orca_get_task_result` は既定で Commander だけ読みます。`includeChildren: true` で直接の子タスクの
  `result` と出力も集約します(子 10 件・worker-read 8 件まで)。sub-run の子も `sourceRunId` 付きで集約されます。
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

orca_resolve_gate({ gateId: "gate_e3de81e4d0d4", resolution: "approve", run: "run_8d1d20524d42" })
  //  ↑ poll の gates[].runId(このゲートは sub-run 側に存在する)をそのまま run に渡す
  → { "gateId": "gate_e3de81e4d0d4", "resolved": true, "status": "resolved",
      "resolution": "approve", "taskId": "task_a9c5f6f06805", "runId": "run_8d1d20524d42" }

orca_cancel_task({ taskId: "task_abc123", reason: "方針変更" })   // cascade 既定 true
  → { "taskId": "task_abc123", "state": "cancelled", "cancelled": true, "fullyStopped": true,
      "cascade": true, "taskCount": 3, "mode": "stop", "subRunsDiscovered": 1,
      "subRuns": [ { "runId": "run_8d1d20524d42", "objective": "sub", "taskCount": 7 } ],
      "tasks": [ { "taskId": "task_deep", "state": "cancelled", "runId": "run_…", "fenced": [ … ] }, … ],
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
- **`run` は poll が返す `gates[].runId`(ゲートの所属 Run)を渡す**こと。Commander が sub-run を作っていると
  ゲートは呼び出し元 Run と違う Run にあり(実測: 呼び出し元 Run の `gate-list` は 0 件、sub-run に pending が 1 件)、
  組が一致しない場合は**何も変更する前に** `gate_run_mismatch` で拒否します(`gate_not_found` と合わせて
  誤った Run のゲートを解決しないための gate)
- Commander Prompt は「承認ゲート無しでは merge / push / deploy をしない」と約束しています。
  **ゲートを解決する API がないとジョブは途中で詰まります**(blocked / decision_gate の `nextAction` が指します)
- **cancel はジョブ単位**(既定 `cascade: true`)。Commander が分解した**子孫タスクとその worker を子から順**に
  止めます(親だけ止めて子 Worker を走らせたままにしない)。`cascade: false` なら対象だけ
- **sub-run も止めます**。Commander が自分の terminal で `run-create` を作ると、その Run の中の task / worker は
  呼び出し元 Run の task ツリーから見えません(実測で cascade が sub-run の worker を走りたままにした)。
  既定 `includeSubRuns: true` は `run-list` の `coordinator_handle` 照合で sub-run の部分木を拾い、
  **呼び出し元 Run の Commander より先に**止めます(拾った Run は `subRunsDiscovered` / `subRuns` に出す)。
  上限 12 件は sub-run 込みの件数です。sub-run を対象にしたくないときだけ `includeSubRuns: false`
- **auto-cancel する sub-run は `verified` だけ**(所有検証)。pane key / process incarnation まで一致しない
  (`probable` / `unverified` / `conflicting`)な sub-run が 1 件でもあれば、preflight で
  `cancel_ownership_unverified` を返して**何も変更しません**(別 job・別 terminal の worker を止める事故の防止)。
  `detail.subRuns[]` に `ownership` / `verificationReasons` が出るので、`includeSubRuns: false` で本体だけ止めるか、
  sub-run 側は Run を名指しで個別にキャンセルしてください
- cancel は 2 段階(preflight → mutation)。子孫が 12 件を超える場合は `cancel_scope_too_large`、
  1 タスクの dispatch が 3 件を超える場合は `cancel_dispatch_scope_too_large` で、**何も変更する前に**断ります
  (`detail` に `taskCount` / `dispatchIds` が出るので `cascade: false` か個別 cancel を選べます)。
  同一 dispatch は 1 回だけ叩きます(sub-run 集約と task ツリーが同じ dispatch を重ねて持つことがある)
- **Commander の worker が止められなければ cancel 成功を返しません** — 対象タスクの fence に 1 件でも失敗したら
  `cancel_incomplete`(`state: "partial"`, `cancelled: false`, `fullyStopped: false`)で対象 task は更新しません。
  成功応答の `fullyStopped` が「実プロセスを全部止められたか」です
- **停止後に worker-list を読み直します**。まだ生きている worker は `residualWorkers[]` に載せ、
  その 1 件でも `fullyStopped: false` にします(論理 cancel と実プロセス停止のズレを正直に出す)。
  sub-run 探索を打ち切った場合(`subRunScanComplete: false` / `subRunsTruncated`)も `fullyStopped: false` です
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
| `orca_list_runs` | Run 一覧(limit / cursor)。**run は poll / cancel の境界**なので sub-run 発見に使う | `orca orchestration run-list --json` |
| `orca_get_run` | 1 件の Run 詳細(runId) | `orca orchestration run-show --id --json` |

`orca_delegate` と `orca_message` は内部実装として保持しており、MCP ツールとしては公開していません。
送信は `orca_send_message` を使ってください。

### 挙動の約束

- **入力はすべて argv 配列**。セレクタや自由文は 1 要素としてそのまま渡します(shell 文字列は作りません)
- **どのツールもワーカーの完了を待ちません**。完了監視は呼び出し側の poll に委ねます
- CLI が `ok:false` を返したときは `code` をそのまま応答に載せます(`isError: true`)。
  例: `run_required` / `run_not_found` / `worktree_not_found`(+ `data.nextSteps`)
- ジョブ層の失敗語彙: `task_not_found` / `task_id_missing` / `run_create_failed` / `outcome_required` /
  `outcome_not_allowed` / `dispatch_id_required` / `cancel_incomplete` / `cancel_scope_too_large` /
  `cancel_dispatch_scope_too_large` / `gate_not_found` / `gate_run_mismatch` / `cancel_ownership_unverified`
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

**Commander(`commanderAgent: "dsh"`)としても完走します。**

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
> 観測されている差は「dispatch に launch token が記録され `stage: input_accepted` に到達するか」です。
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
- **ローカル LLM(key 不要)へルーティング**するには `.dsh/profiles/acp/cordis.patch.yml` にゲートウェイを指定します。
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
| `lastError=Agent startup blocked: agent-trust-workspace` | copilot が **folder trust** の確認を求めて起動が止まっている | `agentCmdOverrides.copilot = node` + launcher(launcher が `COPILOT_ALLOW_ALL=true` を設定して起動する)。`--add-dir` / `--allow-all-paths` では消えない |
| `nested_worker_depth_exceeded`(子 worker が起動しない) | Orca の **Nested worker depth** が既定 1。MCP が起動する Commander は既に depth 1 なので、その子は depth 2 で拒否される | Orca の Settings → Orchestration → "Nested worker depth" を 2 にする(既定 1 / 1 以上の整数)。`depth 2, max 1` がそのまま応答に出る |
| `running` のまま progress が止まる | エージェントの**ツール承認プロンプト**で worker が停止 | `attentionNotes` をたどって pane を確認。codex は `--approve-for-me`、claude は `agentDefaultArgs.claude` の `--permission-mode acceptEdits --allowedTools Bash …` |
| claude の worker が `dispatched` のまま動かない、pane に `Not logged in` | claude の auth 切れ(権限設定ではない) | Orca 側のアカウント紐づけ / pane で `/login` |
| `blocked` / `phase: "decision_gate"` | 承認ゲート待ち | `blockedReasons` の `question` / `options` を読み、`orca_resolve_gate({ gateId, resolution, run })` で進める(`run` には `gates[].runId` を使う) |
| `blocked` / `phase: "blocked"`(`gates` が空) | ゲート以外の停止(Commander の blocked 報告、承認プロンプトなど) | `blockedReasons` の `kind` を確認(`task_report` は `orca_send_message` / cancel、`agent_prompt` は pane で人間が答える) |
| `consumer_fenced` | 呼び出し元の Run バインドが対象と違う | 介入ツールは自動で `run-use` して 1 回だけ再試行します。worker 側なら自分の terminal を 1 回バインド |
| poll の `childCount: 0` のまま Commander が進み、cancel でも worker が止まらない | Commander が自分の terminal で `run-create` を作り、仕事が **別の sub-run** に移った(`task-list` は Run スコープ) | 既定の sub-run 集約で拾います(`subRunsDiscovered` / `children[].sourceRunId`)。`orca_list_runs` で Run を直接見る。Commander Prompt に「既存 Run を使う / 深さ・circuit-break 回避の run-create は作らない / 作ったならマーカーと報告」を書き込んでいます |
| `repo_not_found` | worktree の `name:` / worktree path を渡した | `id:<repoId>` か `path:<repo home>` を使う(repoId は `orca worktree current --json`) |
| `outcome_required` / `dispatch_id_required` | `worker_done` に `outcome` / `dispatchId` が無い | 両方を付けて送り直す |
| `cancel_incomplete`(`fullyStopped: false`) | Commander の worker を止められなかった | 対象 task は未更新。pane を確認して worker を止めてから cancel し直す |
| `cancel_scope_too_large` / `cancel_dispatch_scope_too_large` | 子孫 12 件超 / 1 タスク 3 dispatch 超 | 何も変更していません。`cascade: false` か個別 cancel を選ぶ |
| `cancel_ownership_unverified` | 所有が `verified` でない sub-run がある(来歴の pane key / incarnation が確認できない) | 何も変更していません。`detail.subRuns[]` の `ownership` / `verificationReasons` を確認し、`includeSubRuns: false` で本体だけ止めるか sub-run を Run 名指しで個別 cancel する |
| cancel が `fullyStopped: false`(`cancelled: true`) | 停止後に読み直して worker が生存している / sub-run 探索を打ち切った | `residualWorkers[]` の task / dispatch を pane で確認。`subRunScanComplete` / `subRunsTruncated` が false / true なら探索が未完 |
| poll の `subRunOwnershipComplete: false` | sub-run の来歴が確認できない(terminal list が読めない等) | 観測には出るが auto-cancel はしない。`subRuns[].ownership` を見て判断する |
| cancel した task が `failed` に見える | `cancelled` は MCP 側の論理状態 | 実体は `status: failed` + `result: "cancelled: <reason>"`。想定どおり |
| `gate_not_found` | その Run に gate が無い | `run` を対象 Run に直す(`gate-list` は Run バインドスコープ)。sub-run のゲートは `gates[].runId` の Run で見る |
| `gate_run_mismatch` | 渡した `run` とゲートの所属 Run が違う | 何も変更していません。poll の `gates[].runId` / `blockedReasons[].detail.runId` を `run` に渡す |
| `orca 起動失敗: orca CLI が見つかりませんでした` | PATH / `ORCA_BIN` | PATH を確認するか `ORCA_BIN` にバイナリパスを指定 |
| `no_active_sender_terminal`(`run-create` など) | MCP サーバーが Orca ターミナルの外で起動され `ORCA_TERMINAL_HANDLE` が無い | 専用ターミナルの pane 内で起動する、または専用ターミナルの handle を `ORCA_TERMINAL_HANDLE` に設定して起動する |
| MCP クライアントに接続されない | 未ビルド / stdio 設定 | `npm run build` 後に `npm run dev` で手動起動して確認 |
| `http_token_required` で起動しない | `ORCA_MCP_HTTP_HOST` がループバック外で `ORCA_MCP_AUTH_TOKEN` が未設定 | トークンを設定するか、`ORCA_MCP_HTTP_HOST` を `127.0.0.1` にして `ssh -L` で中継する |
| HTTP で 401 | `Authorization` の欠落 / トークン不一致 / `Bearer` 以外の scheme | クライアントの `Authorization: Bearer <token>` がサーバーの `ORCA_MCP_AUTH_TOKEN` と一致するか確認 |
| HTTP で 403 `Invalid Host` | `Host` が `ORCA_MCP_ALLOWED_HOSTS` に無い | 到達に使うホスト名 / IP を列挙する(`ssh -L` なら `127.0.0.1` のままで通る) |
| HTTP で 403 `Invalid Origin` | ブラウザ発の `Origin` が `ORCA_MCP_ALLOWED_ORIGINS` に無い | 許可リストへ追加する(`Origin` を出さないクライアントは対象外) |
| HTTP で 413 | 要求 body が 4 MiB 超 | 大きな内容は task 参照などの小さなセレクタで渡す(413 のあと接続が切れることがあります) |
| HTTP で 415 | `Content-Type` が `application/json` でない | `Content-Type: application/json` を付けて送る |
| HTTP で 500 | サーバー内部で例外(サーバーは生きたまま続く) | stderr の `[http] request_failed:` を確認してリトライ |
| HTTP で 405(GET / DELETE) | stateless 構成は session 操作を受け付けない | `POST` の JSON-RPC を使う(想定どおりの挙動) |
| `transport_invalid` / `port_invalid` / `host_invalid` | 環境変数の値が不正 | `ORCA_MCP_TRANSPORT` は `stdio` / `http`、port は 0〜65535 の整数、host は空にしない |

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
│  ├─ index.ts          # エントリ(createServer + stdio / http の分岐)
│  ├─ orca/
│  │  ├─ command.ts     # 子プロセス実行の最下層(--json 付与・JSON パース・タイムアウト)
│  │  ├─ client.ts      # 型付き orca CLI クライアント(runner 注入可能)
│  │  ├─ job.ts         # 非同期 Job API の内部モデル(正規化 + submit/poll/result)
│  │  └─ schemas.ts     # ツール入力の zod スキーマ
│  ├─ server/
│  │  ├─ config.ts      # 環境変数の解釈(純粋関数)+ 起動可否の判定
│  │  ├─ auth.ts        # 静的トークンの OAuthTokenVerifier(SDK の gate に差し込む)
│  │  └─ http.ts        # node:http + Host / Origin / Bearer gate + toNodeHandler
│  └─ tools/
│     ├─ result.ts      # 共通の CallToolResult ヘルパー(text / isError)
│     ├─ job.ts         # orca_delegate_task / orca_get_task_status / orca_get_task_result
│     ├─ intervene.ts   # orca_send_message / orca_resolve_gate / orca_cancel_task(変更系はここだけ)
│     ├─ status.ts      # orca_status
│     ├─ readiness.ts   # orca_readiness(runtime / orchestration / skill の前提チェック)
│     ├─ worktrees.ts   # orca_list_worktrees / orca_get_worktree
│     ├─ agents.ts      # orca_list_agents(worktree ps の平坦化)
│     ├─ runs.ts        # orca_list_runs / orca_get_run(run-list / run-show の正規化)
│     ├─ delegate.ts    # orca_delegate(内部実装)
│     └─ message.ts     # orca_message(内部実装)
├─ scripts/
│  ├─ e2e.mjs                 # 実ランタイム E2E(readiness → delegate → poll → gate → result → cancel)
│  ├─ dsh-tui-launcher.mjs    # dsh worker の既定: dsh-tui を起動して待つだけの最小 launcher
│  ├─ copilot-launcher.mjs    # copilot worker 用: COPILOT_ALLOW_ALL=true を設定して copilot を起動する最小 launcher
│  ├─ dsh-acp-worker.mjs      # Orca 注入 → ACP session/prompt に載せ直すブリッジ
│  └─ dsh-headless-worker.mjs # 注入 → dsh --profile headless の argv に載せ直すブリッジ(旧経路)
├─ docs/
│  ├─ templates/acp-cordis.patch.example.yml   # ACP 用ローカル LLM ルーティングのテンプレ
│  ├─ design/streamable-http-transport.md      # HTTP トランスポートの設計案
│  ├─ design/blocked-reasons.md                # poll の blockedReasons の設計
│  └─ design/sub-run-observability.md           # sub-run の観測・取消(§7 に実測での是正記録)
├─ tests/               # orca ランタイム不要の単体テスト(job.test.ts は偽 client)
├─ AGENTS.md            # エージェント向け開発規約
├─ package.json
└─ tsconfig.json        # 開発用(noEmit) / tsconfig.build.json: ビルド用
```

### 開発上の決まり(抜粋)

- 引数は常に **argv 配列**(`execFile(bin, argvArray)`、shell 文字列は作らない)
- stdout は MCP ワイヤー専用。ログ・診断は `console.error` へ
- 失敗はプロトコル例外にせず `isError: true` の CallToolResult で返す
- `worker-start` は readiness 失敗を **`ok:true` の receipt + 終了コード 1** で返すので、
  stdout の `ok:true` を transport 成功として扱う(`isOkEnvelope`)。終了コードを基準にすると
  receipt が `non_zero_exit` になり delegate が `queued` に落ちます
- リポジトリの文章は日本語で書く(README・AGENTS.md・ツールの title/description・テスト名)

開発規約全体は [AGENTS.md](./AGENTS.md) にあります。
