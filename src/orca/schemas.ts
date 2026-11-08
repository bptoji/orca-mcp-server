import { z } from "zod";

/** 各 MCP ツールの inputSchema。zod v4 の Standard Schema として registerTool に渡す。
 *  orca_status は入力なし。以下は読み取りツール(list_worktrees / get_worktree /
 *  list_agents / get_task_status)と delegate / message 用の定義。 */

export const listWorktreesInputSchema = z.object({
  repo: z
    .string()
    .min(1)
    .optional()
    .describe("対象リポジトリのセレクタ(id:<id> / name:<name> / path:<path>)"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("取得するワークツリー数の上限(省略時は CLI 既定)"),
});
export type ListWorktreesInput = z.infer<typeof listWorktreesInputSchema>;

export const getWorktreeInputSchema = z.object({
  worktree: z
    .string()
    .min(1)
    .describe(
      "ワークツリーセレクタ(identity:<key> / id:<repo>::<path> / name:<displayName> / branch:<branch> / issue:<number> / path:<path>、または active / current)",
    ),
});
export type GetWorktreeInput = z.infer<typeof getWorktreeInputSchema>;

export const listAgentsInputSchema = z.object({
  worktree: z
    .string()
    .min(1)
    .optional()
    .describe(
      "この文字列が worktreeId / branch / displayName / repo / path に含まれるワークツリーだけに絞る(部分一致)",
    ),
  state: z
    .string()
    .min(1)
    .optional()
    .describe("エージェントの状態で絞る(例: working / idle / waiting。部分一致)"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("走査するワークツリー数の上限(worktree ps --limit)"),
  full: z
    .boolean()
    .default(false)
    .describe("true にすると prompt 全文と lastAssistantMessage を含める(既定は要約)"),
});
export type ListAgentsInput = z.infer<typeof listAgentsInputSchema>;

/**
 * orca_delegate_task は **Commander API 専用**。
 * 公開する語彙は「ゴール + 制約 + どの Commander を起動するか」だけ。
 * 既存 terminal / worktree への直接 dispatch は受け付けない(意味が 2 通りに
 * なってしまい、同じツール名で 2 つの系を隠すことになるため)。
 * 低レベルな直接 dispatch が必要なら内部用の tools/delegate.ts を使う。
 */
export const delegateTaskInputSchema = z.strictObject({
  spec: z
    .string()
    .min(1)
    .describe("Commander に渡すゴール(タスク仕様)。これ 1 本で委譲できる"),
  title: z
    .string()
    .min(1)
    .optional()
    .describe(
      "タスクの表示タイトル(task-title と Commander worker の worktree 名に使う)。省略時は spec とタスク ID から worktree 名を作る",
    ),
  commanderAgent: z
    .string()
    .min(1)
    .default("codex")
    .describe(
      "起動する Commander Agent の id(既定 codex)。実際の作業ワーカーを選ぶのは Commander 側",
    ),
  commanderModel: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Commander の provider model id(worker-start --model)。Orca が対応するのは claude / codex / cursor / antigravity / muse で、他のエージェントは自分の設定の model で起動する。省略時はエージェントの既定",
    ),
  commanderEffort: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Commander の推論レベル(worker-start --effort)。commanderModel と一緒に指定する(単独指定は effort_requires_model で拒否)",
    ),
  constraints: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Commander に課する制約。Commander 指示の Constraints 欄に箇条書きで入る(例: 既存 API を変えない / テストを追加する / マージしない)",
    ),
  repo: z
    .string()
    .min(1)
    .optional()
    .describe("対象リポジトリのセレクタ(id:<id> / name:<name> / path:<path>)"),
  run: z
    .string()
    .min(1)
    .optional()
    .describe("対象の orchestration Run ID(省略時は新規 Run を作成する)"),
  deps: z.array(z.string().min(1)).optional().describe("依存するタスク ID の配列"),
  parent: z.string().min(1).optional().describe("親タスク ID"),
});
export type DelegateTaskInputSchema = z.infer<typeof delegateTaskInputSchema>;

