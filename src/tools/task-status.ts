import type { McpServer } from "@modelcontextprotocol/server";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { extractTasks, type JsonObject, type OrcaClient } from "../orca/client.js";
import { getTaskStatusInputSchema } from "../orca/schemas.js";
import { resultOf } from "./result.js";

export const TASK_STATUS_TOOL_NAME = "orca_get_task_status";

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

/**
 * orca_get_task_status: `orca orchestration task-list --json` を呼ぶだけの観測ツール。
 * id を渡すとそのタスクに絞り、`dispatch-show` を併せて呼ぶ(どちらも読み取りのみ)。
 */
export function registerGetTaskStatusTool(server: McpServer, client: OrcaClient): void {
  server.registerTool(
    TASK_STATUS_TOOL_NAME,
    {
      title: "Orca Get Task Status",
      description:
        "オーケストレーションタスクの一覧を JSON で返す。内部で `orca orchestration task-list --json` を実行するだけで、タスクの作成・更新・dispatch は行わない。id を渡すとそのタスク 1 件に絞り、dispatch 状況(dispatch-show)も併せて返す。Run が未バインドなら CLI の run_required をそのまま応答に返す。",
      inputSchema: getTaskStatusInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input): Promise<CallToolResult> =>
      resultOf(async () => {
        const list = await client.taskList({
          status: input.status,
          ready: input.ready,
          brief: input.brief,
          run: input.run,
          from: input.from,
        });

        let tasks = extractTasks(list);
        if (input.id !== undefined) {
          tasks = tasks.filter((task) => taskIdOf(task) === input.id);
        }

        const payload: Record<string, unknown> = { tasks };
        if (input.id !== undefined && tasks.length > 0) {
          payload["dispatch"] = await client.dispatchShow(input.id, { from: input.from });
        }
        return payload;
      }),
  );
}
