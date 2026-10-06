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

export const getTaskStatusInputSchema = z.object({
  id: z
    .string()
    .min(1)
    .optional()
    .describe("この ID のタスク 1 件に絞る(渡すと dispatch 状況も併せて返す)"),
  status: z
    .string()
    .min(1)
    .optional()
    .describe("ステータスで絞り込む(例: pending / ready / in_progress / done / blocked)"),
  ready: z.boolean().optional().describe("依存が解けて着手可能なタスクだけに絞る"),
  brief: z.boolean().default(true).describe("簡潔な一覧形式で受け取るかどうか"),
  run: z
    .string()
    .optional()
    .describe("対象の orchestration Run ID(未バインドだと CLI が run_required を返す)"),
  from: z.string().optional().describe("送信元ターミナルのハンドル"),
});
export type GetTaskStatusInput = z.infer<typeof getTaskStatusInputSchema>;

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