export const getTaskStatusInputSchema = z.object({
  taskId: z.string().min(1).describe("orca_delegate_task が返したタスク ID"),
  run: z
    .string()
    .min(1)
    .optional()
    .describe("対象の orchestration Run ID(指定していれば検索が速く確実になる)"),
  includeSubRuns: z
    .boolean()
    .default(true)
    .describe(
      "true(既定)は、Commander が自作した sub-run の配下も children / gates に集約する(sub-run 照合に run-list を 1 回読む)。false なら呼び出し元 Run だけ",
    ),
});
export type GetTaskStatusInput = z.infer<typeof getTaskStatusInputSchema>;

export const getTaskResultInputSchema = z.strictObject({
  taskId: z.string().min(1).describe("対象のタスク ID"),
  run: z.string().min(1).optional().describe("対象の orchestration Run ID"),
  outputLimit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("worker 1 件あたりで読む出力行数の上限(既定 40)"),
  includeChildren: z
    .boolean()
    .default(false)
    .describe(
      "true にすると Commander が分解した子タスクの result と worker 出力も集約して返す(既定 false = Commander だけ)",
    ),
  includeSubRuns: z
    .boolean()
    .default(true)
    .describe(
      "true(既定)は includeChildren の対象に Commander 自作の sub-run の子タスクも含める(sourceRunId にどの Run 由来かを載せる)",
    ),
});
export type GetTaskResultInput = z.infer<typeof getTaskResultInputSchema>;

export const sendMessageInputSchema = z.object({
  subject: z.string().min(1).describe("件名(必須)。ワーカーへの指示・質問・エスカレーションを短く書く"),
  body: z.string().optional().describe("本文"),
  to: z
    .string()
    .min(1)
    .optional()
    .describe("宛先: run:<id> / dispatch:<id> / @all / @codex / @worktree:<id> / 旧来ハンドル。省略時は Run の受信箱"),
  run: z
    .string()
    .min(1)
    .optional()
    .describe("対象の orchestration Run ID(orca_delegate_task が返した runId。MCP 側はバインドを持たないので実質必須)"),
  type: z
    .enum([
      "status",
      "dispatch",
      "worker_done",
      "merge_ready",
      "escalation",
      "handoff",
      "decision_gate",
      "question",
      "heartbeat",
    ])
    .optional()
    .describe("メッセージ種別(worker_done は outcome 必須)"),
  outcome: z
    .enum(["succeeded", "failed"])
    .optional()
    .describe("type=worker_done 時の完了報告の結末"),
  priority: z.string().min(1).optional().describe("優先度(例: low / normal / high)"),
  threadId: z.string().min(1).optional().describe("スレッド ID(往復の紐付け)"),
  taskId: z.string().min(1).optional().describe("関連付けるタスク ID"),
  dispatchId: z.string().min(1).optional().describe("関連付ける dispatch ID(試行単位の指示)"),
});
export type SendMessageInputSchema = z.infer<typeof sendMessageInputSchema>;

export const cancelTaskInputSchema = z.strictObject({
  taskId: z.string().min(1).describe("キャンセルするタスク ID"),
  run: z.string().min(1).optional().describe("対象の orchestration Run ID"),
  reason: z
    .string()
    .min(1)
    .optional()
    .describe("キャンセル理由(task の result に 'cancelled: <reason>' として記録)"),
  mode: z
    .enum(["stop", "abandon"])
    .default("stop")
    .describe("stop: worker を fence して止める / abandon: 不確実なまま fence する(プロセスに触らない)"),
  cascade: z
    .boolean()
    .default(true)
    .describe(
      "true(既定)は子孫タスクとその worker まで**子から順**に止める(cascade)。false なら対象タスクだけ。worktree / ターミナルの削除はどちらも行わない",
    ),
  includeSubRuns: z
    .boolean()
    .default(true)
    .describe(
      "true(既定)は cascade 対象に Commander 自作の sub-run の部分木も含める(sub-run の worker を走りたままにしないため)。上限(子孫 12 件)は sub-run 込みの件数で判定する",
    ),
});
export type CancelTaskInputSchema = z.infer<typeof cancelTaskInputSchema>;

