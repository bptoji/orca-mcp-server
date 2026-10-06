import type { McpServer } from "@modelcontextprotocol/server";
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { JsonObject, OrcaClient } from "../orca/client.js";
import { messageInputSchema, type MessageInput } from "../orca/schemas.js";

export const MESSAGE_TOOL_NAME = "orca_message";

function textResult(payload: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

/** action ごとの処理を 1 箇所にまとめる(テスト対象)。 */
export async function runMessageAction(
  client: OrcaClient,
  input: MessageInput,
): Promise<JsonObject> {
  switch (input.action) {
    case "send":
      return client.send({
        subject: input.subject,
        to: input.to,
        body: input.body,
        type: input.type,
        priority: input.priority,
        threadId: input.threadId,
        taskId: input.taskId,
        dispatchId: input.dispatchId,
      });
    case "check":
      return client.check({
        terminal: input.terminal,
        run: input.run,
        ack: input.ack,
        mode: input.mode,
        types: input.types,
        wait: input.wait,
        timeoutMs: input.timeoutMs,
      });
    case "reply":
      return client.reply({ id: input.id, body: input.body, run: input.run, from: input.from });
    case "inbox":
      return client.inbox({ limit: input.limit, terminal: input.terminal, full: input.full });
  }
}

/** orca_message: エージェント間メッセージ(send / check / reply / inbox)を 1 ツールで扱う。 */
export function registerMessageTool(server: McpServer, client: OrcaClient): void {
  server.registerTool(
    MESSAGE_TOOL_NAME,
    {
      title: "Orca Message",
      description:
        "オーケストレーションのメッセージ機能を操作する。action=send で送信、check で受信箱チェック、reply で返信、inbox で受信者横断の一覧表示。",
      inputSchema: messageInputSchema,
      annotations: { openWorldHint: false },
    },
    async (input): Promise<CallToolResult> => {
      const result = await runMessageAction(client, input);
      return textResult({ action: input.action, result });
    },
  );
}
