# AGENTS.md — orca-mcp

このリポジトリは **Orca CLI をラップする MCP サーバー** です。
目的は **コーディングのゴールを Commander エージェントと supervised なマルチエージェントワーカーへ
委譲する、Orca CLI のオーケストレーションゲートウェイ**(`package.json` の description と同じ)。
TypeScript (ESM) + `@modelcontextprotocol/server` (SDK v2) + zod v4 + vitest で構成されます。

## コマンド

| 目的 | コマンド |
| --- | --- |
| 依存インストール | `npm install` |
| 型チェック | `npm run typecheck` |
| ビルド(src → dist) | `npm run build` |
| テスト | `npm test` |
| テスト(watch) | `npm run test:watch` |
| 開発実行(ビルド不要) | `npm run dev` |
| 本番実行 | `npm start`(先に `npm run build` が必要) |

## フォルダ構成と役割

```
src/
  index.ts          # MCP サーバーのエントリ。createServer() で全ツールを登録し stdio / http を分岐
  orca/
    command.ts      # orca CLI を子プロセスで実行する最下層(runOrca / buildArgs / OrcaCommandError)
    client.ts       # OrcaClient: コマンド単位の型付きメソッド。runner 注入可能(テストでモック)
    job.ts          # 非同期 Job API の内部モデル(正規化 + delegateTask / getTaskStatus / getTaskResult / sendMessage / cancelTask / resolveGate)
    schemas.ts      # 各ツールの zod inputSchema
  server/
    config.ts       # 環境変数の解釈(純粋関数)+ 起動可否の判定(ループバック外 + トークン無しは拒否)
    auth.ts         # 静的トークンの OAuthTokenVerifier(SDK の verifyBearerToken に差し込む)
    http.ts         # node:http + Host / Origin / Bearer gate + toNodeHandler(createMcpHandler(...))
  tools/
    result.ts       # 共通の CallToolResult ヘルパー(textResult / errorResult / resultOf)
    job.ts          # orca_delegate_task / orca_get_task_status / orca_get_task_result
    intervene.ts    # orca_send_message / orca_resolve_gate / orca_cancel_task(変更系コマンドはここに集約)
    status.ts       # orca_status          … status
    readiness.ts    # orca_readiness       … status + skills installed の前提チェック(インストールはしない)
    worktrees.ts    # orca_list_worktrees  … worktree list / orca_get_worktree … worktree show
    agents.ts       # orca_list_agents     … worktree ps の agents[] を平坦化
    runs.ts         # orca_list_runs       … orchestration run-list / orca_get_run … run-show
    delegate.ts     # orca_delegate        … task-create + dispatch(未登録の足場)
    message.ts      # orca_message         … send / check / reply / inbox(未登録の足場)
tests/              # vitest。子プロセスを実際に起動しない(モック runner / 偽 client)
scripts/
  e2e.mjs           # 実ランタイム E2E(stdio でサーバーを起動し submit→poll→gate→result→cancel)
  dsh-tui-launcher.mjs    # dsh worker の既定: dsh-tui を起動して待つだけの最小 launcher
  copilot-launcher.mjs    # copilot worker 用: COPILOT_ALLOW_ALL=true を設定して copilot を起動する最小 launcher
  dsh-acp-worker.mjs      # Orca 注入 → ACP session/prompt に載せ直すブリッジ(ACP 機能が要る時)
  dsh-headless-worker.mjs # Orca 注入 → dsh --profile headless の argv に載せ直すブリッジ(1 タスク 1 プロセス)
docs/
  templates/acp-cordis.patch.example.yml  # dsh acp プロファイル用パッチのテンプレ(IP 等は置かない)
  design/streamable-http-transport.md     # HTTP トランスポートの設計案(実装前にレビューした案)
  design/blocked-reasons.md               # poll の blockedReasons 設計(kind / role の意味)
  design/sub-run-observability.md         # sub-run 観測・取消の実装計画(§7 に実測での是正記録)
```

## 公開 API の設計 — 非同期 Job API(最優先の設計約束)

外部 AI に見せる面は **submit / poll / result の非同期 Job API**。低レベルすぎる API
(`orca_create_worktree` / `orca_start_agent` / `orca_send_terminal` など)は**登録しない**。
内部で worktree 作成やエージェント起動が必要なら、高レベルツールの実装として隠す。

| ツール | 役割 | 内部コマンド |
| --- | --- | --- |
| `orca_delegate_task` | submit(**Commander 専用**) | run-create(未指定時) → task-create(固定 Commander 指示 + goal + repo + constraints) → worker-start `--worktree new-child --agent <commanderAgent>` |
| `orca_get_task_status` | poll | task-list / dispatch-show / worker-list / gate-list / **run-list**(sub-run 照合)(子タスクは task-list の `parent_id` + sub-run の root 照合で拾う) |
| `orca_get_task_result` | result | task-list / dispatch-show / worker-read / **run-list**(`includeChildren: true` で子タスクの result と出力も集約) |
| `orca_send_message` | intervene(非破壊) | `orchestration send`(必要なら run-use でバインド切替) |
| `orca_resolve_gate` | intervene(非破壊 / Human-in-the-loop) | gate-list → `orchestration gate-resolve`(必要なら run-use でバインド切替) |
| `orca_cancel_task` | intervene(破壊的 / 既定 cascade) | 子孫を**子から順**に worker-stop/abandon → `task-update --status failed` |
| `orca_status` | 観測 | `orca status --json` |
| `orca_readiness` | 観測 | `orca status --json` + `orca skills installed --json`(`commanderAgent` で providers まで見る) |
| `orca_list_worktrees` | 観測 | `orca worktree list --json` |
| `orca_get_worktree` | 観測 | `orca worktree show --json` |
| `orca_list_agents` | 観測 | `orca worktree ps --json` |
| `orca_list_runs` | 観測 | `orca orchestration run-list --json`(**run は poll / cancel の境界**。sub-run 発見の唯一の経路) |
| `orca_get_run` | 観測 | `orca orchestration run-show --id --json` |
| `orca_delegate` / `orca_message` | 未登録(足場) | 低レベルすぎるため公開しない |