/**
 * 完了したジョブの後片付け: settled な worker の agent terminal を worker-release で閉じる。
 * 走っている worker・ユーザーが worker-retain した worker・所有確認が取れない sub-run には触らない。
 */
export const releaseTaskInputSchema = z.strictObject({
  taskId: z.string().min(1).describe("後片付けするジョブのタスク ID(通常は orca_delegate_task の taskId)"),
  run: z.string().min(1).optional().describe("対象の orchestration Run ID"),
  cascade: z
    .boolean()
    .default(true)
    .describe("true(既定)は子孫タスクの worker も対象にする。false なら対象タスク(Commander)の worker だけ"),
  includeSubRuns: z
    .boolean()
    .default(true)
    .describe(
      "true(既定)は Commander 自作の sub-run のうち所有確認が verified のものも対象にする(verified でない sub-run は skippedSubRuns に残して触らない)",
    ),
});
export type ReleaseTaskInputSchema = z.infer<typeof releaseTaskInputSchema>;

/**
 * Human-in-the-loop 用の介入: 判断ゲートを承認/却下して Commander を進める。
 * gate-create は Commander 側の仕事なので公開しない(公開するのは解決だけ)。
 */
export const resolveGateInputSchema = z.strictObject({
  gateId: z
    .string()
    .min(1)
    .describe("orca_get_task_status の gates[].id(gate_… の ID)"),
  resolution: z
    .string()
    .min(1)
    .describe("結論のテキスト(gate の options のいずれか。例: approve / reject)"),
  run: z
    .string()
    .min(1)
    .describe(
      "対象の orchestration Run ID(gate は Run バインドスコープ。MCP 側はバインドを持たないので必須)",
    ),
  taskId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "任意: この解決が自分の job のものかを点検させる task ID(通常は orca_delegate_task の taskId)。" +
        "ゲートの task がこの task またはその部分木に属さない場合は gate_task_mismatch で拒否する(何も変更しない)。" +
        "指定なしはゲートの所属 task を点検しない(gateId と run が合っていれば解決する)。" +
        "これは誤操作防止の任意チェックで、厳密な Job 単位の認可ではない(Run をまたぐ親子関係は検証しない)",
    ),
});
export type ResolveGateInputSchema = z.infer<typeof resolveGateInputSchema>;

/**
 * ask(質問メッセージ)への回答: Human-in-the-loop の ask 承認経路。
 * asker は `orchestration ask --to run:<親Run> --wait` でブロックして回答を待っているので、
 * reply するとブロックが解け、`answer` として届く(実測: `timedOut: false` で返る)。
 * タイムアウト済みの ask は asker 側が `ask --resume` で受け取る。ターンを終えて wake を待つ asker には
 * Orca 1.4.250〜1.4.253 が回答を配達しないことがある(Run の coordinator を兼ねる terminal。2026-11-08 実測)。
 */
export const replyMessageInputSchema = z.strictObject({
  messageId: z
    .string()
    .min(1)
    .describe(
      "返信先の ask のメッセージ ID(orca_get_task_status の asks[].messageId / blockedReasons[].detail.messageId)",
    ),
  body: z
    .string()
    .min(1)
    .describe("回答の本文(ask の --options で出した選択肢の値を書く。例: approve / reject)"),
  run: z
    .string()
    .min(1)
    .describe(
      "ask の宛先 Run の ID(--to run:<id> の親 Run。orca_delegate_task が返した runId)。" +
        "reply は Run バインドスコープなので必須(consumer_fenced 時だけ run-use で切り替えて 1 回再試行)",
    ),
  taskId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "任意: この回答が自分の job の ask かを点検させる task ID(通常は orca_delegate_task の taskId)。" +
        "ask の payload.taskId がこの task またはその部分木に属さない場合は ask_task_mismatch で拒否する(何も変更しない)。" +
        "sub-run の worker からの ask は呼び出し元 Run の task-list に現れないので、その場合は taskId を外して解決する。" +
        "指定なしは点検しない。これは誤操作防止の任意チェックで、厳密な Job 単位の認可ではない",
    ),
});
export type ReplyMessageInputSchema = z.infer<typeof replyMessageInputSchema>;

