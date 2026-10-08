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
 * delegate_task は run-create → task-create(Commander 用 spec) → worker-start までを
 * 済ませて `{ taskId, state }` を即返し、完了の監視は呼び出し側の poll に委ねる。
 */
export function registerJobTools(server: McpServer, client: OrcaClient): void {
  server.registerTool(
    DELEGATE_TASK_TOOL_NAME,
    {
      title: "Orca Delegate Task",
      description:
        "ゴールを Commander Agent に委譲する(非同期 submit / Commander API)。内部で run-create(run 未指定時) → task-create(固定の Commander 指示 + goal + repo + constraints を spec に焼く) → worker-start --worktree new-child --agent <commanderAgent>(既定 codex) を行い、Commander の完了を待たずに { taskId, state: \"running\", commander: true } を返す。Commander がゴールを分解して supervised worker へ差配するので、利用者が個々のワーカーやターミナルを直接指定することはない(terminal / worktree は受け付けない)。worker-start だけ失敗してもタスクは生き、state: \"queued\" + warnings を返す(queued は放置しても進まない)。repo は repo セレクタで渡すこと — id:<repoId> / path:<repo home> は解決できるが、worktree の displayName や worktree path は repo_not_found になる(現在の worktree の repoId は orca worktree current --json の result.worktree.repoId)。",
      inputSchema: delegateTaskInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (input): Promise<CallToolResult> =>
      resultOf(() =>
        delegateTask(client, {
          spec: input.spec,
          title: input.title,
          commanderAgent: input.commanderAgent,
          repo: input.repo,
          run: input.run,
          deps: input.deps,
          parent: input.parent,
          constraints: input.constraints,
        }),
      ),
  );

  server.registerTool(
    TASK_STATUS_TOOL_NAME,
    {
      title: "Orca Get Task Status",
      description:
        "委譲したタスクの現在状態を正規化して返す(非同期 poll)。内部で task-list / dispatch-show / worker-list / gate-list を読むだけで、何も変更しない。state は queued / running / blocked / completed / failed / cancelled、phase は queued / starting / implementation / decision_gate / settling / finished。commander は Commander 自身の worker、children は Commander が task-create で分解した**直接の子タスク**(direct children、`parent_id` が対象タスクと一致するもの)とその worker(state 付き)なので、1 回の poll で配下の進捗が見える。孫以降(deep DAG)は children に現れない(子タスク自身の poll で見る)。gates が pending のときは orca_resolve_gate で承認/却下できる。生の status は rawStatus に残す。",
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
        "タスクの成果とワーカー出力を読む(非同期 result)。内部で task-list / dispatch-show / worker-read を読むだけで、何も変更しない。worker 出力は 1 件あたり既定 40 行・最大 4000 文字に切り詰める。既定では Commander 自身の成果と出力だけを返し、includeChildren: true で**直接の子タスク**(direct children)の result と出力(子 10 件・worker-read 8 件まで)を集約する。孫以降は集約しない(その子自身の result で見る)。",
      inputSchema: getTaskResultInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input): Promise<CallToolResult> =>
      resultOf(() =>
        getTaskResult(client, {
          taskId: input.taskId,
          run: input.run,
          outputLimit: input.outputLimit,
          includeChildren: input.includeChildren,
        }),
      ),
  );
}