### `orca_delegate_task` は Commander API だけ(意味を 2 通りにしない)

- 公開 schema は `spec / title / commanderAgent / constraints / repo / run / deps / parent` のみ。
  `z.strictObject` なので `terminal` / `worktree` / `prompt` / `agent` は **拒否される**。
- このツールは常に Commander を起動する。既存 terminal / worktree への直接 dispatch が必要なら
  内部用の `tools/delegate.ts` を使う(公開しない)。
- `prompt` という語は使わない。Commander へ課する制約は `constraints: string[]` で、
  `COMMANDER_PROMPT` の Constraints 欄に箇条書きで書き込む。
- `COMMANDER_PROMPT` には「orchestration を変更する前に `orca skills get orchestration --full` を
  読み、記憶した CLI 構文を使わない」という Orca 公式の推奨を固定で書き込む。
- 作業ワーカーの選択は Commander 側。MCP 側の語彙は `commanderAgent`(= どの Commander を起動するか)。
- **`commanderAgent` は Orca 側で設定されたエージェント名のみ**(`worker-start --agent` の制約)。
  実機で `"dsh headless"` は `agent_unconfigured`。launcher 登録前の `dsh`(dsh-tui 直接起動)は
  dispatch `failed`。launcher 登録後は **worker でも Commander でも完走する**(2026-10-08 E2E 実測:
  `readiness ready=true` → `delegate running` → `poll#7 children=1` → `poll#9 completed` →
  `result children=1` → `cancel fullyStopped: true`)。
  非対話の Commander が欲しいなら Orca のエージェント設定(`agentCmdOverrides`、CLI からの設定コマンドは無い)に
  起動コマンドを登録してもらう — MCP 側でエージェント引数を組み込むフラグは無い。
  dsh の既定登録コマンドは `dsh-tui .`(pane 実測)。worker にするには launcher を向ける:
  `node <repo>\scripts\dsh-tui-launcher.mjs`(**既定・推奨**、README 参照)/ ACP 機能が要るなら
  `node <repo>\scripts\dsh-acp-worker.mjs` / `node <repo>\scripts\dsh-headless-worker.mjs`。
- **`dsh --profile acp` は ACP の JSON-RPC stdio サーバー**。Orca のターミナル注入を直接向けると
  `-32700 Parse error` が pane に出て始まらない(実測)。必ずブリッジを挟む。ブリッジは
  `session/request_permission` を `allow_once` で機械応答してよい — **claude / codex の承認停止が
  dsh では発生しない**という唯一の利点がある。応答は
  `{ outcome: { outcome: "selected", optionId } }` / `{ outcome: { outcome: "cancelled" } }`。
  `{ selected: … }` は拒否扱いで tool が `failed` になる(実測)。
- **dsh は agent hooks を持つ**(2026-10-06 以降、`orca agent hooks status` で `installed`)。
  旧記録の「dsh は stdin を 1 バイトも受け取れない / dispatch が `agent_readiness` で failed」は
  hooks 導入前の話。報告は `worker_done` 優先、拒否されたら `task-update` に落ちる。
- **pane に生きたプロセスが立っていない dsh は `agent_readiness` を通れない**(2026-10-08 実測)。
  原因は hooks ではなく **launch token の照合**: 登録コマンドの codex / claude は `dispatch.launch_token_hash` が入り
  `state: ready / stage: input_accepted`、`dsh-tui .` を直接起動する / 既存 pane を `--terminal` で指定する
  状態では token が空で `agent_readiness` 失敗(`terminal_handle_stale` / `timeout`)。
  pane env の token は hooks 側に届く(`last-status.json` の dsh 行と `authorityCommitments`)が
  dispatch 側が照合に使えない。**launcher(下)で解消した**。readiness が落ちる間の報告は
  `task-update` の事後報告になる(`success` は無効。`consumer_fenced` なら自分の terminal だけ
  `run-use --id <run>` で 1 回再バインド)。
- **dsh-tui は注入を受け付けられる**(実測: `dst .` pane へ `terminal send` → pwsh 実行して応答)。
  dsh が動かない原因ではない。readiness が gate するので **dispatch 経由の注入が届かない**だけ。
  `agentCmdOverrides` は `terminal create --command "dsh-tui ."` も差し替える(`dst` 経由は無関係)。
- **ブリッジは起動直後に dsh-tui を先読みで起動し、並行して dispatch を照合する**(2026-10-08 実測)。
  対話 pane はそのまま TUI で作業でき、worker pane は照合が当たった時点で TUI を殺して worker モードに入る
  (`DSH_ACP_LOOKUP_MS` 既定 180 秒。worker の dispatch が見えるのは readiness 失敗後 ~110 秒、
  worker-start 完了 ~170 秒の窓がある)。`ORCA_AGENT_LAUNCH_TOKEN` は**対話 pane にも入る**ので
  判別に使わない(ログのみ)。殺した TUI のマウス追跡 CSI が stdin に漏れるので、
  代替画面/追跡を解除して 1 秒ぶん stdin を drain してから注入を受ける(実測でノイズターン発生)。
  **この状態で `agent_readiness` を通過した**(実測: `state=ready / stage=input_accepted` → `completed`)。
  対話で dsh-tui だけ使いたい人の正解はブリッジを通さない **`dst .`**(エイリアス)。