/** 委譲の前提チェック。commanderAgent を渡すとそのエージェント向けの準備まで見る。 */
export const readinessInputSchema = z.strictObject({
  commanderAgent: z
    .string()
    .min(1)
    .optional()
    .describe(
      "起動する予定の Commander Agent(例: codex / claude)。指定すると orchestration skill がそのエージェントで使えるかまで確認する",
    ),
});
export type ReadinessInput = z.infer<typeof readinessInputSchema>;

/**
 * Run 観測: poll / cancel の境界である Run を呼び出し側が列挙できるようにする。
 * Commander が sub-run を作ったとき、これで見つけて run 名義の poll / cancel に使う。
 */
export const listRunsInputSchema = z.strictObject({
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("取得する Run 数の上限(省略時は CLI 既定)"),
  cursor: z
    .string()
    .min(1)
    .optional()
    .describe("前回の応答の nextCursor(作成順の keyset cursor。新しい出力だけを受け取る)"),
});
export type ListRunsInput = z.infer<typeof listRunsInputSchema>;

export const getRunInputSchema = z.strictObject({
  runId: z.string().min(1).describe("Run ID(run_… の ID。orca_list_runs の runId)"),
});
export type GetRunInput = z.infer<typeof getRunInputSchema>;

export const delegateInputSchema = z.object({
  spec: z.string().min(1).describe("ワーカーに渡すタスク仕様(指示文)"),
  title: z.string().min(1).optional().describe("タスクの表示タイトル"),
  to: z
    .string()
    .min(1)
    .describe("dispatch 先ターミナルのハンドル(terminal list --json の handle)"),
  from: z.string().optional().describe("送信元ターミナルのハンドル"),
  run: z.string().optional().describe("対象の orchestration Run ID"),
  deps: z.array(z.string().min(1)).optional().describe("依存するタスク ID の配列"),
  parent: z.string().optional().describe("親タスク ID"),
  inject: z.boolean().default(false).describe("ターミナルへタスクを直接注入するかどうか"),
});
export type DelegateInput = z.infer<typeof delegateInputSchema>;

export const messageInputSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("send"),
    subject: z.string().min(1).describe("件名"),
    to: z
      .string()
      .optional()
      .describe("宛先(run:id / dispatch:id / 旧来ハンドル)。省略時はバインド中の Run 宛"),
    body: z.string().optional().describe("本文"),
    type: z.string().optional().describe("メッセージ種別(任意の文字列)"),
    priority: z.string().min(1).optional().describe("優先度(例: low / normal / high)"),
    threadId: z.string().optional().describe("スレッド ID(往復の紐付け)"),
    taskId: z.string().optional().describe("関連付けるタスク ID"),
    dispatchId: z.string().optional().describe("関連付ける dispatch ID"),
  }),
  z.object({
    action: z.literal("check"),
    terminal: z.string().optional().describe("対象ターミナルのハンドル"),
    run: z.string().optional().describe("対象の orchestration Run ID"),
    ack: z.string().optional().describe("この delivery ID を既読として処理する"),
    mode: z
      .enum(["unread", "peek", "all"])
      .default("unread")
      .describe("unread: 未読 / peek: 全件(未読フラグを変えない) / all: 全件"),
    types: z.array(z.string().min(1)).optional().describe("受け取るメッセージ種別の絞り込み"),
    wait: z.boolean().default(false).describe("メッセージが届くまでブロックするかどうか"),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(600_000)
      .optional()
      .describe("wait 時のタイムアウト(ms)"),
  }),
  z.object({
    action: z.literal("reply"),
    id: z.string().min(1).describe("返信先のメッセージ ID"),
    body: z.string().min(1).describe("返信本文"),
    run: z.string().optional().describe("対象の orchestration Run ID"),
    from: z.string().optional().describe("送信元ターミナルのハンドル"),
  }),
  z.object({
    action: z.literal("inbox"),
    limit: z.number().int().min(1).max(100).optional().describe("最大件数"),
    terminal: z.string().optional().describe("特定ターミナルのハンドルに絞る"),
    full: z.boolean().default(false).describe("全文を含めるかどうか"),
  }),
]);
export type MessageInput = z.infer<typeof messageInputSchema>;
