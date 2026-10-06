import { describe, expect, it } from "vitest";
import type { JsonObject, OrcaClient } from "../src/orca/client.js";
import {
  buildWorktreeName,
  cancelTask,
  estimatePhase,
  extractBoundRun,
  findTaskById,
  getTaskResult,
  getTaskStatus,
  delegateTask,
  JobError,
  mapTaskState,
  mapWorkerStatus,
  sendMessage,
  toWorkerRow,
} from "../src/orca/job.js";
import { OrcaCommandError } from "../src/orca/command.js";

describe("mapTaskState", () => {
  it("orca の生の status を Job API の state に集約する", () => {
    expect(mapTaskState("pending")).toBe("queued");
    expect(mapTaskState("ready")).toBe("queued");
    expect(mapTaskState("dispatched")).toBe("running");
    expect(mapTaskState("in_progress")).toBe("running");
    expect(mapTaskState("blocked")).toBe("blocked");
    expect(mapTaskState("completed")).toBe("completed");
    expect(mapTaskState("failed")).toBe("failed");
    expect(mapTaskState("cancelled")).toBe("cancelled");
    expect(mapTaskState(undefined)).toBe("unknown");
    expect(mapTaskState("teleporting")).toBe("unknown");
  });
});

describe("mapWorkerStatus", () => {
  it("unsupervised は稼働中として扱う(dispatch が採用したターミナル)", () => {
    expect(mapWorkerStatus("unsupervised")).toBe("running");
    expect(mapWorkerStatus("succeeded")).toBe("completed");
    expect(mapWorkerStatus("failed")).toBe("failed");
    expect(mapWorkerStatus("released")).toBe("settled");
    expect(mapWorkerStatus(undefined)).toBe("unknown");
  });
});

describe("toWorkerRow", () => {
  it("実ペイロード(projection 込み)から正規化する", () => {
    const row = toWorkerRow({
      dispatchId: "ctx_42e6925ec35f",
      taskId: "task_3208dcf22c18",
      runId: "run_a781f51d4c91",
      workerState: "unsupervised",
      dispatchStatus: "dispatched",
      agentTerminalHandle: "term_76d5cb08",
      terminalState: "retained",
      projection: {
        provider: "codex",
        outcome: "in_progress",
        stage: { worker: "unsupervised", dispatch: "dispatched", activity: "unknown" },
        liveness: { verdict: "unverifiable", reason: "missing_status" },
        attention: { requiresAction: true, categories: ["unverifiable"] },
      },
    });
    expect(row).toMatchObject({
      agent: "codex",
      status: "running",
      rawStatus: "unsupervised",
      outcome: "in_progress",
      dispatchId: "ctx_42e6925ec35f",
      taskId: "task_3208dcf22c18",
      terminalState: "retained",
      terminalHandle: "term_76d5cb08",
      liveness: "unverifiable",
      requiresAttention: true,
    });
  });

  it("projection.outcome が workerState より優先される", () => {
    expect(
      toWorkerRow({ workerState: "unsupervised", projection: { outcome: "succeeded" } }).status,
    ).toBe("completed");
    expect(toWorkerRow({}).status).toBe("unknown");
  });

  it("キー名の揺れを吸収する(旧形状)", () => {
    expect(
      toWorkerRow({ agentType: "codex", workerStatus: "Succeeded", dispatch_id: "d1", terminal_state: "active" }),
    ).toMatchObject({ agent: "codex", status: "completed", dispatchId: "d1", terminalState: "active" });
    expect(toWorkerRow({}).agent).toBeNull();
  });
});