- **dsh worker の既定は launcher(`scripts/dsh-tui-launcher.mjs`)**(2026-10-08 実測)。dsh-tui を起動して
  終了を待つだけの最小 launcher を `agentCmdOverrides.dsh` に向けると `state: ready / stage: input_accepted`
  (~15 秒)で通過し、注入が TUI に入り、ワークが完走して `worker_done` で settlement される
  (実測: `poll#3 completed` / provenance `worker_report`)。**ACP ブリッジは必須ではない**
  (ブリッジの残る価値は permission 機械応答・MCP 注入・マルチターンセッション・モデル指定)。
  対話で dsh-tui だけ使いたい人の正解はブリッジ/launcher を通さない **`dst .`**(エイリアス)。
- **報告の本体は `worker_done`**。dispatch 生存中の `task-update --status completed` は CLI が拒否する
  (実測: "cannot move to completed while supervised Dispatch … is active")。`task-update` は
  dispatch が無い / 落ちた後の事後報告専用。
- **dsh の LLM はローカルゲートウェイへ設定する**(key 不要)。手宣言ルートで `apiKeyEnv` を省くと
  pi-ai が `No API key for provider` で落とすので、`headers: {Authorization: Bearer local}` で
  通す(pi-ai の `getClientApiKey` が非空 authorization を `"unused"` として採用する)。
- **エージェント側の承認プロンプトが E2E の最大の停止点**(claude / codex とも実測)。
  `orca terminal send` は承認プロンプトへの入力を `agent_prompt_blocked` で拒否するため、
  MCP 側・自動化側から解除できない(人間が UI で答える)。E2E を通すならエージェント側の許可設定を
  先に緩める(Claude: 下記 / Codex: 下記)。
- **codex の承認は `--approve-for-me` で解く**(2026-10-08 実測・本運用)。`agentDefaultArgs.codex` に設定すると
  承認要求が workspace-write sandbox の自動レビューへ流れて停止しない。`approval_policy="never"` +
  `sandbox_mode="workspace-write"` は**逆効果**(コマンドが自動拒否され「blocked by policy」)。
  `--dangerously-bypass-approvals-and-sandbox` は通るが sandbox を完全に外す最終手段。
  `~/.codex/config.toml` の変更は不要(実行後に復元した)。
- **claude の承認は Orca 側の `agentDefaultArgs.claude` で解く**(2026-10-08 実測・worker 完走)。
  `--permission-mode acceptEdits --allowedTools Bash Read Edit Write Glob Grep` で承認停止ゼロ
  (`worker-start ready` → `poll#13 completed`、pane に `⏵⏵ accept edits on`)。セッション限定なので
  claude 全体の設定を変えなくてよい。**`--allowedTools` はツール名そのもの(`Bash`)で許可する**こと:
  `Bash(orca:*)` のプレフィックス指定は複合コマンドの全サブコマンド要求に負けて
  `orca skills get orchestration --full 2>&1 | head -300` が `head` で承認停止した(実測)。
  カンマ区切りは空白を含まないので Orca の引数分割で 1 要素として届く。
  `--permission-mode` の choices は 2.1.293 実機 help で `acceptEdits / auto / bypassPermissions / manual / dontAsk / plan`。
  `~/.claude/settings.json` の `permissions.allow` + `permissions.defaultMode`(実測で完走:
  `Bash(orca:*)` 等 + `acceptEdits`)でも解けるが、**そのマシン全体の claude に効く**ので運用側は
  `agentDefaultArgs` を既定にする。`--dangerously-skip-permissions` / `bypassPermissions` は全面バイパスの最終手段。
- **`--permission-mode auto` はローカルゲートウェイ経由で使えない**(2026-10-08 実測)。pane には
  `⏵⏵ auto mode on` と出る(設定は届く)が、起動時に「this session isn't eligible because your requests go
  through <gateway>」の notice で Enter 待ち(`orca terminal send --text "\n"` は ok:true で解除できる)、
  以降 `The auto-mode safety classifier timed out` / 「Both shells are gated by the same unavailable
  classifier」で shell・Write が gate され続け 28 分 poll しても未完了。ゲートウェイが safeguards contract を
  実装する必要がある。`dontAsk` は未承認を自動拒否(止まらないが仕事も落ちる)。
- **claude の `Login expired` / `Not logged in` は権限ではなく auth 切れ**(2026-10-08 実測)。この状態の worker は
  `dispatched` のまま進まない(pane にエラーが出る)。Orca 側のアカウント紐づけで解消した。pane 側には
  user スコープの `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` が必要(プロセス env スナップショットだと欠ける)。
- **copilot は Commander でも Worker でも完走する**(2026-10-08 E2E 実測・本運用)。
  `agentCmdOverrides.copilot = node` + `agentDefaultArgs.copilot = "…\scripts\copilot-launcher.mjs" --allow-all-tools` で
  `readiness ready=true` → `delegate running` → `poll#2 completed` → `result completed` → `cancel fullyStopped: true`
  (この goal では children=0、分解せずに完走した)。hooks は `orca agent hooks status` で `installed`
  (`~/.copilot/hooks/orca.json`)。
