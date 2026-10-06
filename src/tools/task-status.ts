import type { McpServer } from "@modelcontextprotocol/server";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { extractTasks, type JsonObject, type OrcaClient } from "../orca/client.js";
import { taskStatusInputSchema } from "../orca/schemas.js";

export const TASK_STATUS_TOOL_NAME = "orca_task_status";

function textResult(payload: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

/** 応答 JSON からタスク ID らしき値を取り出す(task-list 行のキーは環境により異なる)。 */
function taskIdOf(task: JsonObject): string | undefined {
  for (const key of ["taskId", "task_id", "id"]) {
    const value = task[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

/** orca_task_status: タスク一覧/特定タスクのステータスと dispatch 状況を返す。 */
export function registerTaskStatusTool(server: McpServer, client: OrcaClient): void {
  server.registerTool(
    TASK_STATUS_TOOL_NAME,
    {
      title: "Orca Task Status",
      description:
        "オーケストレーションタスクの一覧をステータス/ready で絞り込んで返す。id を渡すとそのタスク 1 件に絞り、dispatch 状況(dispatch-show)も併せて返す。",
      inputSchema: taskStatusInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input): Promise<CallToolResult> => {
      const list = await client.taskList({
        status: input.status,
        ready: input.ready,
        brief: input.brief,
        run: input.run,
      });

      let tasks = extractTasks(list);
      if (input.id !== undefined) {
        tasks = tasks.filter((task) => taskIdOf(task) === input.id);
      }

      const payload: Record<string, unknown> = { tasks };
      if (input.id !== undefined && tasks.length > 0) {
        payload.dispatch = await client.dispatchShow(input.id);
      }
      return textResult(payload);
    },
  );
}