describe("estimatePhase", () => {
  it("state と worker / gate から phase を推定する", () => {
    expect(estimatePhase("queued", [], [])).toBe("queued");
    expect(estimatePhase("completed", [], [])).toBe("finished");
    expect(estimatePhase("failed", [], [])).toBe("failed");
    expect(
      estimatePhase("running", [{ status: "running", dispatchId: "d1" }], []),
    ).toBe("implementation");
    expect(
      estimatePhase(
        "running",
        [
          { status: "completed", dispatchId: "d1" },
          { status: "running", dispatchId: "d2" },
        ],
        [],
      ),
    ).toBe("implementation");
    expect(estimatePhase("running", [{ status: "completed", dispatchId: "d1" }], [])).toBe("settling");
    expect(estimatePhase("running", [], [{ status: "pending" }])).toBe("decision_gate");
    expect(estimatePhase("blocked", [], [])).toBe("decision_gate");
    expect(estimatePhase("running", [], [])).toBe("starting");
  });
});

describe("buildWorktreeName", () => {
  it("非 ASCII を除去して英数字の短い名前にする", () => {
    const name = buildWorktreeName("README 更新", "docs を整える");
    expect(name).toMatch(/^README-docs-[0-9a-z]{1,4}$/);
  });

  it("英字が足りないときは task 接頭辞にフォールバックする", () => {
    expect(buildWorktreeName(undefined, "日本語の仕様だけ")).toMatch(/^task-[0-9a-z]{1,4}$/);
  });
});

describe("findTaskById", () => {
  it("tasks[] から対象タスクを取り出す", () => {
    const payload = { ok: true, result: { tasks: [{ taskId: "t1" }, { taskId: "t2" }] } };
    expect(findTaskById(payload, "t2")).toEqual({ taskId: "t2" });
  });

  it("無ければ JobError(task_not_found)", () => {
    expect(() => findTaskById({ ok: true, result: { tasks: [] } }, "t9")).toThrowError(JobError);
    try {
      findTaskById({ ok: true, result: { tasks: [] } }, "t9");
    } catch (error) {
      expect((error as JobError).code).toBe("task_not_found");
    }
  });
});

/** テスト用の偽クライアント。呼ばれたメソッドと入力を記録する。 */
function createFakeClient(options: {
  runId?: string;
  taskId?: string;
  agentTerminalHandle?: string;
  terminals?: JsonObject[];
  dispatchId?: string;
  dispatchThrows?: Error;
  taskList?: JsonObject;
  dispatchShow?: JsonObject;
  workerList?: JsonObject;
  gateList?: JsonObject;
  workerRead?: JsonObject;
  send?: JsonObject;
  taskUpdate?: JsonObject;
} = {}) {
  const calls: string[] = [];
  const client = {
    runCreate: async (objective: string) => {
      calls.push(`runCreate:${objective}`);
      return { ok: true, result: { run: { id: options.runId ?? "run_test" } } };
    },
    taskCreate: async (input: JsonObject) => {
      calls.push(`taskCreate:${JSON.stringify(input)}`);
      return { ok: true, result: { task: { taskId: options.taskId ?? "task_abc123" } } };
    },
    worktreeCreate: async (input: JsonObject) => {
      calls.push(`worktreeCreate:${JSON.stringify(input)}`);
      return {
        ok: true,
        result: {
          worktree: { worktreeId: "repo::C:/new", path: "C:/new" },
          ...(options.agentTerminalHandle !== undefined
            ? { agentTerminalHandle: options.agentTerminalHandle }
            : {}),
        },
      };
    },
    terminalList: async (input: JsonObject) => {
      calls.push(`terminalList:${JSON.stringify(input)}`);
      return { ok: true, result: { terminals: options.terminals ?? [] } };
    },
    dispatch: async (input: JsonObject) => {
      calls.push(`dispatch:${JSON.stringify(input)}`);
      if (options.dispatchThrows !== undefined) {
        throw options.dispatchThrows;
      }
      return { ok: true, result: { dispatch: { dispatchId: options.dispatchId ?? "disp_1" } } };
    },
    taskList: async (input: JsonObject) => {
      calls.push(`taskList:${JSON.stringify(input)}`);
      return options.taskList ?? { ok: true, result: { tasks: [] } };
    },
    dispatchShow: async (task: string) => {
      calls.push(`dispatchShow:${task}`);
      return options.dispatchShow ?? { ok: true, result: { dispatch: null } };
    },
    workerList: async (input: JsonObject) => {
      calls.push(`workerList:${JSON.stringify(input)}`);
      return options.workerList ?? { ok: true, result: { workers: [] } };
    },
    gateList: async (input: JsonObject) => {
      calls.push(`gateList:${JSON.stringify(input)}`);
      return options.gateList ?? { ok: true, result: { gates: [] } };
    },
    workerRead: async (input: JsonObject) => {
      calls.push(`workerRead:${JSON.stringify(input)}`);
      return options.workerRead ?? { ok: true, result: { text: "done", source: "transcript" } };
    },
    send: async (input: JsonObject) => {
      calls.push(`send:${JSON.stringify(input)}`);
      return options.send ?? { ok: true, result: { message: { id: "msg_1" } } };
    },
    taskUpdate: async (input: JsonObject) => {
      calls.push(`taskUpdate:${JSON.stringify(input)}`);
      return options.taskUpdate ?? { ok: true, result: { task: { id: input["id"] } } };
    },
    workerStop: async (dispatch: string) => {
      calls.push(`workerStop:${dispatch}`);
      return { ok: true, result: { dispatchId: dispatch, state: "stopped", processAction: "none" } };
    },
    workerAbandon: async (dispatch: string) => {
      calls.push(`workerAbandon:${dispatch}`);
      return { ok: true, result: { dispatchId: dispatch, state: "abandoned" } };
    },
    runUse: async (runId: string) => {
      calls.push(`runUse:${runId}`);
      return { ok: true, result: { run: { id: runId } } };
    },
  };
  return { client: client as unknown as OrcaClient, calls };
}