- **copilot の起動停止は folder trust**(2026-10-08 実測)。未設定の worker は `agent_readiness` で
  `Agent startup blocked: agent-trust-workspace` に落ち、pane に
  「Confirm folder trust … Do you trust the files in this folder?」が出る(dispatch 経由の注入が届かない)。
  **解除できるのは env `COPILOT_ALLOW_ALL=true` だけ**だった(実測: pane の確認表示が消える):
  `--add-dir .` / `--allow-all-paths` / `--allow-all-tools` では確認表示は消えず、`trustedFolders` は親ディレクトリを
  信頼しても子 worktree に効かない(完全一致。`copilot config trustedFolders` は `Unknown settings key segment`)。
  値は正確に `true` であることが効く(`1` / `yes` / `on` はツール自動承認だけで trust が残る)。
  `agentDefaultEnv` キーは `orca-data.json` に存在するが(goose の空エントリのみ)UI からの設定経路が
  見つかっていないので、**launcher(`scripts/copilot-launcher.mjs`)で env を設定して起動する**。
- **copilot は共有 skills root を読む**(2026-10-08 実測)。`copilot skill list` の "Personal skills" に
  `orchestration` と `orca-cli` が並び、源は `~/.agents/skills/`。なので `orca_readiness` の
  `SHARED_SKILLS_ROOT_AGENTS` に copilot を含める(dsh と同じ型)。
  `orca skills install --agent copilot` は `Invalid agents: copilot` で exit 1(skills CLI 側の名前は
  `github-copilot`)。`--json` は `--dry-run` のみ対応(実インストールは npx の出力を stream する)。
- **copilot の承認系フラグ**(実機 help 1.0.93): `--allow-tool <tools>`(承認なしで使うツール)/
  `--allow-all-tools`(非対話モードでは必須)/ `--allow-all-paths` / `--allow-all-urls` /
  `--allow-all` = `--yolo`(全面)。設定キーは `defaultPermissionMode`(`manual` / `assisted` / `allow-all`)で、
  `--mode interactive|plan|autopilot`。`banner` は `once` / `always` / `never`。
- **子 worker の深さは Orca 側の設定**(2026-10-08 実測)。既定は `settings.nestedWorkerMaxDepth = 1`
  (`NESTED_WORKER_MAX_DEPTH_DEFAULT`。root coordinator が depth 0、第一世代 worker が depth 1)。
  **MCP が起動する Commander は `worker-start` 経路なので既に depth 1** — その子 worker は depth 2 で
  `nested_worker_depth_exceeded`(応答に `depth 2, max 1` と出る)になり、`new-child` / `new-top-level` /
  `current` のいずれでも起動できない。UI は Settings → Orchestration → "Nested worker depth"(1 以上の整数、
  不正値は 1 にクランプ)。`2` に上げると実測で通った: 分解 goal で `poll#4 children=4` → `poll#7 completed`、
  子タスク 3 件が copilot worker で `succeeded`(並列)、`result children=4` / `filesModified ["README.md"]`。
  1 のままだと Commander は正しく blocked 報告する(`provenance: worker_report` /
  `subject: "Blocked: nested_worker_depth_exceeded"`)ので、E2E の分解 goal は depth 2 で回すこと。
  設定の live 値は `profile-state.db`(sqlite)側にある — `orca-data.json` は export で遅れるため、
  反映確認は DB をコピーして読む(アプリ起動中は本体ファイルが読めない)。
- **`repo` は repo セレクタ**(E2E 実機確認): `id:<repoId>` / `path:<repo home>` は解決できるが、
  worktree の displayName(`name:weever`)や worktree path は `repo_not_found`。repoId は
  `orca worktree current --json` の `result.worktree.repoId`。
- **`worker-start` だけ transport timeout を 180 秒**(`WORKER_START_TIMEOUT_MS`)。worktree 作成 +
  setup hook + エージェント起動 + 初ターン観測まで同期で走るため、既定 30 秒では SIGKILL される(実測)。
- `queued`(worker-start 失敗)は放置しても進まない。`nextActionHint` が「delegate し直す / cancel する」を
  明示する(worker / dispatch が 0 件のとき)。

### 非同期の決まり

- **MCP 呼び出しの中でワーカーの完了を待たない。** `orca_delegate_task` は
  `{ taskId, state: "running" }` を返して終わる。30 分ブロックする同期委譲は作らない。
- 完了の監視は呼び出し側の poll。poll は常に短時間で返す(タイムアウトは子プロセス側のみ)。
- submit は**部分成功を返せる**: task-create まで成功したらタスクは生き、
  worker-start 失敗は `state: "queued"` + `warnings` で伝える(例外にしてタスクを消さない)。
- 状態は正規化する(`queued/running/blocked/completed/failed/cancelled`)。CLI 生の値は
  `rawStatus` に残す。phase は worker/gate から推定し、根拠が無ければ `starting` に寄せる
  (推定には Commander 配下の child worker も含める)。
- poll は **Commander の配下を見せる**: `children` に**直接の子タスク**(`parent_id` 一致、最大 20 件)と
  その worker の `state` を入れる。子タスクを見るために追加の orca コマンドを足しにいかない
  (task-list 1 回で揃う)。打ち切りは `childCount`(実件数)/ `returnedChildCount` / `childrenTruncated` で正直に伝える。
  **孫以降は `children` に出さない**(その子の poll で見る)。deep chain より並列を Commander Prompt で推奨しているので
  ツール説明に "direct children" と明記する。
