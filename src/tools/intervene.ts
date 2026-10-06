import type { McpServer } from "@modelcontextprotocol/server";
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { OrcaClient } from "../orca/client.js";
import { cancelTask, sendMessage } from "../orca/job.js";
import { cancelTaskInputSchema, sendMessageInputSchema } from "../orca/schemas.js";
import { resultOf } from "./result.js";

export const SEND_MESSAGE_TOOL_NAME = "orca_send_message";
export const CANCEL_TASK_TOOL_NAME = "orca_cancel_task";

/**
 * 介入(intervene)ツール: 委譲したジョブに対して明示的に頼まれたときだけ変更を加える 2 個。
 * poll / result / 観測ツールが変更系コマンドを呼ぶことはなく、ここだけに集約する。
 */
export function registerInterveneTools(server: McpServer, client: OrcaClient): void {
  server.registerTool(
    SEND_MESSAGE_TOOL_NAME,
    {
      title: "Orca Send Message",
      description:
        "委譲したジョブのエージェントへメッセージを送る(指示の補足・質問・エスカレーション・完了報告)。内部で `orca orchestration send --json` を 1 回呼ぶだけ。宛先は run:<id> / dispatch:<id> / @all / @codex / @worktree:<id>、省略時は Run の受信箱。MCP 側は Run バインドを持たないので run(orca_delegate_task が返した runId)を渡すこと。type=worker_done には outcome が必要。",
      inputSchema: sendMessageInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (input): Promise<CallToolResult> =>
      resultOf(() =>
        sendMessage(client, {
          subject: input.subject,
          body: input.body,
          to: input.to,
          run: input.run,
          type: input.type,
          outcome: input.outcome,
          priority: input.priority,
          threadId: input.threadId,
          taskId: input.taskId,
          dispatchId: input.dispatchId,
        }),
      ),
  );

  server.registerTool(
    CANCEL_TASK_TOOL_NAME,
    {
      title: "Orca Cancel Task",
      description:
        "タスクをキャンセルする。内部では orca CLI の手順どおり、対象タスクの dispatch を worker-stop(または mode=abandon なら worker-abandon)で fence してから `task-update --status failed --result cancelled` を呼ぶ。完了済み・キャンセル済みのタスクには何もしない(冪等)。worktree やターミナルの削除は行わない。",
      inputSchema: cancelTaskInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (input): Promise<CallToolResult> =>
      resultOf(() =>
        cancelTask(client, {
          taskId: input.taskId,
          run: input.run,
          reason: input.reason,
          mode: input.mode,
        }),
      ),
  );
}
