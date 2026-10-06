import type { McpServer } from "@modelcontextprotocol/server";
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { OrcaClient } from "../orca/client.js";
import { getWorktreeInputSchema, listWorktreesInputSchema } from "../orca/schemas.js";
import { resultOf } from "./result.js";

export const LIST_WORKTREES_TOOL_NAME = "orca_list_worktrees";
export const GET_WORKTREE_TOOL_NAME = "orca_get_worktree";

/**
 * orca_list_worktrees: `orca worktree list --json` を呼ぶだけの変更なしの観測ツール。
 */
export function registerListWorktreesTool(server: McpServer, client: OrcaClient): void {
  server.registerTool(
    LIST_WORKTREES_TOOL_NAME,
    {
      title: "Orca List Worktrees",
      description:
        "Orca 管理のワークツリー一覧を JSON で返す。内部で `orca worktree list --json` を実行するだけで、何も変更しない。repo セレクタと limit を指定できる。",
      inputSchema: listWorktreesInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input): Promise<CallToolResult> =>
      resultOf(() => client.worktreeList({ repo: input.repo, limit: input.limit })),
  );
}

/**
 * orca_get_worktree: `orca worktree show --worktree <selector> --json` を呼ぶだけ。
 */
export function registerGetWorktreeTool(server: McpServer, client: OrcaClient): void {
  server.registerTool(
    GET_WORKTREE_TOOL_NAME,
    {
      title: "Orca Get Worktree",
      description:
        "1 件のワークツリー詳細を JSON で返す。内部で `orca worktree show --worktree <selector> --json` を実行するだけで、何も変更しない。セレクタは active / current / branch:<branch> / name:<displayName> / path:<path> / id:<repo>::<path> / identity:<key> / issue:<number>。",
      inputSchema: getWorktreeInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input): Promise<CallToolResult> =>
      resultOf(() => client.worktreeShow({ worktree: input.worktree })),
  );
}
