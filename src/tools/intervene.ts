import type { McpServer } from "@modelcontextprotocol/server";
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { OrcaClient } from "../orca/client.js";
import { cancelTask, resolveGate, sendMessage } from "../orca/job.js";
import {
  cancelTaskInputSchema,
  resolveGateInputSchema,
  sendMessageInputSchema,
} from "../orca/schemas.js";
import { resultOf } from "./result.js";

export const SEND_MESSAGE_TOOL_NAME = "orca_send_message";
export const CANCEL_TASK_TOOL_NAME = "orca_cancel_task";
export const RESOLVE_GATE_TOOL_NAME = "orca_resolve_gate";

/**
 * 介入(intervene)ツール: 委譲したジョブに対して明示的に頼まれたときだけ変更を加える 3 個。
 * poll / result / 観測ツールが変更系コマンドを呼ぶことはなく、ここだけに集約する。
 */
export function registerInterveneTools(server: McpServer, client: OrcaClient): void {
  server.registerTool(
    SEND_MESSAGE_TOOL_NAME,
    {
      title: "Orca Send Message",
      description:
        "委譲したジョブのエージェントへメッセージを送る(指示の補足・質問・エスカレーション・完了報告)。内部で `orca orchestration send --json` を 1 回呼ぶだけ。宛先は run:<id> / dispatch:<id> / @all / @codex / @worktree:<id>、省略時は Run の受信箱。MCP 側は Run バインドを持たないので run(orca_delegate_task が返した runId)を渡すこと。type=worker_done には outcome(succeeded/failed)と dispatchId(orca_get_task_status の workers[].dispatchId)が必要で、欠けていれば CLI に叩き合う前に outcome_required / dispatch_id_required で返す。worker_done 以外に outcome を付けると outcome_not_allowed。",
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
        "委譲ジョブをキャンセルする。内部では orca CLI の手順どおり、対象タスクの dispatch を worker-stop(または mode=abandon なら worker-abandon)で fence してから `task-update --status failed --result cancelled` を呼ぶ。既定 cascade: true で、Commander が分解した**子孫タスクとその worker を子から順**に止める(cascade の由来)。まず全対象の dispatch を読み切る preflight を行い、子孫 12 件超は cancel_scope_too_large、1 タスク 3 dispatch 超は cancel_dispatch_scope_too_large で**何も変更する前に**断る。Commander の fence に 1 件でも失敗すれば cancel_incomplete(state: partial / cancelled: false)で対象 task は更新しない。成功応答の fullyStopped は「全 dispatch が fence され、停止後に worker-list を読み直して生存 worker が 0 件」を意味する。mode=abandon の場合は worker-abandon がプロセス停止を主張しないコマンドなので、fullyStopped: true も **OS のエージェントプロセス終了は保証しない**(pane 上のプロセス確認は人間側)。完了済み・キャンセル済みのタスクには何もしない(冪等)。worktree やターミナルの削除は行わない。**sub-run**: Commander が sub-run を作っている場合、task ツリーだけ追う cascade はその worker を走りたままにする(実測)。既定 includeSubRuns: true は run-list の coordinatorHandle 照合で sub-run の部分木を cascade 対象に組み込み、**呼び出し元 Run の Commander より先に**止める(拾った Run は subRunsDiscovered / subRuns に載せる)。上限 12 件は sub-run 込みの件数で判定する。**所有検証**: auto-cancel は pane key / process incarnation まで一致した verified の sub-run だけ — 検証に失敗した sub-run が 1 件でもあれば preflight で cancel_ownership_unverified を返し、**何も変更しない**(probable を叩くと別 job の worker を止める事故になる)。sub-run を含めずに止める逃げ道は includeSubRuns: false / cascade: false。同一 dispatch は 1 回だけ叩く。停止後は worker-list を読み直し、残っている worker を residualWorkers に載せ、その 1 件でも fullyStopped: false(探索を打ち切った場合も false)。**探索の完全性**: run-list / worker-list は cursor でページングし、上限到達・hasMore に対して nextCursor 無し・同じ cursor の周回を打ち切りとして検出する(subRunScanComplete / subRunWorkerScanComplete)。worker-list のページングを打ち切ったら完全停止を保証しない(fullyStopped: false)。cascade + includeSubRuns の既定構成では、前提となる読み取り(呼び出し元 Run の worker-list / sub-run 探索の run-list / Commander の terminal handle)が揃わないときに preflight で cancel_discovery_incomplete を返し、**何も変更しない**(見落とした worker を走りたまま cancelled: true で返さないため)。読み取りの失敗だけでなく、**探索コマンドが使えない場合**(client に worker-list / run-list が無い、呼び出し元 Run が特定できない)も同じ語彙で断る。停止後に worker-list を読み直せる Run が無いときも fullyStopped: false。",
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
          cascade: input.cascade,
          includeSubRuns: input.includeSubRuns,
        }),
      ),
  );

  server.registerTool(
    RESOLVE_GATE_TOOL_NAME,
    {
      title: "Orca Resolve Gate",
      description:
        "pending の判断ゲート(Decision Gate)を承認/却下して Commander を進める。内部で gate-list から対象を読み、`orca orchestration gate-resolve --id --resolution --json` を 1 回呼ぶだけ。gate は Run バインドスコープなので run は必須(consumer_fenced 時だけ run-use で切り替えて 1 回再試行)。run には poll(gates[].runId / blockedReasons[].detail.runId)で得た **そのゲートの所属 Run** を渡すこと — Commander が sub-run を作っていると、ゲートは呼び出し元 Run と違う Run に存在する。gateId と run の組が一致しない場合は何も変更せずに gate_run_mismatch で拒否する。解決済みのゲートには何もしない(冪等)。Commander Prompt が「承認ゲート無しでは merge/push/deploy をしない」と約束しているため、これを呼ぶ手段が無いとジョブが途中で止まる。**認可の境界**: gate-resolve は「Run ID と Gate ID を知る誰でも」解決できる CLI 構造で、MCP 側は単一ユーザー / 信頼できるクライアント前提の認可を持たない。自分の job のゲートだけを解決させたい場合は taskId(通常は orca_delegate_task の taskId)を渡す — ゲートの task がその task またはその部分木に属さなければ gate_task_mismatch で何も変更せずに拒否する。指定なしは所属 task を点検しない。**taskId の点検は任意の誤操作防止であり厳密な認可ではない**(Run をまたぐ親子関係は検証しない)。",
      inputSchema: resolveGateInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (input): Promise<CallToolResult> =>
      resultOf(() =>
        resolveGate(client, {
          gateId: input.gateId,
          resolution: input.resolution,
          run: input.run,
          taskId: input.taskId,
        }),
      ),
  );
}