- **cancel はジョブ単位(cascade 既定 true)**: 親 Commander だけ止めて子 Worker を走らせたままにしない。
  `collectDescendants` で子孫を post-order(子から順)に並べ、`worker fence → task failed` を各タスクに適用する。
  **2 段階(preflight → mutation)**: 全 target の dispatch を読み切ってから叩く。上限超過(子孫 12 件 /
  1 タスクあたり dispatch 3 件)は**何も変更する前に** `cancel_scope_too_large` /
  `cancel_dispatch_scope_too_large` で断る — silent slice は「一部しか止めていないのに `cancelled: true`」の
  元凶(post-order 末尾の root 漏れ、4 件目の dispatch 生存)。終端状態の子は触らない。
  子タスクの確定失敗は `warnings` に留める。
- **Commander(root)の fence 失敗は cancel 成功にしない**: 対象タスクの fence に 1 件でも失敗したら
  `cancel_incomplete`(`state: "partial"` / `cancelled: false` / `fullyStopped: false`)で**対象 task は更新しない**。
  「論理 cancel」と「実プロセス停止」のズレを放置しないため。成功応答には `fullyStopped`(fence 全成功か)を載せる。
- **result の子集約は明示されたときだけ**: `orca_get_task_result` の既定は Commander だけ。
  `includeChildren: true` で子 10 件・worker-read 8 件まで(応答サイズと CLI 呼び出し数の抑制)。
  子行に `dispatch_id` があれば dispatch-show を足しにいかない。
- `outcome` は `worker_done` 専用: 缺失は `outcome_required`、他種別への付与は `outcome_not_allowed`、
  `dispatchId` 欠けは `dispatch_id_required` で CLI へ叩き合う前に弾く(`--outcome` を client が渡さないと
  CLI 側で worker_done が通らない。CLI は dispatchId も要求する)。
- ジョブ層の語彙は `JobError`(`task_not_found` / `task_id_missing` / `run_create_failed` /
  `outcome_required` / `outcome_not_allowed` / `dispatch_id_required` / `cancel_incomplete` /
  `cancel_scope_too_large` / `cancel_dispatch_scope_too_large` / `gate_not_found` / `gate_run_mismatch` /
  `cancel_ownership_unverified`)。
  CLI 側の語彙(`run_required` など)はそのまま転送する。
- `state: "cancelled"` は **MCP 側の論理状態**(CLI に native status が無い)。実体は
  `status: failed` + `result: "cancelled: <reason>"`。README にその旨を 1 行書く。
- poll の `blockedReasons[]`(設計: `docs/design/blocked-reasons.md`): `kind` は `gate / task_report /
  agent_prompt / unknown`。`blocked` でも gate が無いことがある(Commander の blocked 報告 = `task-update` の `result`、
  エージェントの承認プロンプト)ので、**`blocked` = `decision_gate` と決めつけない**。pending のゲートがあるときだけ
  phase は `decision_gate`、無ければ `blocked`。gates は `gate-list --run` で全件取り、対象タスク + 直接の子タスクに絞る。
  **gate 行には必ず `runId` を載せる**(行の `run_id` を優先、無いときは照合した Run 名義で補う)。
  `gate-resolve` に `--run` が無く `orca_resolve_gate` は `run` 必須なので、呼び出し側が所属 Run を知れていなければ
  解決に使えない(sub-run のゲートは呼び出し元 Run と違う Run にある)。`blockedReasons` の gate `detail` にも
  `gateId` / `runId` / `options` を入れる。追加の読み取りは `agent_prompt` の `worker-read`(最大 2 worker)だけで、変更系は呼ばない。
- poll は worker の `projection.attention.requiresAction` を `attentionRequired` / `attentionNotes`
  (行には `attentionCategories`)として出す。ゲートが pending でないのに止まる典型はエージェント側の
  ツール承認プロンプト(E2E 実測)。Commander Prompt には「答えられない承認待ちで止めない / 既存 Run を使い
  深さ・circuit-break・失敗 dispatch・binding 回避で新しい Run を作らない / 自律 coordinator が child Run を
  作るなら objective マーカーと最終報告で関連付ける / gate 作成失敗は承認を進めず停止して人間に依頼する」を
  固定で書き込む(`commanderSpec` のテストで文言を固定する)。
- 出力は既定で切り詰める(`specPreview` 200 字、worker 出力 4000 字、agents の prompt 200 字)。

## 登録ツール(現状)

`createServer()` は上記 13 個だけを登録する。`delegate.ts` / `message.ts` は足場として
ファイルを残す(テストは生かす)。登録を外したツールのファイルは削除しない。

読み取り・poll 系の決まり:

- 観測ツールの `annotations` は `{ readOnlyHint: true, openWorldHint: false }` 固定。
  `orca_delegate_task` / `orca_cancel_task` は `readOnlyHint: false` + `destructiveHint: true`、
  `orca_send_message` / `orca_resolve_gate` は `readOnlyHint: false` + `destructiveHint: false`。
- 大きな欄は既定で省略する(`orca_list_agents` は `prompt` を 200 文字で切り詰め、
  `lastAssistantMessage` は `full: true` のときだけ)。
- 1 ハンドラーで複数の orca コマンドを呼んでよいのは **poll / result の読み集め**
  (`task-list` + `dispatch-show` + `worker-list` + `gate-list` + `run-list`)、submit の既定フロー、
  観測の `orca_readiness`(`status` + `skills installed`)、
  そして **介入ツール(`orca_send_message` / `orca_resolve_gate` / `orca_cancel_task`)だけ**。
  poll / result / 観測ツールが変更系コマンド(task-update / worker-stop / gate-resolve / run-use)を呼ぶことは禁止。