describe("delegateTask(submit)", () => {
  it("既定は新規 worktree + agent を作り、完了を待たず { taskId, state: running } を返す", async () => {
    const { client, calls } = createFakeClient({ agentTerminalHandle: "term_new" });
    const result = await delegateTask(client, { spec: "README を更新して" });

    expect(result).toMatchObject({
      taskId: "task_abc123",
      state: "running",
      runId: "run_test",
      dispatchId: "disp_1",
      warnings: [],
    });
    expect(result["target"]).toMatchObject({
      kind: "new_worktree",
      terminal: "term_new",
      agent: "codex",
    });
    // run-create → task-create → worktree create → dispatch の順(待つ処理は無い)
    expect(calls[0]).toMatch(/^runCreate:/);
    expect(calls[1]).toMatch(/^taskCreate:/);
    expect(calls[2]).toMatch(/^worktreeCreate:/);
    expect(calls[3]).toMatch(/^dispatch:/);
  });

  it("terminal を指定 then 既存ターミナルへ dispatch し、worktree は作らない", async () => {
    const { client, calls } = createFakeClient();
    const result = await delegateTask(client, { spec: "a", terminal: "term_9", agent: "claude" });
    expect(result["target"]).toMatchObject({ kind: "terminal", terminal: "term_9", agent: "claude" });
    expect(calls.some((call) => call.startsWith("worktreeCreate:"))).toBe(false);
    expect(calls.at(-1)).toContain('"to":"term_9"');
  });

  it("worktree 指定 then その worktree の稼働中ターミナルを使う", async () => {
    const { client, calls } = createFakeClient({
      terminals: [
        { handle: "term_dead", connected: false },
        { handle: "term_live", connected: true },
      ],
    });
    const result = await delegateTask(client, { spec: "a", worktree: "branch:main" });
    expect(result["target"]).toMatchObject({ kind: "worktree", terminal: "term_live" });
    expect(calls.some((call) => call.startsWith("worktreeCreate:"))).toBe(false);
  });

  it("dispatch 失敗時もタスクを生かし state: queued + warnings で返す(例外にしない)", async () => {
    const { client } = createFakeClient({
      agentTerminalHandle: "term_new",
      dispatchThrows: new Error("boom"),
    });
    const result = await delegateTask(client, { spec: "a" });
    expect(result["taskId"]).toBe("task_abc123");
    expect(result["state"]).toBe("queued");
    expect((result["warnings"] as string[])[0]).toContain("dispatch 失敗");
  });

  it("新規 worktree の handle が取れない then queued + warnings(古いランタイム互換)", async () => {
    const { client } = createFakeClient({ terminals: [] });
    const result = await delegateTask(client, { spec: "a" });
    expect(result["state"]).toBe("queued");
    expect((result["warnings"] as string[])[0]).toContain("handle");
  });

  it("run 指定時は run-create を呼ばない", async () => {
    const { client, calls } = createFakeClient({ agentTerminalHandle: "term_new" });
    await delegateTask(client, { spec: "a", run: "run_given" });
    expect(calls.some((call) => call.startsWith("runCreate:"))).toBe(false);
    expect(calls[0]).toContain('"run":"run_given"');
  });
});

