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
        "ゴールを Commander Agent に委譲する(非同期 submit / Commander API)。内部で run-create(run 未指定時) → task-create(固定の Commander 指示 + goal + repo + constraints を spec に書き込み) → worker-start --worktree new-child --agent <commanderAgent>(既定 codex) を行い、Commander の完了を待たずに { taskId, state: \"running\", commander: true } を返す。Commander がゴールを分解して supervised worker へ差配するので、利用者が個々のワーカーやターミナルを直接指定することはない(terminal / worktree は受け付けない)。worker-start だけ失敗してもタスクは生き、state: \"queued\" + warnings を返す(queued は放置しても進まない)。repo は repo セレクタで渡すこと — id:<repoId> / path:<repo home> は解決できるが、worktree の displayName や worktree path は repo_not_found になる(現在の worktree の repoId は orca worktree current --json の result.worktree.repoId)。",
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
        "委譲したタスクの現在状態を正規化して返す(非同期 poll)。内部で task-list / dispatch-show / worker-list / gate-list / run-list を読むだけで、何も変更しない。state は queued / running / blocked / completed / failed / cancelled、phase は queued / starting / implementation / decision_gate / settling / finished。commander は Commander 自身の worker、children は Commander が task-create で分解した**直接の子タスク**(direct children、`parent_id` が対象タスクと一致するもの)とその worker(state 付き)なので、1 回の poll で配下の進捗が見える。孫以降(deep DAG)は children に現れない(子タスク自身の poll で見る)。gates が pending のときは orca_resolve_gate で承認/却下できる。gates は対象タスクと直接の子タスクのもの(taskId と **runId** 付き)。gates[].runId はそのゲートの所属 Run で、sub-run 内のゲートは呼び出し元 Run と違う Run ID になる(実測: 呼び出し元 Run の gate-list は 0 件、sub-run に pending が 1 件) — orca_resolve_gate にはこの runId をそのまま run として渡す。blockedReasons[] に止まっている理由(kind: gate / task_report / agent_prompt / unknown)が入るので、blocked のときはまずそれを読む(gate 由来の detail には gateId / runId がある)。ゲート無しの blocked は phase: blocked になる。生の status は rawStatus に残す。launch token 無しで失敗した dispatch(dsh 型)で worker terminal が生存中の場合は workerReportPending: true と workerReportNote を添える — その failed は一時的で、worker の task-update 報告により completed が後から届く(実測)。state は偽装しない。**sub-run**: Commander が `run-create` で子 Run を作ると、その中のタスクは呼び出し元 Run の task-list に 1 件も出ない(実測で childCount: 0 + sub-run 内に子 6 件)。既定 includeSubRuns: true は run-list を cursor でページングして読み(実測で 60 件 + nextCursor)、coordinatorHandle 照合し、その配下を children に **sourceRunId 付き**で合算する(拾った Run は subRuns / subRunsDiscovered に載せる)。子が見えないのに childCount: 0 のときはまず subRuns を確認すること。subRuns 行は所有判定も持つ: ownership = verified(coordinator_handle + pane key + process incarnation まで一致)/ probable(handle 一致のみ)/ unverified / conflicting、cancelEligible は verified のみ true、verificationReasons に根拠、discoverySource(explicit / provenance / handle)。スキャンの正直さも応答に出す: subRunScanComplete(打ち切ったら false)/ subRunsTruncated(MAX_SUB_RUNS 超)/ subRunScanPageCount / subRunScanRunCount / subRunOwnershipComplete / subRunWorkerScanComplete(sub-run 側の worker-list を読み切ったか。打ち切ったら cancel は完全停止を保証しない)。",
      inputSchema: getTaskStatusInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input): Promise<CallToolResult> =>
      resultOf(() =>
        getTaskStatus(client, {
          taskId: input.taskId,
          run: input.run,
          includeSubRuns: input.includeSubRuns,
        }),
      ),
  );

  server.registerTool(
    TASK_RESULT_TOOL_NAME,
    {
      title: "Orca Get Task Result",
      description:
        "タスクの成果とワーカー出力を読む(非同期 result)。内部で task-list / dispatch-show / worker-read / run-list を読むだけで、何も変更しない。worker 出力は 1 件あたり既定 40 行・最大 4000 文字に切り詰める。既定では Commander 自身の成果と出力だけを返し、includeChildren: true で**直接の子タスク**(direct children)の result と出力(子 10 件・worker-read 8 件まで)を集約する。孫以降は集約しない(その子自身の result で見る)。Commander が sub-run を作っていた場合、includeChildren: true(既定 includeSubRuns: true)はその sub-run の子タスクも sourceRunId 付きで集約する — 呼び出し元 Run だけの result は sub-run の成果を丸ごと見落とす(実測)。集約の完全性は poll と同じ応答フィールドで出す: subRunScanComplete / subRunsTruncated / subRunOwnershipComplete / subRunWorkerScanComplete(打ち切りのときは warnings に理由が出る)。",
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
          includeSubRuns: input.includeSubRuns,
        }),
      ),
  );
}
