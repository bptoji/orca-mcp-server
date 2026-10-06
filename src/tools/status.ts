import type { McpServer } from "@modelcontextprotocol/server";
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { OrcaClient } from "../orca/client.js";

export const STATUS_TOOL_NAME = "orca_status";

/**
 * orca_status: 最初のツール。入力はなく、内部では `orca status --json` を 1 回呼ぶだけ。
 * エージェントの起動・変更は一切行わない(read-only 観測)。
 */
export function registerStatusTool(server: McpServer, client: OrcaClient): void {
  server.registerTool(
    STATUS_TOOL_NAME,
    {
      title: "Orca Status",
      description:
        "Orca のアプリ/ランタイム/グラフの準備状態を JSON で返す。内部で `orca status --json` を実行するだけで、何も変更しない。",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (): Promise<CallToolResult> => {
      const status = await client.status();
      return {
        content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
      };
    },
  );
}
