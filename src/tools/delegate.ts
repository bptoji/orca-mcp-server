import type { McpServer } from "@modelcontextprotocol/server";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { extractTaskId, type JsonObject, type OrcaClient } from "../orca/client.js";
import { delegateInputSchema } from "../orca/schemas.js";
import { errorResult, textResult } from "./result.js";

export const DELEGATE_TOOL_NAME = "orca_delegate";

/**
 * orca_delegate: タスクを作成(task-create)し、指定ターミナルへ dispatch する。
 * ワーカーへ仕事を委譲する際の起点になる複合ツール。
 */
export function registerDelegateTool(server: McpServer, client: OrcaClient): void {
  server.registerTool(
    DELEGATE_TOOL_NAME,
    {
      title: "Orca Delegate",
      description:
        "オーケストレーションタスクを作成し、指定したターミナルハンドルへ dispatch する。タスク仕様(spec)と dispatch 先(to)を渡す。",
      inputSchema: delegateInputSchema,
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async (input): Promise<CallToolResult> => {
      try {
        const task: JsonObject = await client.taskCreate({
          spec: input.spec,
          title: input.title,
          deps: input.deps,
          parent: input.parent,
          run: input.run,
          from: input.from,
        });

        const taskId = extractTaskId(task);
        if (taskId === undefined) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { ok: false, code: "task_id_missing", detail: task },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          };
        }

        const dispatch = await client.dispatch({
          task: taskId,
          to: input.to,
          from: input.from,
          run: input.run,
          inject: input.inject,
        });

        return textResult({ taskId, task, dispatch });
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