describe("getTaskStatus(poll)", () => {
  // 実ペイロード(task-list / worker-list)を採った fixture
  const taskList = {
    ok: true,
    result: {
      runId: "run_a781f51d4c91",
      legacyReadOnly: false,
      tasks: [
        {
          id: "task_3208dcf22c18",
          run_id: "run_a781f51d4c91",
          task_title: "smoke job",
          display_name: "smoke job",
          spec: "Reply with exactly OK. Do not modify any files.",
          status: "dispatched",
          result: null,
          created_at: "2026-10-06 10:15:59",
          completed_at: null,
          assignee_handle: "term_76d5cb08",
          dispatch_id: "ctx_42e6925ec35f",
        },
      ],
      count: 1,
    },
  };
  const workerList = {
    ok: true,
    result: {
      workers: [
        {
          dispatchId: "ctx_42e6925ec35f",
          taskId: "task_3208dcf22c18",
          workerState: "unsupervised",
          dispatchStatus: "dispatched",
          agentTerminalHandle: "term_76d5cb08",
          terminalState: "retained",
          projection: { provider: "codex", outcome: "in_progress", stage: { activity: "working" } },
        },
        {
          dispatchId: "ctx_other",
          taskId: "task_other",
          workerState: "supervised",
          projection: { outcome: "in_progress" },
        },
      ],
      counts: { retained: 1 },
    },
  };

  it("state / phase / workers を正規化して返す(ユーザー想定の応答形状)", async () => {
    const { client } = createFakeClient({
      taskList,
      dispatchShow: { ok: true, result: { dispatch: { id: "ctx_42e6925ec35f", task_id: "task_3208dcf22c18" } } },
      workerList,
    });
    const view = await getTaskStatus(client, { taskId: "task_3208dcf22c18" });

    expect(view).toMatchObject({
      taskId: "task_3208dcf22c18",
      state: "running",
      phase: "implementation",
      rawStatus: "dispatched",
      runId: "run_a781f51d4c91",
      title: "smoke job",
      assigneeHandle: "term_76d5cb08",
    });
    expect(view["workers"]).toEqual([
      expect.objectContaining({
        agent: "codex",
        status: "running",
        dispatchId: "ctx_42e6925ec35f",
        terminalHandle: "term_76d5cb08",
      }),
    ]);
    expect(view["nextAction"]).toContain("orca_get_task_status");
  });

  it("pending gate があれば phase は decision_gate", async () => {
    const { client } = createFakeClient({
      taskList: { ok: true, result: { tasks: [{ id: "task_abc123", status: "blocked" }] } },
      gateList: { ok: true, result: { gates: [{ id: "g1", status: "pending" }] } },
    });
    const view = await getTaskStatus(client, { taskId: "task_abc123" });
    expect(view["state"]).toBe("blocked");
    expect(view["phase"]).toBe("decision_gate");
    expect(view["gates"]).toEqual([{ id: "g1", status: "pending" }]);
  });

  it("完了時 nextAction は orca_get_task_result を指す", async () => {
    const { client } = createFakeClient({
      taskList: { ok: true, result: { tasks: [{ taskId: "task_abc123", status: "completed" }] } },
    });
    const view = await getTaskStatus(client, { taskId: "task_abc123" });
    expect(view["phase"]).toBe("finished");
    expect(view["nextAction"]).toContain("orca_get_task_result");
  });

  it("context-only dispatch では agent が null なので terminal list の agentIdentity で補強する", async () => {
    const { client } = createFakeClient({
      taskList,
      workerList: {
        ok: true,
        result: {
          workers: [
            {
              dispatchId: "ctx_42e6925ec35f",
              taskId: "task_3208dcf22c18",
              workerState: "unsupervised",
              agentTerminalHandle: "term_76d5cb08",
              projection: { outcome: "in_progress" },
            },
          ],
        },
      },
      terminals: [{ handle: "term_76d5cb08", agentIdentity: "codex", connected: true }],
    });
    const view = await getTaskStatus(client, { taskId: "task_3208dcf22c18" });
    expect((view["workers"] as JsonObject[])[0]?.["agent"]).toBe("codex");
  });

  it("未知の taskId は JobError(task_not_found)", async () => {
    const { client } = createFakeClient({ taskList });
    await expect(getTaskStatus(client, { taskId: "nope" })).rejects.toThrowError(JobError);
  });
});

