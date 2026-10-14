import type { McpServer } from "@modelcontextprotocol/server";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { extractRuns, toRunRow, unwrapResult } from "../orca/job.js";
import type { JsonObject, OrcaClient } from "../orca/client.js";
import { getRunInputSchema, listRunsInputSchema } from "../orca/schemas.js";
import { resultOf } from "./result.js";

export const LIST_RUNS_TOOL_NAME = "orca_list_runs";
export const GET_RUN_TOOL_NAME = "orca_get_run";

/** run-list / run-show の応答を Job API 用の run 行に正規化する(テスト対象)。 */
export function toRunRows(payload: JsonObject): JsonObject[] {
  return extractRuns(payload).map(toRunRow);
}

/**
 * Run 観測ツール: `orca orchestration run-list` / `run-show`(read-only)。
 *
 * 公開する理由: Run は poll / cancel の境界なのに、MCP 側に Run を列挙する手段が
 * 無いと、Commander が自作した sub-run を呼び出し側が一切発見できない(実測で
 * 親 Run の poll が childCount: 0 を返し、cancel cascade が sub-run に届かなかった)。
 */
export function registerRunTools(server: McpServer, client: OrcaClient): void {
  server.registerTool(
    LIST_RUNS_TOOL_NAME,
    {
      title: "Orca List Runs",
      description:
        "orchestration Run を列挙する(read-only 観測)。内部で `orca orchestration run-list --json` を実行するだけで、何も変更しない。各行は { runId, objective, coordinatorHandle, createdAt, updatedAt }(coordinatorHandle = その Run を作成した coordinator の terminal handle、未設定なら null)。**Run は poll / cancel の境界**なので、子タスクが見えないときはこれで Run を突き止める: Commander が `run-create` で作った sub-run は呼び出し元 Run の task-list に 1 件も出ない(実測)。sub-run の runId を手に入れたら `orca_get_task_status({ taskId: <sub-run の task>, run: <sub-run の runId> })` で poll できる。cursor は前回応答の nextCursor(作成順の keyset)。",
      inputSchema: listRunsInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input): Promise<CallToolResult> =>
      resultOf(async () => {
        const listed = unwrapResult(await client.runList({ limit: input.limit, cursor: input.cursor }));
        const runs = toRunRows(listed);
        return {
          runs,
          count: runs.length,
          nextCursor: typeof listed["nextCursor"] === "string" ? listed["nextCursor"] : null,
          note: "run は poll / cancel の境界。子タスクが見えないときはこれで Run を列挙する",
        };
      }),
  );

  server.registerTool(
    GET_RUN_TOOL_NAME,
    {
      title: "Orca Get Run",
      description:
        "1 件の Run 詳細を読む(read-only 観測)。内部で `orca orchestration run-show --id <runId> --json` を実行するだけで、何も変更しない。返すのは { runId, objective, coordinatorHandle, createdAt, updatedAt }。coordinatorHandle はその Run を作成した coordinator の terminal handle で、sub-run の帰属を突き止めるときに使う。",
      inputSchema: getRunInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input): Promise<CallToolResult> =>
      resultOf(async () => {
        const shown = unwrapResult(await client.runShow(input.runId));
        const rows = toRunRows(shown);
        return {
          run: rows[0] ?? { runId: input.runId },
          note: "coordinatorHandle はその Run を作成した coordinator の terminal handle",
        };
      }),
  );
}
