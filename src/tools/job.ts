import type { McpServer } from "@modelcontextprotocol/server";
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { OrcaClient } from "../orca/client.js";
import { delegateTask, getTaskResult, getTaskStatus } from "../orca/job.js";
import {
  delegateTaskInputSchema,
  getTaskResultInputSchema,
  getTaskStatusInputSchema,
} from "../orca/schemas.js";
import { resultOf } from "./result.js";

export const DELEGATE_TASK_TOOL_NAME = "orca_delegate_task";
export const TASK_STATUS_TOOL_NAME = "orca_get_task_status";
export const TASK_RESULT_TOOL_NAME = "orca_get_task_result";

/**
 * 非同期 Job API(submit / poll / result)を登録する。
 *
 * 設計上の約束: 1 回の MCP 呼び出しでワーカーの完了を待たない。
 * delegate_task は task-create + dispatch までを済ませて `{ taskId, state }` を即返し、
 * 完了の監視は呼び出し側の poll に委ねる。
 */
export function registerJobTools(server: McpServer, client: OrcaClient): void {
  server.registerTool(
    DELEGATE_TASK_TOOL_NAME,
    {
      title: "Orca Delegate Task",
      description:
        "タスクを委譲する(非同期 submit)。内部で run-create(未指定時) → task-create → worktree create --agent(既定 codex) → dispatch を行い、ワーカーの完了を待たずに { taskId, state: \"running\" } を返す。worktree / terminal を指定すれば既存環境へ、terminal 未指定の新規起動なら新しい worktree にエージェントを立てる。dispatch だけ失敗した場合はタスクを作成済みのまま state: \"queued\" + warnings を返す。",
      inputSchema: delegateTaskInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (input): Promise<CallToolResult> =>
      resultOf(() =>
        delegateTask(client, {
          spec: input.spec,
          title: input.title,
          agent: input.agent,
          worktree: input.worktree,
          terminal: input.terminal,
          repo: input.repo,
          run: input.run,
          deps: input.deps,
          parent: input.parent,
          prompt: input.prompt,
        }),
      ),
  );

  server.registerTool(
    TASK_STATUS_TOOL_NAME,
    {
      title: "Orca Get Task Status",
      description:
        "委譲したタスクの現在状態を正規化して返す(非同期 poll)。内部で task-list / dispatch-show / worker-list / gate-list を読むだけで、何も変更しない。state は queued / running / blocked / completed / failed / cancelled、phase は queued / starting / implementation / decision_gate / settling / finished。生の status は rawStatus に残す。",
      inputSchema: getTaskStatusInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input): Promise<CallToolResult> =>
      resultOf(() => getTaskStatus(client, { taskId: input.taskId, run: input.run })),
  );

  server.registerTool(
    TASK_RESULT_TOOL_NAME,
    {
      title: "Orca Get Task Result",
      description:
        "タスクの成果とワーカー出力を読む(非同期 result)。内部で task-list / dispatch-show / worker-read を読むだけで、何も変更しない。worker 出力は 1 件あたり既定 40 行・最大 4000 文字に切り詰める。",
      inputSchema: getTaskResultInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input): Promise<CallToolResult> =>
      resultOf(() =>
        getTaskResult(client, {
          taskId: input.taskId,
          run: input.run,
          outputLimit: input.outputLimit,
        }),
      ),
  );
}