describe("getTaskResult(result)", () => {
  it("実ペイロード(terminal.tail)から出力し尾部をテキストに落とす", async () => {
    const { client, calls } = createFakeClient({
      taskList: {
        ok: true,
        result: {
          tasks: [
            {
              id: "task_3208dcf22c18",
              status: "completed",
              result: "OK",
              dispatch_id: "ctx_42e6925ec35f",
              completed_at: "2026-10-06 10:16:20",
            },
          ],
        },
      },
      dispatchShow: { ok: true, result: { dispatch: { id: "ctx_42e6925ec35f" } } },
      workerRead: {
        ok: true,
        result: {
          dispatchId: "ctx_42e6925ec35f",
          source: "terminal",
          terminal: {
            handle: "term_76d5cb08",
            status: "running",
            tail: ["› Reply with exactly OK.", "• OK", "  Worked for 8s • 19:16"],
            nextCursor: "2",
          },
          status: { worker: "unsupervised", terminal: "running", liveness: "live" },
          cursor: "owr1_xxx",
        },
      },
    });
    const view = await getTaskResult(client, { taskId: "task_3208dcf22c18" });

    expect(view).toMatchObject({
      taskId: "task_3208dcf22c18",
      state: "completed",
      result: "OK",
      finishedAt: "2026-10-06 10:16:20",
    });
    const outputs = view["outputs"] as JsonObject[];
    expect(outputs[0]).toMatchObject({
      dispatchId: "ctx_42e6925ec35f",
      source: "terminal",
      terminalStatus: "running",
      nextCursor: "2",
      cursor: "owr1_xxx",
    });
    expect(String(outputs[0]?.["text"])).toContain("• OK");
    expect(calls.some((call) => call.startsWith("workerRead:"))).toBe(true);
  });

  it("transcript があるときは transcript.tail を使い、長い出力は 4000 字で切る", async () => {
    const { client } = createFakeClient({
      taskList: {
        ok: true,
        result: { tasks: [{ id: "t1", status: "completed", dispatch_id: "d1" }] },
      },
      workerRead: {
        ok: true,
        result: {
          source: "transcript",
          transcript: { tail: Array.from({ length: 200 }, (_, i) => `line ${i}`) },
        },
      },
    });
    const view = await getTaskResult(client, { taskId: "t1" });
    const outputs = view["outputs"] as JsonObject[];
    const text = String(outputs[0]?.["text"] ?? "");
    expect(text).toContain("line 0");
    expect(text.length).toBeLessThanOrEqual(4001);
    expect(outputs[0]?.["terminalStatus"]).toBeNull();
  });

  it("worker-read 失敗は outputs に理由として記録し、応答は壊さない", async () => {
    const client = {
      taskList: async () => ({ ok: true, result: { tasks: [{ taskId: "t1", status: "failed" }] } }),
      dispatchShow: async () => ({ ok: true, result: { dispatch: { dispatchId: "d1" } } }),
      workerRead: async () => {
        throw new Error("worker_not_readable");
      },
    } as unknown as OrcaClient;

    const view = await getTaskResult(client, { taskId: "t1" });
    const outputs = view["outputs"] as JsonObject[];
    expect(String(outputs[0]?.["error"] ?? "")).toContain("worker_not_readable");
    expect(view["state"]).toBe("failed");
  });
});