- poll の応答に生の JSON をそのまま入れず、正規化した上で `rawStatus` 等の生値を添える。

### Run バインドと `consumer_fenced`

orca CLI は **呼び出し元ターミナルを 1 つの Run にバインド**する。バインドと違う Run に
対して `task-update` / `send` / `gate-resolve` などをすると `consumer_fenced` で拒否される
(メッセージにバインド中の Run ID が入る)。`runMutation()` がそのときだけ
`run-use --id <run>` でバインドを切り替えて **1 回だけ**再試行する。それ以外で
`run-use` を勝手に呼ばないこと(呼び出し元の pane の状態が変わるため)。

- **バインドはプロセス共有の状態**。並行リクエストが `run-use` を交互に叩くと、A が切り替えた
  バインドを B が書き換えて A の再試行が別 Run に届く。`runMutation()` は `MutationQueue` で
  **変更系を 1 本に直列化**し、`run-use` + 再試行の並びを他リクエストと挟まない。
  読み取り(task-list / worker-list など)はロックしない。
- `gate-create` / `gate-resolve` には `--run` が無い(Run スコープはバインドで決まる)。
  なので `orca_resolve_gate` の `run` は必須で、`gate-list --run <run>` で対象を読んでから叩く。
  **`run` はゲートの所属 Run**(poll の `gates[].runId`)でなければならない — 行の `run_id` が指定 Run と
  一致しないなら `gate_run_mismatch` で**何も変更する前に**拒否する(`runMutation` が gate 側の Run へ
  binding を切り替え、別 Run のゲートを解決してしまう。実測: ゲートは sub-run にあり呼び出し元 Run は 0 件)。

### sub-run(Commander が別の Run を作ってしまう事故)の扱い

`task-list` は **Run スコープ**で、Run には parent/child の系譜が無い。Commander が自分の terminal で
`run-create` を叩くと、その sub-run 内の task / worker / gate は呼び出し元 Run の poll・cancel・result から
**完全に invisible** になる(実測: `childCount: 0` のまま Commander が completed になり、cascade cancel が
sub-run の worker を走りたままにした)。設計は `docs/design/sub-run-observability.md`、§7 に実測での是正記録がある。

- **照合キーは `coordinator_handle` だけ**。sub-run の `coordinator_handle` はその Run を作った terminal の
  handle なので、Commander の handle(タスクの `assignee_handle` + worker の `agentTerminalHandle`)と一致する。
  `coordinator_handle` が `null` の Run は照合不能なので除外し、呼び出し元 Run 自身も除外する。
  対象タスクの `created_at` より **24 分以上前**の Run は除外(terminal 再利用で古い Run が同じ handle を
  持つリスク。task-list はローカル時刻、run-list は UTC なので厳密比較はしない)。照合は最大 `MAX_SUB_RUNS = 3`。
- **sub-run 内の root は `parent_id` では特定できない**。実測では sub-run の子 6 件の `parent_id` は
  sub-run 内で Commander が作った新しい root を指し、呼び出し元 Run の Commander task を指す行は無い。
  root は「`parent_id` がその Run 内に無い + `created_by_terminal_handle` が Commander の handle」で選ぶ。
- **探索を走らせる条件は worker / dispatch が 1 件以上あるとき**(queued で探索を走らせない)。
  `childCount == 0` だけを条件にすると、親 Run にも sub-run にも子がある場合に sub-run が落ちる(実測)。
- **run-list / worker-list は cursor でページングする**(実測: `run-list --limit 60` は 60 件 + `nextCursor`、
  `worker-list` は 100 件で `page.hasMore` / `page.nextCursor`)。上限は `MAX_SCAN_PAGES = 5` /
  `MAX_WORKER_PAGES = 3` で、打ち切ったら `subRunScanComplete: false` + warning を出す(1 ページだけ見て「無い」と言わない)。
- **所有関係は 4 段階で判定し、破壊的操作には `verified` だけ使う**(`classifySubRunOwnership`):
  `verified` = coordinator_handle 一致 + root の `created_by_pane_key`(tabId:leafId)と
  `created_by_process_incarnation`(ptyId:incarnationId)が `terminal list` と一致し矛盾なし、
  `probable` = handle 一致のみ、`unverified` = handle 一致なし / root 特定不能、
  `conflicting` = 来歴の矛盾、または objective マーカーが別の Run を指す。行には `ownership` /
  `cancelEligible` / `verificationReasons` / `discoverySource` を載せる。
- **objective のマーカーは発見の候補にだけ使う**(書式 `orca-mcp-parent: run=<caller runId> task=<task id>`、
  定数 `SUB_RUN_MARKER_PREFIX`)。誰でも書けるのでマーカー単独で `verified` にしない。来歴と組み合わせて使い、
  呼び出し元 Run と違う Run を指していれば `conflicting`。
- 集約は `includeSubRuns`(既定 true)で、poll / cancel / result すべてに効く。無効化は逃げ道として残す。
  集約で出た子行には必ず `sourceRunId` を載せる(呼び出し元 Run の子と区別するため)。
  `subRunsDiscovered` / `subRuns[]` を応答に載せ、**孫以降は `children` に出さない**(呼び出し元 Run の
  direct children semantics を保つ)。
- **cancel は sub-run の部分木を呼び出し元 Run の Commander より先に止める**(sub-run の worker が
  Commander より生き残ると job が走り続ける)。上限 12 件は sub-run 込みの件数で判定する。
  `task-update` は対象タスクの Run 名義で叩く(`runMutation` は既に Run 名義なので追加の引数で渡す)。
