import { describe, expect, it } from "vitest";
import type { JsonObject, OrcaClient } from "../src/orca/client.js";
import {
  buildWorktreeName,
  cancelTask,
  collectDescendants,
  estimatePhase,
  outputHashOf,
  extractBoundRun,
  findChildTasks,
  findTaskById,
  getTaskResult,
  getTaskStatus,
  delegateTask,
  JobError,
  mapTaskState,
  mapWorkerStatus,
  resolveGate,
  sendMessage,
  toChildRow,
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
      attentionCategories: ["unverifiable"],
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
    expect(estimatePhase("blocked", [], [])).toBe("blocked");
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

describe("findChildTasks / toChildRow", () => {
  const payload = {
    ok: true,
    result: {
      tasks: [
        { id: "p", parent_id: null, status: "dispatched" },
        { id: "c1", parent_id: "p", status: "completed", task_title: "c1" },
        { id: "c2", parent_id: "p", status: "ready" },
        { id: "z", parent_id: "other", status: "ready" },
      ],
    },
  };

  it("parent_id が一致する子タスクだけを取り出す", () => {
    expect(findChildTasks(payload, "p").map((task) => task["id"])).toEqual(["c1", "c2"]);
    expect(findChildTasks(payload, "nobody")).toEqual([]);
  });

  it("子タスク 1 行を正規化し、その worker を添える", () => {
    const child = findChildTasks(payload, "p")[0] as JsonObject;
    const workers = [{ taskId: "c1", status: "completed", dispatchId: "d1" }];
    expect(toChildRow(child, workers)).toMatchObject({
      taskId: "c1",
      title: "c1",
      state: "completed",
      rawStatus: "completed",
      workers,
    });
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
  workerStartDispatchId?: string;
  workerStartThrows?: Error;
  /** worker-start の receipt をそのまま返す(agent_readiness 失敗等の再現)。 */
  workerStartReceipt?: JsonObject;
  taskList?: JsonObject;
  dispatchShow?: JsonObject;
  workerList?: JsonObject;
  gateList?: JsonObject;
  gateResolve?: JsonObject;
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
    workerStart: async (input: JsonObject) => {
      calls.push(`workerStart:${JSON.stringify(input)}`);
      if (options.workerStartThrows !== undefined) {
        throw options.workerStartThrows;
      }
      if (options.workerStartReceipt !== undefined) {
        return { ok: true, result: options.workerStartReceipt };
      }
      return {
        ok: true,
        result: {
          dispatch: { dispatchId: options.workerStartDispatchId ?? "disp_commander" },
          worker: { agentTerminalHandle: options.agentTerminalHandle ?? "term_cmd" },
        },
      };
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
    gateResolve: async (input: JsonObject) => {
      calls.push(`gateResolve:${JSON.stringify(input)}`);
      return (
        options.gateResolve ?? {
          ok: true,
          result: { gate: { id: input["id"], status: "resolved", resolution: input["resolution"] } },
        }
      );
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

describe("delegateTask(submit / Commander API)", () => {
  it("既定は Commander 経路: run-create → task-create → worker-start を呼び、完了を待たない", async () => {
    const { client, calls } = createFakeClient();
    const result = await delegateTask(client, { spec: "README を更新して" });

    expect(result).toMatchObject({
      taskId: "task_abc123",
      state: "running",
      runId: "run_test",
      commander: true,
      commanderAgent: "codex",
      dispatchId: "disp_commander",
      warnings: [],
    });
    expect(result["target"]).toMatchObject({
      kind: "supervised_worker",
      worktree: "new-child",
      agent: "codex",
    });
    expect(result["nextAction"]).toContain("orca_get_task_status");

    // 順序: run-create → task-create → worker-start(待つ処理は無い)
    expect(calls[0]).toMatch(/^runCreate:/);
    expect(calls[1]).toMatch(/^taskCreate:/);
    expect(calls[2]).toMatch(/^workerStart:/);
    expect(calls).toHaveLength(3);
    // 低レベル経路(worktree create / dispatch)には絶対に落ちない
    expect(calls.some((call) => call.startsWith("worktreeCreate:"))).toBe(false);
    expect(calls.some((call) => call.startsWith("dispatch:"))).toBe(false);
  });

  it("task-create の spec に固定の Commander 指示とユーザーの goal が入る", async () => {
    const { client, calls } = createFakeClient();
    await delegateTask(client, { spec: "README を更新して", repo: "name:my-project" });

    const taskCreate = calls[1] ?? "";
    expect(taskCreate).toContain("You are the lead coding orchestrator");
    expect(taskCreate).toContain("README を更新して");
    expect(taskCreate).toContain("name:my-project");
    // orchestration 変更の前に version-matched guide を読ませる(公式の推奨)
    expect(taskCreate).toContain("orca skills get orchestration --full");
    expect(taskCreate).toContain("worker-start");
    // gate は Commander 所有(Worker が人間向け gate を作って良いことにならない)
    expect(taskCreate).toContain("You own every human-facing decision gate");
    expect(taskCreate).toContain("Workers must not create gates");
    // 完了宣言の前に全 child task の terminal + result 確認を課す
    expect(taskCreate).toContain("verify that every delegated child task has reached a");
    expect(taskCreate).toContain("terminal state and inspect its result");
    // failed child を抱えたまま parent を成功にしない(retry / replace / 明示報告が先)
    expect(taskCreate).toContain("Do not mark the parent task successful if any required child task failed");
    expect(taskCreate).toContain("Resolve, retry, replace, or explicitly report the failure first");
    // 承認プロンプトで止まったら guide 読み込みを諦めて --help に退避する(E2E で実測した停止)
    expect(taskCreate).toContain("If loading the guide is blocked by a tool-permission prompt");
    expect(taskCreate).toContain("fall back to");
    expect(taskCreate).toContain("orca orchestration --help");
    // 自分の Run の中で走る Commander が新しい Run を作って job を分断しない(E2E で実測)
    expect(taskCreate).toContain("Run ownership:");
    expect(taskCreate).toContain("Do not create new Runs");
    expect(taskCreate).toContain("--parent set to your task");
  });

  it("constraints は Constraints 欄に箇条書きで入る(省略時は既定の 1 行)", async () => {
    const { client, calls } = createFakeClient();
    await delegateTask(client, {
      spec: "ユーザー認証機能を追加する",
      constraints: ["既存APIを変更しない", "テストを追加する", "マージはしない"],
    });
    const taskCreate = calls[1] ?? "";
    expect(taskCreate).toContain("- 既存APIを変更しない");
    expect(taskCreate).toContain("- テストを追加する");
    expect(taskCreate).toContain("- マージはしない");
    expect(taskCreate).not.toContain("Preserve existing APIs");

    const { client: client2, calls: calls2 } = createFakeClient();
    await delegateTask(client2, { spec: "a" });
    expect(calls2[1]).toContain("- Preserve existing APIs and project conventions.");
  });

  it("commanderAgent は worker-start に渡り、作業ワーカーの選択には使わない", async () => {
    const { client, calls } = createFakeClient();
    const result = await delegateTask(client, { spec: "a", commanderAgent: "claude", title: "Auth" });
    expect(calls[2]).toContain('"agent":"claude"');
    expect(calls[2]).toContain('"worktree":"new-child"');
    expect(calls[2]).toContain('"name":"Auth"');
    expect(result["commanderAgent"]).toBe("claude");
  });

  it("worker-start 失敗時もタスクを生かし state: queued + warnings で返す(例外にしない)", async () => {
    const { client, calls } = createFakeClient({
      workerStartThrows: new Error("nested_worker_depth_exceeded"),
    });
    const result = await delegateTask(client, { spec: "a" });
    expect(result["taskId"]).toBe("task_abc123");
    expect(result["state"]).toBe("queued");
    expect(result["dispatchId"]).toBeNull();
    expect((result["warnings"] as string[])[0]).toContain("worker-start failed");
    expect((result["warnings"] as string[])[0]).toContain("nested_worker_depth_exceeded");
    // task-create まで成功していれば Job は成立している
    expect(calls[1]).toMatch(/^taskCreate:/);
  });

  it("worker-start receipt が agent_readiness で failed → queued + stage/lastError を正直に warning", async () => {
    // 実測: agentCmdOverrides で起動した worker は launch token が記録されず readiness を通れない。
    // receipt は ok:true / state:failed で返るので、transport 失敗ではなく queued + warning に落とす。
    const { client, calls } = createFakeClient({
      workerStartReceipt: {
        dispatchId: "ctx_readiness_failed",
        state: "failed",
        stage: "agent_readiness",
        failedStage: "agent_readiness",
        lastError: "timeout",
      },
    });
    const result = await delegateTask(client, { spec: "a", commanderAgent: "dsh" });
    expect(result["state"]).toBe("queued");
    expect(result["dispatchId"]).toBe("ctx_readiness_failed");
    const warnings = result["warnings"] as string[];
    expect(warnings[0]).toContain("agent_readiness");
    expect(warnings[0]).toContain("timeout");
    expect(warnings[0]).toContain("task-update");
    expect((result["nextAction"] as string)).toContain("worker-release");
    expect(calls.filter((call) => call.startsWith("workerStart:")).length).toBe(1);
  });

  it("worker-start が consumer_fenced なら run-use で切り替えて 1 回だけ再試行する", async () => {
    const { client, calls } = createFakeClient();
    let attempts = 0;
    client.workerStart = (async (input: JsonObject) => {
      attempts += 1;
      calls.push(`workerStart:${JSON.stringify(input)}`);
      if (attempts === 1) {
        throw new OrcaCommandError(
          { code: "consumer_fenced", message: "This coordinator terminal is bound to run_other, not run_test." },
          { ok: false, args: ["orchestration", "worker-start"], exitCode: 1, stdout: "", stderr: "" },
        );
      }
      return { ok: true, result: { dispatch: { dispatchId: "disp_retry" } } };
    }) as unknown as typeof client.workerStart;

    const result = await delegateTask(client, { spec: "a" });
    expect(result["state"]).toBe("running");
    expect(result["dispatchId"]).toBe("disp_retry");
    expect(calls.filter((call) => call.startsWith("workerStart:")).length).toBe(2);
    expect(calls.some((call) => call === "runUse:run_test")).toBe(true);
  });

  it("run 指定時は run-create を呼ばない", async () => {
    const { client, calls } = createFakeClient();
    await delegateTask(client, { spec: "a", run: "run_given" });
    expect(calls.some((call) => call.startsWith("runCreate:"))).toBe(false);
    expect(calls[0]).toContain('"run":"run_given"');
  });

  it("run-create が ID を返さなければ JobError(run_create_failed)", async () => {
    const client = {
      runCreate: async () => ({ ok: true, result: {} }),
    } as unknown as OrcaClient;
    const error = await delegateTask(client, { spec: "a" }).catch((e) => e);
    expect(error).toBeInstanceOf(JobError);
    expect((error as JobError).code).toBe("run_create_failed");
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
    expect(view["gates"]).toEqual([
      { id: "g1", taskId: null, status: "pending", question: null, options: null },
    ]);
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

describe("getTaskStatus(poll) — worker の attention", () => {
  // E2E で `orca skills get orchestration --full` の承認プロンプトに Commander が止まり、
  // poll は running としか言わなかった。worker の attention を poll が正直に出す。
  const attentionTaskList = {
    ok: true,
    result: {
      tasks: [
        {
          id: "task_stuck",
          run_id: "run_x",
          status: "dispatched",
          spec: "README を編集する",
          dispatch_id: "ctx_stuck",
        },
      ],
      count: 1,
    },
  };
  const attentionWorkerList = {
    ok: true,
    result: {
      workers: [
        {
          dispatchId: "ctx_stuck",
          taskId: "task_stuck",
          workerState: "ready",
          dispatchStatus: "dispatched",
          agentTerminalHandle: "term_stuck",
          terminalState: "active",
          projection: {
            outcome: "in_progress",
            stage: { worker: "ready", dispatch: "dispatched", activity: "unknown" },
            liveness: { verdict: "unverifiable", reason: "missing_status" },
            attention: { requiresAction: true, categories: ["unverifiable"] },
          },
        },
      ],
      counts: { active: 1 },
    },
  };

  it("attention が必要な worker を attentionRequired / attentionNotes に出す", async () => {
    const { client } = createFakeClient({ taskList: attentionTaskList, workerList: attentionWorkerList });
    const view = await getTaskStatus(client, { taskId: "task_stuck" });
    expect(view["attentionRequired"]).toBe(true);
    const notes = view["attentionNotes"] as string[];
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("ctx_stuck");
    expect(notes[0]).toContain("unverifiable");
    expect((view["workers"] as JsonObject[])[0]?.["attentionCategories"]).toEqual(["unverifiable"]);
  });

  it("attention 不要なら attentionRequired: false と空の notes", async () => {
    const { client } = createFakeClient({
      taskList: attentionTaskList,
      workerList: {
        ok: true,
        result: {
          workers: [
            {
              dispatchId: "ctx_ok",
              taskId: "task_stuck",
              workerState: "ready",
              projection: {
                outcome: "in_progress",
                stage: { activity: "working" },
                liveness: { verdict: "alive" },
                attention: { requiresAction: false, categories: [] },
              },
            },
          ],
        },
      },
    });
    const view = await getTaskStatus(client, { taskId: "task_stuck" });
    expect(view["attentionRequired"]).toBe(false);
    expect(view["attentionNotes"]).toEqual([]);
  });
});

describe("getTaskStatus(poll) — dsh 型 worker の task-update 報告待ち", () => {
  // 実測(2026-10-08): dsh worker は launch token が記録されず dispatch が agent_readiness で失敗、
  // task は即 failed になる。pane は goal を完走し task-update で報告するので completed が後から届く。
  const dshTaskList = {
    ok: true,
    result: {
      tasks: [
        {
          id: "task_dsh",
          run_id: "run_dsh",
          status: "failed",
          spec: "DSH-PROBE.md を作る",
          dispatch_id: "ctx_dsh",
        },
      ],
      count: 1,
    },
  };
  const tokenlessDispatch = {
    ok: true,
    result: {
      dispatch: {
        id: "ctx_dsh",
        task_id: "task_dsh",
        status: "failed",
        last_failure: "timeout",
        launch_token_hash: null,
      },
    },
  };
  const aliveWorkerList = {
    ok: true,
    result: {
      workers: [
        {
          dispatchId: "ctx_dsh",
          taskId: "task_dsh",
          workerState: "ready",
          agentTerminalHandle: "term_dsh",
          terminalState: "active",
          projection: {
            outcome: "in_progress",
            stage: { activity: "working" },
            liveness: { verdict: "alive" },
            attention: { requiresAction: false, categories: [] },
          },
        },
      ],
      counts: { active: 1 },
    },
  };

  it("launch token 無しで失敗した dispatch + 生存 worker なら workerReportPending: true", async () => {
    const { client } = createFakeClient({
      taskList: dshTaskList,
      dispatchShow: tokenlessDispatch,
      workerList: aliveWorkerList,
    });
    const view = await getTaskStatus(client, { taskId: "task_dsh" });
    expect(view["state"]).toBe("failed");
    expect(view["workerReportPending"]).toBe(true);
    expect(String(view["workerReportNote"])).toContain("task-update");
  });

  it("worker が生存でなければ workerReportPending: false(note も出さない)", async () => {
    const { client } = createFakeClient({
      taskList: dshTaskList,
      dispatchShow: tokenlessDispatch,
      workerList: {
        ok: true,
        result: {
          workers: [
            {
              dispatchId: "ctx_dsh",
              taskId: "task_dsh",
              workerState: "released",
              terminalState: "closed",
              projection: {
                outcome: "failed",
                stage: { activity: "unknown" },
                liveness: { verdict: "exited" },
                attention: { requiresAction: false, categories: [] },
              },
            },
          ],
          counts: { active: 0 },
        },
      },
    });
    const view = await getTaskStatus(client, { taskId: "task_dsh" });
    expect(view["workerReportPending"]).toBe(false);
    expect(view["workerReportNote"]).toBeUndefined();
  });

  it("launch token が入った dispatch(codex / claude)なら workerReportPending: false", async () => {
    const { client } = createFakeClient({
      taskList: dshTaskList,
      dispatchShow: {
        ok: true,
        result: {
          dispatch: {
            id: "ctx_dsh",
            task_id: "task_dsh",
            status: "failed",
            last_failure: "timeout",
            launch_token_hash: "10e0bf264833065684f1c1c05aba7591936661e63c956e4b3a02ecc73d00aa2d",
          },
        },
      },
      workerList: aliveWorkerList,
    });
    const view = await getTaskStatus(client, { taskId: "task_dsh" });
    expect(view["workerReportPending"]).toBe(false);
  });
});

describe("getTaskStatus(poll) — Commander の配下", () => {
  // Commander(task_cmd)が task-create で分解した子タスクと、その worker の fixture
  const commanderTaskList = {
    ok: true,
    result: {
      runId: "run_x",
      tasks: [
        {
          id: "task_cmd",
          run_id: "run_x",
          parent_id: null,
          task_title: "Commander",
          spec: "You are the lead coding orchestrator",
          status: "dispatched",
        },
        {
          id: "task_backend",
          run_id: "run_x",
          parent_id: "task_cmd",
          task_title: "Implement backend",
          spec: "backend",
          status: "completed",
          result: "backend done",
          completed_at: "2026-10-07 09:00:00",
        },
        {
          id: "task_tests",
          run_id: "run_x",
          parent_id: "task_cmd",
          task_title: "Write tests",
          spec: "tests",
          status: "dispatched",
        },
        {
          id: "task_unrelated",
          run_id: "run_x",
          parent_id: "task_other",
          task_title: "unrelated",
          status: "ready",
        },
      ],
      count: 4,
    },
  };
  const fleetWorkers = {
    ok: true,
    result: {
      workers: [
        { dispatchId: "disp_cmd", taskId: "task_cmd", projection: { provider: "codex", outcome: "in_progress" } },
        { dispatchId: "disp_be", taskId: "task_backend", projection: { provider: "claude", outcome: "succeeded" } },
        { dispatchId: "disp_ts", taskId: "task_tests", projection: { provider: "codex", outcome: "in_progress" } },
        { dispatchId: "disp_x", taskId: "task_unrelated", projection: { provider: "muse", outcome: "in_progress" } },
      ],
    },
  };

  it("children に子タスクの state と worker が入り、Commander 配下が見える", async () => {
    const { client } = createFakeClient({
      taskList: commanderTaskList,
      workerList: fleetWorkers,
      dispatchShow: { ok: true, result: { dispatch: { id: "disp_cmd" } } },
    });
    const view = await getTaskStatus(client, { taskId: "task_cmd" });

    expect(view["commander"]).toMatchObject({ agent: "codex", status: "running", dispatchId: "disp_cmd" });
    expect(view["childCount"]).toBe(2);
    const children = view["children"] as JsonObject[];
    expect(children.map((child) => child["taskId"])).toEqual(["task_backend", "task_tests"]);
    expect(children[0]).toMatchObject({
      taskId: "task_backend",
      title: "Implement backend",
      state: "completed",
      rawStatus: "completed",
      resultPreview: "backend done",
    });
    expect(children[0]?.["workers"]).toEqual([
      expect.objectContaining({ agent: "claude", status: "completed", dispatchId: "disp_be" }),
    ]);
    expect(children[1]?.["state"]).toBe("running");
    // 対象タスク自身の workers は子タスクのものを混ぜない
    expect(view["workers"]).toEqual([
      expect.objectContaining({ agent: "codex", dispatchId: "disp_cmd" }),
    ]);
  });

  it("子タスクが無い Commander では children は空(子 worker も混ざらない)", async () => {
    const { client } = createFakeClient({
      taskList: { ok: true, result: { tasks: [{ id: "task_cmd", status: "dispatched" }] } },
      workerList: fleetWorkers,
    });
    const view = await getTaskStatus(client, { taskId: "task_cmd" });
    expect(view["children"]).toEqual([]);
    expect(view["childCount"]).toBe(0);
    expect((view["workers"] as JsonObject[]).map((worker) => worker["dispatchId"])).toEqual(["disp_cmd"]);
  });

  it("子 worker まで含めて phase を推定する(子も自分も完了 then settling)", async () => {
    const { client } = createFakeClient({
      taskList: {
        ok: true,
        result: {
          tasks: [
            { id: "task_cmd", status: "dispatched" },
            { id: "c1", parent_id: "task_cmd", status: "completed" },
          ],
        },
      },
      workerList: {
        ok: true,
        result: {
          workers: [
            { dispatchId: "disp_cmd", taskId: "task_cmd", projection: { outcome: "succeeded" } },
            { dispatchId: "disp_c1", taskId: "c1", projection: { outcome: "succeeded" } },
          ],
        },
      },
    });
    const view = await getTaskStatus(client, { taskId: "task_cmd" });
    expect(view["phase"]).toBe("settling");
  });

  it("pending gate には question / options が付き、nextAction は orca_resolve_gate を指す", async () => {
    const { client } = createFakeClient({
      taskList: { ok: true, result: { tasks: [{ id: "task_cmd", status: "blocked" }] } },
      gateList: {
        ok: true,
        result: {
          gates: [
            {
              id: "gate_1",
              run_id: "run_x",
              task_id: "task_cmd",
              question: "main へ merge してよい?",
              options: '["approve","reject"]',
              status: "pending",
            },
          ],
        },
      },
    });
    const view = await getTaskStatus(client, { taskId: "task_cmd" });
    expect(view["phase"]).toBe("decision_gate");
    expect(view["gates"]).toEqual([
      {
        id: "gate_1",
        taskId: "task_cmd",
        status: "pending",
        question: "main へ merge してよい?",
        options: '["approve","reject"]',
      },
    ]);
    expect(view["blockedReasons"]).toEqual([
      {
        kind: "gate",
        taskId: "task_cmd",
        role: "commander",
        summary: "main へ merge してよい?",
        detail: { gateId: "gate_1", options: '["approve","reject"]' },
      },
    ]);
    expect(view["nextAction"]).toContain("orca_resolve_gate");
  });

  it("子タスクのゲートは見え、無関係な task のゲートは除外される", async () => {
    const { client } = createFakeClient({
      taskList: {
        ok: true,
        result: {
          tasks: [
            { id: "task_cmd", status: "dispatched" },
            { id: "task_child", parent_id: "task_cmd", status: "blocked" },
            { id: "task_other", status: "blocked" },
          ],
        },
      },
      gateList: {
        ok: true,
        result: {
          gates: [
            { id: "gate_c", task_id: "task_child", question: "削除してよい?", status: "pending" },
            { id: "gate_o", task_id: "task_other", question: "無関係", status: "pending" },
          ],
        },
      },
    });
    const view = await getTaskStatus(client, { taskId: "task_cmd" });
    expect((view["gates"] as JsonObject[]).map((gate) => gate["id"])).toEqual(["gate_c"]);
    expect((view["blockedReasons"] as JsonObject[]).map((reason) => reason["role"])).toEqual(["child"]);
    expect(view["phase"]).toBe("decision_gate");
    expect(view["nextAction"]).toContain("orca_resolve_gate");
  });

  it("ゲートが無い blocked は task_report として result を返し、phase は blocked", async () => {
    const { client } = createFakeClient({
      taskList: {
        ok: true,
        result: {
          tasks: [{ id: "task_cmd", status: "blocked", result: "Blocked: nested_worker_depth_exceeded" }],
        },
      },
    });
    const view = await getTaskStatus(client, { taskId: "task_cmd" });
    expect(view["phase"]).toBe("blocked");
    expect(view["blockedReasons"]).toEqual([
      { kind: "task_report", taskId: "task_cmd", role: "commander", summary: "Blocked: nested_worker_depth_exceeded" },
    ]);
    expect(view["nextAction"]).toContain("blockedReasons");
  });

  it("根拠が無い blocked は unknown になる", async () => {
    const { client } = createFakeClient({
      taskList: { ok: true, result: { tasks: [{ id: "task_cmd", status: "blocked" }] } },
    });
    const view = await getTaskStatus(client, { taskId: "task_cmd" });
    expect((view["blockedReasons"] as JsonObject[]).map((reason) => reason["kind"])).toEqual(["unknown"]);
  });

  it("終端状態の worker に残った attention は agent_prompt にしない", async () => {
    const worker = {
      dispatchId: "disp_1",
      taskId: "task_cmd",
      workerState: "succeeded",
      projection: { outcome: "succeeded", attention: { requiresAction: true, categories: ["input"] } },
    };
    const { client, calls } = createFakeClient({
      taskList: { ok: true, result: { tasks: [{ id: "task_cmd", status: "dispatched" }] } },
      dispatchShow: { ok: true, result: { dispatches: [{ dispatchId: "disp_1" }] } },
      workerList: { ok: true, result: { workers: [worker] } },
    });
    const view = await getTaskStatus(client, { taskId: "task_cmd" });
    expect(view["blockedReasons"]).toEqual([]);
    expect(calls.some((call) => call.startsWith("workerRead:"))).toBe(false);
  });

  it("動作中の出力は looksLikePrompt: false で、hash は出力が変われば変わり、observedAt は ISO で返る", async () => {
    const make = (text: string) =>
      createFakeClient({
        taskList: { ok: true, result: { tasks: [{ id: "task_cmd", status: "dispatched" }] } },
        dispatchShow: { ok: true, result: { dispatches: [{ dispatchId: "disp_1" }] } },
        workerList: {
          ok: true,
          result: {
            workers: [
              {
                dispatchId: "disp_1",
                taskId: "task_cmd",
                workerState: "running",
                projection: {
                  attention: { requiresAction: true, categories: ["input"] },
                  stage: { activity: "waiting" },
                  evidence: { lastObservedAt: 1791721983181 },
                },
              },
            ],
          },
        },
        workerRead: { ok: true, result: { text, source: "terminal" } },
      });
    const detailOf = async (text: string) => {
      const view = await getTaskStatus(make(text).client, { taskId: "task_cmd" });
      return (view["blockedReasons"] as JsonObject[])[0]?.["detail"] as JsonObject;
    };
    const first = await detailOf("✻ Thinking…");
    const second = await detailOf("✻ Thinking… (12s)");
    expect(first["looksLikePrompt"]).toBe(false);
    expect(first["outputHash"]).not.toBe(second["outputHash"]);
    expect(first["observedAt"]).toBe(new Date(1791721983181).toISOString());
    expect(first["activity"]).toBe("waiting");
  });

  it("Orca が attention を立てなくても、waiting で出力末尾が承認プロンプトなら agent_prompt にする", async () => {
    const make = (text: string) =>
      createFakeClient({
        taskList: { ok: true, result: { tasks: [{ id: "task_cmd", status: "dispatched" }] } },
        dispatchShow: { ok: true, result: { dispatches: [{ dispatchId: "disp_1" }] } },
        workerList: {
          ok: true,
          result: {
            workers: [
              {
                dispatchId: "disp_1",
                taskId: "task_cmd",
                workerState: "ready",
                projection: {
                  outcome: "in_progress",
                  stage: { activity: "waiting" },
                  attention: { requiresAction: false, categories: [] },
                },
              },
            ],
          },
        },
        workerRead: { ok: true, result: { text, source: "terminal" } },
      });
    const prompt = await getTaskStatus(
      make("git status; git branch\n Do you want to proceed?\n ❯ 1. Yes\n   2. No").client,
      { taskId: "task_cmd" },
    );
    const reasons = prompt["blockedReasons"] as JsonObject[];
    expect(reasons.map((reason) => reason["kind"])).toEqual(["agent_prompt"]);
    expect((reasons[0]?.["detail"] as JsonObject)["looksLikePrompt"]).toBe(true);
    expect(prompt["attentionRequired"]).toBe(true);

    const idle = await getTaskStatus(make("✻ 子タスクの完了を待っています").client, { taskId: "task_cmd" });
    expect(idle["blockedReasons"]).toEqual([]);
    expect(idle["attentionRequired"]).toBe(false);
  });

  it("要 attention の worker は agent_prompt として出力末尾を返す", async () => {
    const worker = {
      dispatchId: "disp_1",
      taskId: "task_cmd",
      workerState: "running",
      projection: { attention: { requiresAction: true, categories: ["permission"] } },
    };
    const { client, calls } = createFakeClient({
      taskList: { ok: true, result: { tasks: [{ id: "task_cmd", status: "dispatched" }] } },
      dispatchShow: { ok: true, result: { dispatches: [{ dispatchId: "disp_1" }] } },
      workerList: { ok: true, result: { workers: [worker] } },
      workerRead: { ok: true, result: { text: "Allow this command? (y/n)", source: "terminal" } },
    });
    const view = await getTaskStatus(client, { taskId: "task_cmd" });
    const reasons = view["blockedReasons"] as JsonObject[];
    expect(reasons[0]?.["kind"]).toBe("agent_prompt");
    expect(reasons[0]?.["role"]).toBe("commander");
    expect(reasons[0]?.["detail"]).toEqual({
      dispatchId: "disp_1",
      outputTail: "Allow this command? (y/n)",
      outputHash: outputHashOf("Allow this command? (y/n)"),
      looksLikePrompt: true,
      observedAt: null,
      activity: null,
    });
    expect(calls.some((call) => call.startsWith("workerRead:"))).toBe(true);
  });
});

describe("resolveGate(介入 / Human-in-the-loop)", () => {
  const pendingGate = {
    ok: true,
    result: {
      gates: [
        {
          id: "gate_333059a5ece6",
          run_id: "run_x",
          task_id: "task_cmd",
          question: "main へ merge してよい?",
          options: '["approve","reject"]',
          status: "pending",
          resolution: null,
        },
      ],
    },
  };

  it("pending gate を解決し、gate の状態と resolution を返す", async () => {
    const { client, calls } = createFakeClient({ gateList: pendingGate });
    const result = await resolveGate(client, {
      gateId: "gate_333059a5ece6",
      resolution: "approve",
      run: "run_x",
    });

    expect(result).toMatchObject({
      gateId: "gate_333059a5ece6",
      resolved: true,
      status: "resolved",
      resolution: "approve",
      taskId: "task_cmd",
      runId: "run_x",
    });
    // 読む → 解決する の順(gate-resolve に --run は無い)
    expect(calls[0]).toMatch(/^gateList:/);
    expect(calls[1]).toMatch(/^gateResolve:/);
    expect(calls[1]).toContain('"id":"gate_333059a5ece6"');
    expect(calls[1]).toContain('"resolution":"approve"');
  });

  it("Run に gate が無ければ JobError(gate_not_found)で解決しない", async () => {
    const { client, calls } = createFakeClient();
    const error = await resolveGate(client, { gateId: "gate_nope", resolution: "approve", run: "run_x" }).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(JobError);
    expect((error as JobError).code).toBe("gate_not_found");
    expect(calls.some((call) => call.startsWith("gateResolve:"))).toBe(false);
  });

  it("解決済みの gate には何もしない(冪等)", async () => {
    const { client, calls } = createFakeClient({
      gateList: {
        ok: true,
        result: { gates: [{ id: "gate_1", run_id: "run_x", task_id: "t", status: "resolved", resolution: "approve" }] },
      },
    });
    const result = await resolveGate(client, { gateId: "gate_1", resolution: "reject", run: "run_x" });
    expect(result["resolved"]).toBe(false);
    expect(result["status"]).toBe("resolved");
    expect((result["warnings"] as string[])[0]).toContain("resolved");
    expect(calls.some((call) => call.startsWith("gateResolve:"))).toBe(false);
  });

  it("consumer_fenced なら run-use でバインドを切り替えて 1 回再試行する", async () => {
    const { client, calls } = createFakeClient({ gateList: pendingGate });
    let attempts = 0;
    client.gateResolve = (async (input: JsonObject) => {
      attempts += 1;
      calls.push(`gateResolve:${JSON.stringify(input)}`);
      if (attempts === 1) {
        throw new OrcaCommandError(
          { code: "consumer_fenced", message: "This coordinator terminal is bound to run_other, not run_x." },
          { ok: false, args: ["orchestration", "gate-resolve"], exitCode: 1, stdout: "", stderr: "" },
        );
      }
      return { ok: true, result: { gate: { id: input["id"], status: "resolved", resolution: input["resolution"] } } };
    }) as unknown as typeof client.gateResolve;

    const result = await resolveGate(client, { gateId: "gate_333059a5ece6", resolution: "approve", run: "run_x" });
    expect(result["resolved"]).toBe(true);
    expect(calls.filter((call) => call.startsWith("gateResolve:")).length).toBe(2);
    expect(calls.some((call) => call === "runUse:run_x")).toBe(true);
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

  it("outcome を client.send まで届ける(schema を通っても CLI に届かないバグの回帰防止)", async () => {
    const { client, calls } = createFakeClient();
    const result = await sendMessage(client, {
      subject: "done",
      type: "worker_done",
      outcome: "succeeded",
      taskId: "task_3208dcf22c18",
      dispatchId: "ctx_1",
      run: "run_a781f51d4c91",
    });
    const sendCall = calls.find((call) => call.startsWith("send:"));
    expect(sendCall).toBeDefined();
    expect(sendCall).toContain('"outcome":"succeeded"');
    expect(result["outcome"]).toBe("succeeded");
  });

  it("worker_done に dispatchId が無いのは JobError(dispatch_id_required / CLI 要求を先に伝える)", async () => {
    const { client, calls } = createFakeClient();
    const error = await sendMessage(client, {
      subject: "done",
      type: "worker_done",
      outcome: "succeeded",
      taskId: "task_3208dcf22c18",
    }).catch((e) => e);
    expect(error).toBeInstanceOf(JobError);
    expect((error as JobError).code).toBe("dispatch_id_required");
    expect(calls.some((call) => call.startsWith("send:"))).toBe(false);
  });

  it("worker_done 以外に outcome を付けるのは JobError(outcome_not_allowed)", async () => {
    const { client, calls } = createFakeClient();
    const error = await sendMessage(client, {
      subject: "status",
      type: "status",
      outcome: "succeeded",
    }).catch((e) => e);
    expect(error).toBeInstanceOf(JobError);
    expect((error as JobError).code).toBe("outcome_not_allowed");
    expect(calls.some((call) => call.startsWith("send:"))).toBe(false);
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

  it("Commander(root)の worker-stop 失敗は cancel 成功にしない(cancel_incomplete / task 未更新)", async () => {
    const client = {
      taskList: async () => runningTaskList,
      dispatchShow: async () => ({ ok: true, result: { dispatch: { id: "ctx_42e6925ec35f" } } }),
      workerStop: async () => {
        throw new Error("release_unknown");
      },
      taskUpdate: async () => ({ ok: true, result: {} }),
    } as unknown as OrcaClient;

    const error = await cancelTask(client, { taskId: "task_3208dcf22c18" }).catch((e) => e);
    expect(error).toBeInstanceOf(JobError);
    expect((error as JobError).code).toBe("cancel_incomplete");
    const detail = (error as JobError).detail as JsonObject;
    expect(detail["state"]).toBe("partial");
    expect(detail["cancelled"]).toBe(false);
    expect(detail["fullyStopped"]).toBe(false);
    expect(detail["failedDispatches"]).toEqual(["ctx_42e6925ec35f"]);
    // 実プロセスが止まった保証が無いまま task だけ failed にしていない
    expect(detail["cancelledTasks"]).toEqual([]);
  });

  it("子タスクの worker-stop 失敗は warnings に記録し、cancel は進める(fullyStopped: false)", async () => {
    const family = {
      ok: true,
      result: {
        tasks: [
          { id: "task_cmd", run_id: "run_x", parent_id: null, status: "dispatched", dispatch_id: "disp_cmd" },
          { id: "task_be", run_id: "run_x", parent_id: "task_cmd", status: "dispatched", dispatch_id: "disp_be" },
        ],
      },
    };
    const { client, calls } = createFakeClient({ taskList: family });
    client.workerStop = (async (dispatch: string) => {
      calls.push(`workerStop:${dispatch}`);
      if (dispatch === "disp_be") {
        throw new Error("release_unknown");
      }
      return { ok: true, result: { state: "stopped" } };
    }) as unknown as typeof client.workerStop;

    const result = await cancelTask(client, { taskId: "task_cmd", reason: "方針変更" });
    expect(result["cancelled"]).toBe(true);
    expect(result["fullyStopped"]).toBe(false);
    expect((result["warnings"] as string[]).join("|")).toContain("disp_be");
    // 子も Commander も task 側は cancelled に確定している
    expect((result["tasks"] as JsonObject[]).map((row) => row["state"])).toEqual(["cancelled", "cancelled"]);
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

describe("collectDescendants(子孫を子から順)", () => {
  const payload = {
    ok: true,
    result: {
      tasks: [
        { id: "root", parent_id: null },
        { id: "a", parent_id: "root" },
        { id: "a1", parent_id: "a" },
        { id: "b", parent_id: "root" },
        { id: "unrelated", parent_id: "other" },
      ],
    },
  };

  it("post-order(子を先に、親を後に)で返し、無関係なタスクは含まない", () => {
    expect(collectDescendants(payload, "root").map((task) => task["id"])).toEqual(["a1", "a", "b", "root"]);
    expect(collectDescendants(payload, "b").map((task) => task["id"])).toEqual(["b"]);
    expect(collectDescendants(payload, "missing")).toEqual([]);
  });

  it("parent の循環に陥っても停止する", () => {
    const cyclic = {
      ok: true,
      result: {
        tasks: [
          { id: "x", parent_id: "y" },
          { id: "y", parent_id: "x" },
        ],
      },
    };
    expect(collectDescendants(cyclic, "x").map((task) => task["id"])).toEqual(["y", "x"]);
  });
});

describe("cancelTask(cascade / 子孫への子から順)", () => {
  const familyTaskList = {
    ok: true,
    result: {
      tasks: [
        { id: "task_cmd", run_id: "run_x", parent_id: null, status: "dispatched", dispatch_id: "disp_cmd" },
        { id: "task_be", run_id: "run_x", parent_id: "task_cmd", status: "dispatched", dispatch_id: "disp_be" },
        { id: "task_deep", run_id: "run_x", parent_id: "task_be", status: "dispatched", dispatch_id: "disp_deep" },
        { id: "task_ts", run_id: "run_x", parent_id: "task_cmd", status: "completed", dispatch_id: "disp_ts" },
        { id: "task_other", run_id: "run_x", parent_id: "task_unrelated", status: "dispatched", dispatch_id: "disp_other" },
      ],
    },
  };
  const dispatchesByTask: Record<string, string> = {
    task_cmd: "disp_cmd",
    task_be: "disp_be",
    task_deep: "disp_deep",
    task_ts: "disp_ts",
  };

  function createFamilyClient() {
    const { client, calls } = createFakeClient({ taskList: familyTaskList });
    client.dispatchShow = (async (task: string) => ({
      ok: true,
      result: { dispatch: dispatchesByTask[task] !== undefined ? { id: dispatchesByTask[task] } : null },
    })) as unknown as typeof client.dispatchShow;
    return { client, calls };
  }

  it("Commander だけでなく子孫 worker を子から順に止め、子孫 task を cancelled にする", async () => {
    const { client, calls } = createFamilyClient();
    const result = await cancelTask(client, { taskId: "task_cmd", reason: "方針変更" });

    expect(result).toMatchObject({
      taskId: "task_cmd",
      state: "cancelled",
      cancelled: true,
      cascade: true,
      taskCount: 3,
    });

    const updates = calls.filter((call) => call.startsWith("taskUpdate:"));
    expect(updates.map((call) => call.match(/"id":"([^"]+)"/)?.[1])).toEqual(["task_deep", "task_be", "task_cmd"]);

    const stops = calls.filter((call) => call.startsWith("workerStop:"));
    expect(stops.map((call) => call.slice("workerStop:".length))).toEqual(["disp_deep", "disp_be", "disp_cmd"]);

    // 完了済みの子と無関係なタスクは触らない
    expect(stops).not.toContain("disp_ts");
    expect(updates.join("|")).not.toContain("task_other");

    // 誰を止めたか分かるように worker 行へ taskId を添える
    expect((result["workers"] as JsonObject[]).map((worker) => worker["taskId"])).toEqual([
      "task_deep",
      "task_be",
      "task_cmd",
    ]);
  });

  it("cascade: false は対象タスクだけ止める", async () => {
    const { client, calls } = createFamilyClient();
    const result = await cancelTask(client, { taskId: "task_cmd", cascade: false });
    expect(result["cascade"]).toBe(false);
    expect(result["taskCount"]).toBe(1);
    expect(calls.filter((call) => call.startsWith("taskUpdate:")).length).toBe(1);
    expect(calls.filter((call) => call.startsWith("workerStop:")).map((call) => call.slice("workerStop:".length))).toEqual([
      "disp_cmd",
    ]);
  });

  it("子タスクの確定失敗は warnings に留め、Commander の確定は進める", async () => {
    const { client, calls } = createFamilyClient();
    client.taskUpdate = (async (input: JsonObject) => {
      calls.push(`taskUpdate:${JSON.stringify(input)}`);
      if (input["id"] === "task_be") {
        throw new Error("task_not_found");
      }
      return { ok: true, result: {} };
    }) as unknown as typeof client.taskUpdate;

    const result = await cancelTask(client, { taskId: "task_cmd" });
    expect(result["cancelled"]).toBe(true);
    expect((result["warnings"] as string[]).join("|")).toContain("task_be");
    expect((result["tasks"] as JsonObject[]).map((row) => row["state"])).toEqual([
      "cancelled",
      "incomplete",
      "cancelled",
    ]);
  });

  it("1 タスクに dispatch が 4 件あれば**mutation 前に**拒否し、子も止めていない(silent slice 廃止)", async () => {
    const family = {
      ok: true,
      result: {
        tasks: [
          { id: "task_cmd", run_id: "run_x", parent_id: null, status: "dispatched" },
          { id: "task_be", run_id: "run_x", parent_id: "task_cmd", status: "dispatched" },
        ],
      },
    };
    const dispatchesByTask: Record<string, string[]> = {
      task_be: ["disp_be"],
      task_cmd: ["disp_1", "disp_2", "disp_3", "disp_4"],
    };
    const { client, calls } = createFakeClient({ taskList: family });
    client.dispatchShow = (async (task: string) => ({
      ok: true,
      result: { dispatches: (dispatchesByTask[task] ?? []).map((id) => ({ id })) },
    })) as unknown as typeof client.dispatchShow;

    const error = await cancelTask(client, { taskId: "task_cmd" }).catch((e) => e);
    expect(error).toBeInstanceOf(JobError);
    expect((error as JobError).code).toBe("cancel_dispatch_scope_too_large");
    expect((error as JobError).detail).toMatchObject({
      taskId: "task_cmd",
      dispatchCount: 4,
      maxDispatchesPerTask: 3,
    });

    // 部分 cancel をしない: 子を止めた後に見つけても遅い = preflight で全 target を点検する
    expect(calls.some((call) => call.startsWith("workerStop:"))).toBe(false);
    expect(calls.some((call) => call.startsWith("taskUpdate:"))).toBe(false);
  });

  it("子孫が上限を超えたら**何も変更する前に** JobError(cancel_scope_too_large)", async () => {
    const many = {
      ok: true,
      result: {
        tasks: [
          { id: "root", parent_id: null, status: "dispatched" },
          ...Array.from({ length: 20 }, (_, index) => ({
            id: `child_${index}`,
            parent_id: "root",
            status: "dispatched" as const,
          })),
        ],
      },
    };
    const { client, calls } = createFakeClient({ taskList: many });
    const error = await cancelTask(client, { taskId: "root" }).catch((e) => e);

    expect(error).toBeInstanceOf(JobError);
    expect((error as JobError).code).toBe("cancel_scope_too_large");
    expect((error as JobError).detail).toMatchObject({ taskCount: 21, maxCascadeTasks: 12 });

    // 部分 cancel をしない: fence も task-update も 0 件(root 含む全員が生きたまま)
    expect(calls.some((call) => call.startsWith("workerStop:"))).toBe(false);
    expect(calls.some((call) => call.startsWith("taskUpdate:"))).toBe(false);

    // 逃げ道: cascade: false なら対象だけ止められる
    const partial = await cancelTask(client, { taskId: "root", cascade: false });
    expect(partial["cancelled"]).toBe(true);
    expect(partial["taskCount"]).toBe(1);
  });

  it("上限ちょうど(12 件)は通り、post-order の末尾として root も必ず止まる", async () => {
    const exactly = {
      ok: true,
      result: {
        tasks: [
          { id: "root", parent_id: null, status: "dispatched" },
          ...Array.from({ length: 11 }, (_, index) => ({
            id: `child_${index}`,
            parent_id: "root",
            status: "dispatched" as const,
          })),
        ],
      },
    };
    const { client, calls } = createFakeClient({ taskList: exactly });
    const result = await cancelTask(client, { taskId: "root" });

    expect(result["taskCount"]).toBe(12);
    const updates = calls.filter((call) => call.startsWith("taskUpdate:"));
    expect(updates.length).toBe(12);
    // 最後(root)がキャンセル対象に入っていること = cancelled: true が正直
    expect(updates[updates.length - 1]).toContain('"id":"root"');
  });
});

describe("runMutation(直列化)", () => {
  it("変更系を直列化し、run-use とその再試行の間に他リクエストを挟まない", async () => {
    const calls: string[] = [];
    const makeClient = (runId: string) => {
      let attempts = 0;
      const push = (line: string) => calls.push(`${runId}|${line}`);
      return {
        taskList: async () => ({
          ok: true,
          result: { tasks: [{ id: `task_${runId}`, run_id: runId, status: "dispatched" }] },
        }),
        dispatchShow: async () => ({ ok: true, result: { dispatch: null } }),
        taskUpdate: async (input: JsonObject) => {
          attempts += 1;
          push(`taskUpdate:${JSON.stringify(input)}`);
          if (attempts === 1) {
            throw new OrcaCommandError(
              { code: "consumer_fenced", message: `This coordinator terminal is bound to run_other, not ${runId}.` },
              { ok: false, args: ["orchestration", "task-update"], exitCode: 1, stdout: "", stderr: "" },
            );
          }
          return { ok: true, result: {} };
        },
        runUse: async (id: string) => {
          push(`runUse:${id}`);
          return { ok: true, result: {} };
        },
      } as unknown as OrcaClient;
    };

    await Promise.all([
      cancelTask(makeClient("run_a"), { taskId: "task_run_a" }),
      cancelTask(makeClient("run_b"), { taskId: "task_run_b" }),
    ]);

    const runUses = calls.filter((call) => call.includes("runUse:"));
    const updates = calls.filter((call) => call.includes("taskUpdate:"));
    expect(runUses.length).toBe(2);
    expect(updates.length).toBe(4);

    // run-use の直後は必ず同じリクエストの再試行(binding が他リクエストに書き換わらない)
    for (let index = 0; index < calls.length; index += 1) {
      const call = calls[index] ?? "";
      if (!call.includes("runUse:")) {
        continue;
      }
      const owner = call.split("|")[0];
      expect(calls[index + 1] ?? "").toMatch(new RegExp(`^${owner}\\|taskUpdate:`));
    }
  });
});

describe("getTaskResult(result) — 子タスクの集約", () => {
  const family = {
    ok: true,
    result: {
      tasks: [
        { id: "task_cmd", run_id: "run_x", parent_id: null, status: "completed", result: "commander summary", dispatch_id: "disp_cmd" },
        { id: "task_be", run_id: "run_x", parent_id: "task_cmd", status: "completed", result: "backend done", dispatch_id: "disp_be" },
        { id: "task_ts", run_id: "run_x", parent_id: "task_cmd", status: "completed", result: "tests green", dispatch_id: "disp_ts" },
      ],
    },
  };
  const outputsByDispatch: Record<string, string> = {
    disp_cmd: "commander output",
    disp_be: "backend output",
    disp_ts: "tests output",
  };

  function createFamilyClient() {
    const { client, calls } = createFakeClient({
      taskList: family,
      workerRead: { ok: true, result: { text: "unused", source: "transcript" } },
    });
    client.workerRead = (async (input: JsonObject) => {
      const dispatch = String(input["dispatch"]);
      calls.push(`workerRead:${dispatch}`);
      return { ok: true, result: { text: outputsByDispatch[dispatch] ?? "none", source: "transcript" } };
    }) as unknown as typeof client.workerRead;
    return { client, calls };
  }

  it("既定は Commander だけ(children は空)", async () => {
    const { client } = createFamilyClient();
    const result = await getTaskResult(client, { taskId: "task_cmd" });
    expect(result["includeChildren"]).toBe(false);
    expect(result["children"]).toEqual([]);
    expect((result["outputs"] as JsonObject[]).map((row) => row["dispatchId"])).toEqual(["disp_cmd"]);
  });

  it("includeChildren: true は子タスクの result と出力を集約する(行の dispatch_id を使い dispatch-show を足しにいかない)", async () => {
    const { client, calls } = createFamilyClient();
    const result = await getTaskResult(client, { taskId: "task_cmd", includeChildren: true });

    const children = result["children"] as JsonObject[];
    expect(children.map((child) => child["taskId"])).toEqual(["task_be", "task_ts"]);
    expect(children[0]).toMatchObject({
      taskId: "task_be",
      state: "completed",
      result: "backend done",
      resultPreview: "backend done",
    });
    expect((children[0]?.["outputs"] as JsonObject[])[0]).toMatchObject({
      dispatchId: "disp_be",
      text: "backend output",
    });
    // 子行に dispatch_id があるので dispatchShow は Commander 1 回だけ
    expect(calls.filter((call) => call.startsWith("dispatchShow:")).length).toBe(1);
    expect(result["childrenTruncated"]).toBe(false);
  });

  it("子が多すぎたら childrenTruncated で伝える", async () => {
    const many = {
      ok: true,
      result: {
        tasks: [
          { id: "root", parent_id: null, status: "completed", dispatch_id: "disp_root" },
          ...Array.from({ length: 15 }, (_, index) => ({
            id: `child_${index}`,
            parent_id: "root",
            status: "completed" as const,
            dispatch_id: `disp_${index}`,
          })),
        ],
      },
    };
    const { client } = createFakeClient({ taskList: many });
    const result = await getTaskResult(client, { taskId: "root", includeChildren: true });
    expect((result["children"] as JsonObject[]).length).toBe(10);
    expect(result["childrenTruncated"]).toBe(true);
  });
});

describe("getTaskStatus(poll) — children の打ち切り表示", () => {
  it("childCount は実件数、returnedChildCount と childrenTruncated で打ち切りを伝える", async () => {
    const { client } = createFakeClient({
      taskList: {
        ok: true,
        result: {
          tasks: [
            { id: "task_cmd", status: "dispatched" },
            ...Array.from({ length: 25 }, (_, index) => ({
              id: `child_${index}`,
              parent_id: "task_cmd",
              status: "ready" as const,
            })),
          ],
        },
      },
    });
    const view = await getTaskStatus(client, { taskId: "task_cmd" });
    expect(view["childCount"]).toBe(25);
    expect(view["returnedChildCount"]).toBe(20);
    expect(view["childrenTruncated"]).toBe(true);
    expect((view["children"] as JsonObject[]).length).toBe(20);
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