describe("sendMessage(介入)", () => {
  it("subject と run を送って messageId を返す", async () => {
    const { client, calls } = createFakeClient();
    const result = await sendMessage(client, {
      subject: "方針変更",
      body: "実装は src/ のみに限定してください",
      run: "run_a781f51d4c91",
      taskId: "task_3208dcf22c18",
      type: "status",
    });
    expect(result).toMatchObject({
      ok: true,
      messageId: "msg_1",
      runId: "run_a781f51d4c91",
      type: "status",
      subject: "方針変更",
    });
    expect(calls[0]).toContain('"run":"run_a781f51d4c91"');
  });

  it("type=worker_done に outcome が無いと JobError(outcome_required)", async () => {
    const { client } = createFakeClient();
    await expect(
      sendMessage(client, { subject: "done", type: "worker_done" }),
    ).rejects.toThrowError(JobError);
  });

  it("worker_done + outcome は通る", async () => {
    const { client } = createFakeClient();
    const result = await sendMessage(client, {
      subject: "done",
      type: "worker_done",
      outcome: "succeeded",
      dispatchId: "ctx_1",
    });
    expect(result["type"]).toBe("worker_done");
  });
});

describe("cancelTask(介入)", () => {
  const runningTaskList = {
    ok: true,
    result: {
      tasks: [
        {
          id: "task_3208dcf22c18",
          run_id: "run_a781f51d4c91",
          status: "dispatched",
          dispatch_id: "ctx_42e6925ec35f",
        },
      ],
    },
  };

  it("worker-stop してから task を failed/cancelled にする(CLI の手順)", async () => {
    const { client, calls } = createFakeClient({ taskList: runningTaskList });
    const result = await cancelTask(client, { taskId: "task_3208dcf22c18", reason: "方針変更" });

    expect(result).toMatchObject({
      taskId: "task_3208dcf22c18",
      state: "cancelled",
      cancelled: true,
      runId: "run_a781f51d4c91",
      mode: "stop",
      reason: "方針変更",
    });
    expect((result["workers"] as JsonObject[])[0]).toMatchObject({
      dispatchId: "ctx_42e6925ec35f",
      action: "stop",
      resultState: "stopped",
    });
    // 順序: 読む → fence する → task を更新する
    const stopIndex = calls.findIndex((call) => call.startsWith("workerStop:"));
    const updateIndex = calls.findIndex((call) => call.startsWith("taskUpdate:"));
    expect(stopIndex).toBeGreaterThan(-1);
    expect(updateIndex).toBeGreaterThan(stopIndex);
    expect(calls[updateIndex]).toContain('"status":"failed"');
    expect(calls[updateIndex]).toContain("cancelled: 方針変更");
  });

  it("mode: abandon では worker-abandon を使う", async () => {
    const { client, calls } = createFakeClient({ taskList: runningTaskList });
    await cancelTask(client, { taskId: "task_3208dcf22c18", mode: "abandon" });
    expect(calls.some((call) => call.startsWith("workerAbandon:"))).toBe(true);
    expect(calls.some((call) => call.startsWith("workerStop:"))).toBe(false);
  });

  it("完了済みタスクでは何も変更しない(冪等)", async () => {
    const { client, calls } = createFakeClient({
      taskList: { ok: true, result: { tasks: [{ id: "t1", status: "completed" }] } },
    });
    const result = await cancelTask(client, { taskId: "t1" });
    expect(result["cancelled"]).toBe(false);
    expect(result["state"]).toBe("completed");
    expect(calls.some((call) => call.startsWith("workerStop:"))).toBe(false);
    expect(calls.some((call) => call.startsWith("taskUpdate:"))).toBe(false);
  });

  it("worker-stop 失敗は warnings に記録し、task のキャンセルは進める", async () => {
    const client = {
      taskList: async () => runningTaskList,
      dispatchShow: async () => ({ ok: true, result: { dispatch: null } }),
      workerStop: async () => {
        throw new Error("release_unknown");
      },
      taskUpdate: async () => ({ ok: true, result: {} }),
    } as unknown as OrcaClient;

    const result = await cancelTask(client, { taskId: "task_3208dcf22c18" });
    expect(result["cancelled"]).toBe(true);
    expect((result["warnings"] as string[])[0]).toContain("release_unknown");
  });

  it("task 行の id を dispatch id と取り違えない(worker-abandon を空打ちしない)", async () => {
    const { client, calls } = createFakeClient({
      taskList: { ok: true, result: { tasks: [{ id: "task_695cee4c872d", status: "dispatched" }] } },
      dispatchShow: { ok: true, result: { dispatch: null } },
    });
    const result = await cancelTask(client, { taskId: "task_695cee4c872d" });
    expect(calls.some((call) => call.includes("task_695cee4c872d") && call.startsWith("workerStop:"))).toBe(
      false,
    );
    expect(result["workers"]).toEqual([]);
    expect(result["cancelled"]).toBe(true);
  });

  it("consumer_fenced なら run-use でバインドを切り替えて 1 回再試行する", async () => {
    const { client, calls } = createFakeClient({ taskList: runningTaskList });
    let attempts = 0;
    client.taskUpdate = (async (input: JsonObject) => {
      attempts += 1;
      calls.push(`taskUpdate:${JSON.stringify(input)}`);
      if (attempts === 1) {
        throw new OrcaCommandError(
          {
            code: "consumer_fenced",
            message: "This coordinator terminal is bound to run_other, not run_a781f51d4c91.",
          },
          { ok: false, args: ["orchestration", "task-update"], exitCode: 1, stdout: "", stderr: "" },
        );
      }
      return { ok: true, result: {} };
    }) as unknown as typeof client.taskUpdate;

    const result = await cancelTask(client, { taskId: "task_3208dcf22c18" });
    expect(result["cancelled"]).toBe(true);
    expect(calls.filter((call) => call.startsWith("taskUpdate:")).length).toBe(2);
    expect(calls.some((call) => call === "runUse:run_a781f51d4c91")).toBe(true);
  });

  it("再試行も失敗したら JobError(cancel_incomplete) に fence 済みの worker を載せる", async () => {
    const client = {
      taskList: async () => runningTaskList,
      dispatchShow: async () => ({ ok: true, result: { dispatch: { id: "ctx_1" } } }),
      workerStop: async () => ({ ok: true, result: { state: "stopped" } }),
      taskUpdate: async () => {
        throw new OrcaCommandError(
          { code: "consumer_fenced", message: "This coordinator terminal is bound to run_x, not run_a781f51d4c91." },
          { ok: false, args: ["orchestration", "task-update"], exitCode: 1, stdout: "", stderr: "" },
        );
      },
      runUse: async () => ({ ok: true, result: {} }),
    } as unknown as OrcaClient;

    const error = await cancelTask(client, { taskId: "task_3208dcf22c18" }).catch((e) => e);
    expect(error).toBeInstanceOf(JobError);
    expect((error as JobError).code).toBe("cancel_incomplete");
    expect(JSON.stringify((error as JobError).detail)).toContain("ctx_1");
  });

  it("未知の taskId は JobError(task_not_found)", async () => {
    const { client } = createFakeClient();
    await expect(cancelTask(client, { taskId: "nope" })).rejects.toThrowError(JobError);
  });
});

describe("extractBoundRun", () => {
  it("fence メッセージからバインド中の Run ID を拾う", () => {
    expect(
      extractBoundRun("This coordinator terminal is bound to run_2fd476f310f3, not run_a781f51d4c91."),
    ).toBe("run_2fd476f310f3");
    expect(extractBoundRun("no run here")).toBeUndefined();
  });
});