- **cancel の auto 対象は `verified` の sub-run だけ**。検証に失敗した sub-run が 1 件でもあれば
  preflight で `cancel_ownership_unverified` を返し、**破壊的操作を一切行わない**(probable を叩くと
  別 job・別 terminal の worker を止める)。逃げ道は `includeSubRuns: false` / `cascade: false`。
  同一 dispatch は 1 回だけ叩く(`fencedDispatchIds`)。
- **停止後は worker-list を読み直す**(`residualLiveWorkers`)。生存 worker が 1 件でもあれば
  `residualWorkers[]` に載せて `fullyStopped: false`。探索を打ち切った場合も `fullyStopped: false`。
- 集約の失敗(run-list 読めず / sub-run の task-list 読めず)は **poll / cancel / result を壊さず `warnings` だけ**添える。
  観測でしかないので cancel では対象を絞る(変更系を sub-run に増やさない)。
- `run-list` / `run-show` は読み取り専用なので poll / result ハンドラーで呼んでよい(AGENTS.md の読み集めの範囲)。
  sub-run 集約で `run-use` 等の変更系を呼ぶことは禁止。

## HTTP トランスポートの決まり(2026-10-08 実装・実測)

既定は **stdio**。`ORCA_MCP_TRANSPORT=http` のときだけ HTTP で立つ(既存の登録経路・挙動は不変)。

- **stateless 既定**。`createMcpHandler((ctx) => createServer())` で **1 リクエスト 1 個の `McpServer`**。
  `Mcp-Session-Id` / session map / transport map は作らない。単一 transport を複数クライアントで共有しない
  (server/transport を共有する形はクロスクライアントの応答漏洩になる — SDK の GHSA-345p-7cg4-v4c7 が同じ型)。
  2025 世代の legacy 経路は SDK 既定の `legacy: "stateless"` に任せる(**GET / DELETE は 405**)。
- **Node ↔ Web Standard の変換を書かない**。`@modelcontextprotocol/node` の `toNodeHandler` を使う
  (SSE の backpressure と 4 MiB 上限の 413 を処理してくれる)。`http.ts` の責務は
  「サーバー生成 + gate 合成 + 起動 / 停止」に留める。
- **401 / 403 を自前で組み立てない**。Bearer は `requireBearerAuth` / `verifyBearerToken` +
  `bearerAuthChallengeResponse`(`WWW-Authenticate` 付き)。`Host` / `Origin` は node 形の guard
  (`hostHeaderValidation` / `originValidation`)が **自分で 403 を回答する**ので、
  `false` を返したらそのリクエストには一切触らないこと。
- **静的トークンの `AuthInfo.expiresAt` は検証時刻 + 3600 秒**。SDK は `expiresAt` 未設定の token を拒否する。
  起動時刻から計算すると長時間起動で自分自身の token が失効する(実装前に気づいた罠)。
- **ループバック外 + トークン無しは listen 前に起動を拒否する**(`http_token_required`)。警告では足りない。
  `0.0.0.0` / 特定 NIC IP への direct bind は非推奨(`ssh -L` / TLS proxy / VPN の内側で使う)。
- **`Host` 許可リストは bind 先と連動する**。特定 NIC IP に bind すると、その IP で叩くクライアントの
  `Host` が許可リストに無いと 403 で全滅する(`missingHostnames` が起動前に警告する)。
  `ssh -L` 経由なら `Host` は `127.0.0.1` のままなので既定の localhost 系で通る。
- **bind 用アドレスと `Host` 許可リスト用 hostname は別の表記**。`normalizeListenHost` は括弧を外す
  (`[::1]` → `::1`)、`normalizeAllowedHostname` は括弧を付ける(`::1` → `[::1]`)。
  `config.host` は **bind 用(`::1`)**、`allowedHosts` / `allowedOrigins` は **許可リスト用(括弧付き)**。
  `server.listen(0, "[::1]")` は Linux の getaddrinfo で `ENOTFOUND`(実測: Windows の Node 24 は通す)。
- **gate は routing より前**(`404` より先に Host → Origin → Bearer)。通さないリクエストに 404 を返さない。
- **リクエスト境界で例外を拾う**(`serve()` の `.catch()`)。未処理の promise 失敗はプロセスを殺す。
  応答未送信なら `500` + JSON-RPC `-32603`、送信済みなら `res.destroy()`。診断は stderr、プロセスは生き続ける。
- `Content-Type` が `application/json` でない要求は **415**(SDK 側が返す)。
- **413 のあと接続が切れることがある**(server が 413 を書いて socket を壊す → `ECONNRESET`)。
  テストはステータス固定にせず「**handler に到達しない**(`orca` が 1 回も叩かれない)+ 同じサーバーが使える」で検証する。
- 検証済み `AuthInfo` は factory まで届く(`createMcpHandler` の context 経由)。stateless でも client 情報を
  リクエスト単位で使える。
- 実測した応答: 4 MiB 超過は **413**(`handler` に到達しない)/ `Host` 不正は **403** `Invalid Host` /
  `Origin` 不正は **403** `Invalid Origin`(`Origin` を出さないクライアントは通る)/
  `Bearer` 以外の scheme と不一致は **401**(`bearer` の大小文字は問わない)/
  `close()` 後は connection refused / 2 クライアント同時で応答が混ざらない(id と本文が対応)。
- **`127.0.0.1` bind は LAN から到達しない**(実測: loopback は 200、LAN IP は接続拒否)。
  別 PC からは `ssh -L 8765:127.0.0.1:8765` が第一選択。
- 新規依存 `@modelcontextprotocol/node`(`^2.1.1`、peer は `@modelcontextprotocol/server: ^2.3.0`、
  内包に `hono` / `@hono/node-server`)。`npm install` が dev 依存を省略する環境では `npm install --include=dev`
  が要る(`npm config get omit` が `dev` の環境で `npm install <pkg>` をすると vitest が消えた実測あり)。
- 設計案は `docs/design/streamable-http-transport.md`。

## 決まりごと

### 心臓部(command.ts)のセキュリティ — 最優先

- **shell 文字列を絶対に作らない。** `exec(\`orca ${userInput}\`)` は command injection。
  実行は `execFile(bin, argvArray)`(`shell: false` 固定)のみを使うこと。
- 引数は常に **argv 配列**。ユーザー入力は 1 要素としてそのまま渡す(エスケープ不要、
  shell に解釈させること自体を避ける)。
- `runOrca` は失敗時に例外を投げず `OrcaCommandResult` を返す:

  ```ts
  interface OrcaCommandResult<T> {
    ok: boolean;
    data?: T;                      // stdout の JSON 解析結果
    error?: { code: string; message: string };        // transport 側の失敗
    orcaError?: { code: string; message: string; data?: unknown }; // CLI が返す ok:false
    args: string[]; exitCode: number; stdout: string; stderr: string;
  }
  const result = await runOrca(["status", "--json"]);
  if (!result.ok) { /* result.error.code で分岐 */ }
  ```

- 失敗コードは `spawn_failed / timeout / max_buffer_exceeded / non_zero_exit / invalid_json` の
  安定した識別子のみ。新しい失敗の形を足すときは型にも追記する。
- **transport と CLI の意味は別軸で持つ。** `error` は終了コード等の分類、`orcaError` は
  stdout の `ok:false` エンベロープが運ぶ CLI 側の理由(`run_required` など)。
  終了コード 0 でも `ok:false` は入り得る(`ok: true` のまま `orcaError` だけ載せる)。
  **逆も実測**: `worker-start` は agent_readiness 失敗時に **ok:true の receipt を出して終了コード 1**
  で抜ける。stdout が `ok:true` エンベロープなら transport 成功として `data` を返し、
  `exitCode` だけ診断値として残す(`isOkEnvelope`)。終了コードを主人にすると
  receipt が丸ごと `non_zero_exit` になり delegate が queued に落とす(E2E 実測)。
- 例外化はクライアント層(`OrcaClient.call`)だけが行う。ツール層は
  `OrcaCommandError.code` を応答に載せて返す。このとき **`orcaError` があれば transport の
  code より優先する**(モデルに `non_zero_exit` より `run_required` を伝える)。
- 失敗はプロトコル例外にせず `isError: true` の CallToolResult で返す
  (`src/tools/result.ts` の `resultOf` を使う)。

### 一般

- **stdout は MCP ワイヤー専用**。ログ・診断は必ず `console.error`(stderr)へ。
  stdout に雑な出力を混ぜるとプロトコルが壊れます。
- orca CLI 呼び出しは `--json` 前提(`buildArgs` が既定で付与)。人間向けテキスト出力の解析はしない。
- 新しいツールは `src/tools/<name>.ts` に `registerXxxTool(server, client)` を書き、
  `src/index.ts` の `createServer()` で登録する。inputSchema は `src/orca/schemas.ts` に置く。
- orca CLI の新しいコマンドは `OrcaClient` にメソッドを追加する。
  引数組み立ては純粋な配列操作(`buildArgs`)に保ち、プロセス起動は `command.ts` の
  `execFile` に集約する(他ファイルで `spawn` / `exec` を使わない)。
- バイナリパスは `ORCA_BIN` 環境変数で上書き可能(既定: PATH 上の `orca`)。
- **リポジトリの文章は日本語で書く**(README・AGENTS.md・`package.json` の description・
  ツールの title/description・テスト名)。`keywords` のような検索タグは英語のままにする。
- ESM なので相対 import は `.js` 拡張子付き(`import { x } from "./client.js"`)。
  型のみ import は `import type`(`verbatimModuleSyntax`)。
- テストは orca ランタイム不要。`CommandRunner` の注入点を使うこと。

## orca CLI 側の前提

- 大半のコマンドは起動中の Orca ランタイムを必要とします(未起動なら `orca open`)。
- コマンド仕様の確認は `orca --help` / `orca orchestration <cmd> --help` / `orca agent-context --json`。
- **`task-update` に `--spec` は無い**(実機 1.4.222 help 実測: `--id / --status / --result / --run /
  --from / --retry-request` のみ)。なので delegate 後に spec へ値を焼き込む書き直しはできない。
  `COMMANDER_PROMPT` へ注入できるのは `task-create` の前に決まる値(`{{runId}}`)だけ。
- **`worker-start` には `--run` がある**(実測)。`gate-create` / `gate-resolve` には無い。
  `run-list` は `--limit / --cursor`、`run-show` は `--id` を取る。`run-list` の `nextCursor` は
  base64 の keyset(`{createdAt,id}`)で、help 文の「line cursor」とは実体が違う。
- **公開サイトの掲載は CLI バージョンに追いつかないことがある。** `worker-abandon` は実機 1.4.220 の
  `orca orchestration --help` に存在する("Fence a worker without claiming its process stopped"、
  資源を残しプロセス/filesystem に触らない)が、公式ドキュメントの掲載有無は別軸。
  新しいコマンドを公開 API に載せる前に**実機で `--help` を確認**し、README にはその根拠を書く。
