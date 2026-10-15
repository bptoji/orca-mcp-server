import { describe, expect, it } from "vitest";
import type { JsonObject, OrcaClient } from "../src/orca/client.js";
import {
  buildTerminalIdentities,
  buildWorktreeName,
  cancelTask,
  classifySubRunOwnership,
  collectDescendants,
  commanderSpec,
  estimatePhase,
  extractApprovalPrompt,
  extractRuns,
  matchSubRuns,
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
  parseParentMarker,
  resolveGate,
  selectSubRunRoots,
  sendMessage,
  SUB_RUN_MARKER_PREFIX,
  toChildRow,
  toRunRow,
  toWorkerRow,
  MAX_SUB_RUNS,
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

  it("seed(taskId)を渡すと決定的で、同じ goal の再委譲でも衝突しない", () => {
    expect(buildWorktreeName(undefined, "日本語の仕様だけ", "task_abc123")).toBe("task-c123");
    expect(buildWorktreeName(undefined, "日本語の仕様だけ", "task_ff00aa")).toBe("task-00aa");
  });

  it("seed が短い場合は hash で埋めて接尾を 4 文字に保つ", () => {
    expect(buildWorktreeName(undefined, "日本語の仕様だけ", "t7")).toMatch(/^task-[0-9a-z]{4}$/);
    expect(buildWorktreeName(undefined, "日本語の仕様だけ", "___")).toMatch(/^task-[0-9a-z]{4}$/);
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
  runList?: JsonObject;
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
    runList: async (input: JsonObject) => {
      calls.push(`runList:${JSON.stringify(input)}`);
      return options.runList ?? { ok: true, result: { runs: [] } };
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
    // Run 所有権(review9 §3 の文言): 既存 Run を使い、深さ/ circuit-break / 失敗 dispatch /
    // binding 無しの回避として run-create を作らせない
    expect(taskCreate).toContain("Run ownership and sub-run policy:");
    expect(taskCreate).toContain("Reuse that Run for ordinary child tasks");
    expect(taskCreate).toContain("Do not create a new Run merely because the current terminal has no bound Run");
    expect(taskCreate).toContain("Never create a Run to bypass a nested worker depth limit");
    expect(taskCreate).toContain("does not reset depth");
    // legacy takeover は別操作 = 新しい Run を作る許可ではない
    expect(taskCreate).toContain("run-use --takeover-legacy");
    expect(taskCreate).toContain("it is not permission to");
    // 自律 coordinator は guide が許すときだけ child Run を作り、マーカーと報告で関連付ける
    expect(taskCreate).toContain("A worker acting as an autonomous coordinator may create and manage a child Run");
    expect(taskCreate).toContain(`${SUB_RUN_MARKER_PREFIX} run=run_test task=<your task id>`);
    expect(taskCreate).toContain("Report the child Run id and its relationship to this job");
    // gate 作成に失敗したら承認を進めない(人間への介入要求までが手順)
    expect(taskCreate).toContain("If gate-create fails: check the Run binding");
    expect(taskCreate).toContain("Never proceed as if approval had");
  });

  it("spec に runId が注入され、プレースホルダが 1 つも残らない", async () => {
    const { client, calls } = createFakeClient();
    await delegateTask(client, { spec: "README を更新して" });

    const taskCreate = calls[1] ?? "";
    // {{runId}} は複数箇所に出る(global 置換で全部埋める)
    expect(taskCreate).toContain("exactly ONE Run: run_test");
    expect(taskCreate).toContain("task-list --run run_test --json");
    expect(taskCreate).toContain("task-create --run run_test --parent");
    expect(taskCreate).toContain("worker-start --run run_test --task");
    expect(taskCreate).toContain("run-use --id run_test --json");
    expect(taskCreate).not.toContain("{{");
    // taskId は task-create の後にしか決まらず task-update に --spec が無い(実機 help 実測)
    // ので注入しない → 注入漏れを warnings で黙らない
    expect(taskCreate).not.toContain("{{taskId}}");
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

  it("title が無くても --name を渡す(実測: New worktrees require --name.)", async () => {
    // 新規 worktree は --name が必須。title を貰えない委譲でも worktree を作れるようにする。
    const { client, calls } = createFakeClient();
    await delegateTask(client, { spec: "日本語のゴールだけ" });
    const workerStart = calls[2] ?? "";
    expect(workerStart).toContain('"worktree":"new-child"');
    expect(workerStart).toContain('"name":"task-c123"');
  });

  it("title が無いときは spec の ASCII 部分から worktree 名を作る", async () => {
    const { client, calls } = createFakeClient();
    await delegateTask(client, { spec: "Update README only" });
    expect(calls[2]).toContain('"name":"Update-README-only-c123"');
  });

  it("title を渡したときはその title を worktree 名に使う(既存挙動を変えない)", async () => {
    const { client, calls } = createFakeClient();
    await delegateTask(client, { spec: "README を更新する", title: "認証機能の追加" });
    expect(calls[2]).toContain('"name":"認証機能の追加"');
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
      { id: "g1", runId: null, taskId: null, status: "pending", question: null, options: null },
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
        runId: "run_x",
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
        detail: { gateId: "gate_1", runId: "run_x", options: '["approve","reject"]' },
      },
    ]);
    expect(view["nextAction"]).toContain("orca_resolve_gate");
    expect(view["nextAction"]).toContain("gates[].runId");
  });

  it("gate 行に run_id が無い CLI では照合した Run 名義で runId を補う", async () => {
    const { client } = createFakeClient({
      taskList: { ok: true, result: { tasks: [{ id: "task_cmd", status: "blocked", run_id: "run_caller" }] } },
      gateList: {
        ok: true,
        result: { gates: [{ id: "gate_1", task_id: "task_cmd", question: "merge してよい?", status: "pending" }] },
      },
    });
    const view = await getTaskStatus(client, { taskId: "task_cmd" });
    expect((view["gates"] as JsonObject[])[0]).toMatchObject({ id: "gate_1", runId: "run_caller" });
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
    expect(calls.some((call) => call.startsWith("workerRead:") && call.includes('"source":"terminal"'))).toBe(true);
  });
});

describe("extractApprovalPrompt", () => {
  const bar = "─".repeat(40);
  const dashed = "╌".repeat(40);

  it("直前の実線区切りから承認依頼部分だけを切り出し、点線は短くする", () => {
    const text = [
      "  Completion boundary:",
      "● Loading orchestration guide",
      bar,
      " PowerShell command",
      dashed,
      " orca skills get orchestration --full",
      dashed,
      " This command requires approval",
      " Do you want to proceed?",
      " ❯ 1. Yes",
      "   3. No",
    ].join("\n");
    const prompt = extractApprovalPrompt(text) ?? "";
    expect(prompt.startsWith("PowerShell command")).toBe(true);
    expect(prompt).toContain("Do you want to proceed?");
    expect(prompt).toContain("╌╌╌\n");
    expect(prompt).not.toContain("Completion boundary");
  });

  it("実線が無ければ手前 8 行まで、プロンプトが無ければ null", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line${i}`);
    const prompt = extractApprovalPrompt([...lines, "Do you want to proceed?"].join("\n")) ?? "";
    expect(prompt.split("\n")).toHaveLength(9);
    expect(extractApprovalPrompt("普通の出力")).toBeNull();
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

  it("gate の所属 Run と違う run を渡すと gate_run_mismatch で**変更前に**拒否する", async () => {
    // 実測の事故型: gate は sub-run(run_sub)に存在するのに、呼び出し元 Run を名指しして解決しようとする。
    // gate-resolve に --run が無いので、このまま叩くと runMutation が sub-run へ binding を切り替え、
    // 「指定 Run のゲート」という前提で別 Run のゲートを解決してしまう。
    const { client, calls } = createFakeClient({
      gateList: {
        ok: true,
        result: {
          gates: [
            {
              id: "gate_333059a5ece6",
              run_id: "run_sub",
              task_id: "task_sub_root",
              question: "merge してよい?",
              status: "pending",
            },
          ],
        },
      },
    });
    const error = await resolveGate(client, {
      gateId: "gate_333059a5ece6",
      resolution: "approve",
      run: "run_caller",
    }).catch((e) => e);
    expect(error).toBeInstanceOf(JobError);
    expect((error as JobError).code).toBe("gate_run_mismatch");
    expect((error as JobError).detail).toMatchObject({
      requestedRun: "run_caller",
      gateRunId: "run_sub",
      taskId: "task_sub_root",
    });
    // 変更系(gate-resolve / run-use)を 1 回も叩いていない = 何も変更していない
    expect(calls.some((call) => call.startsWith("gateResolve:"))).toBe(false);
    expect(calls.some((call) => call.startsWith("runUse:"))).toBe(false);
  });

  it("gate 行の run_id と同じ run なら解決できる(sub-run のゲートを正しい Run で解決)", async () => {
    const { client, calls } = createFakeClient({
      gateList: {
        ok: true,
        result: {
          gates: [{ id: "gate_sub", run_id: "run_sub", task_id: "task_sub_root", question: "q", status: "pending" }],
        },
      },
    });
    const result = await resolveGate(client, { gateId: "gate_sub", resolution: "approve", run: "run_sub" });
    expect(result).toMatchObject({ gateId: "gate_sub", resolved: true, runId: "run_sub", taskId: "task_sub_root" });
    expect(calls[0]).toContain('"run":"run_sub"');
  });

  it("taskId を渡すと自分の job のゲートか点検し、無関係なら gate_task_mismatch で変更前に拒否する", async () => {
    // 認可の境界(review10 §3): gate-resolve は「Run ID と Gate ID を知る誰でも」解決できる CLI 構造。
    // 呼び出し側が「自分の job のゲート」と宣言したなら、その job に属さないゲートを叩かない。
    const { client, calls } = createFakeClient({
      gateList: {
        ok: true,
        result: {
          gates: [{ id: "gate_other", run_id: "run_sub", task_id: "task_of_other_job", question: "q", status: "pending" }],
        },
      },
      taskList: {
        ok: true,
        result: { tasks: [{ id: "task_cmd", run_id: "run_sub", parent_id: null, status: "dispatched" }] },
      },
    });
    const error = await resolveGate(client, {
      gateId: "gate_other",
      resolution: "approve",
      run: "run_sub",
      taskId: "task_cmd",
    }).catch((e) => e);
    expect(error).toBeInstanceOf(JobError);
    expect((error as JobError).code).toBe("gate_task_mismatch");
    expect((error as JobError).detail).toMatchObject({
      gateId: "gate_other",
      gateTaskId: "task_of_other_job",
      requestedTaskId: "task_cmd",
    });
    expect(calls.some((call) => call.startsWith("gateResolve:"))).toBe(false);
    expect(calls.some((call) => call.startsWith("runUse:"))).toBe(false);
  });

  it("taskId 自身とその部分木(task-create で分解した子)のゲートは解決できる", async () => {
    const family = {
      ok: true,
      result: {
        tasks: [
          { id: "task_cmd", run_id: "run_sub", parent_id: null, status: "dispatched" },
          { id: "task_child", run_id: "run_sub", parent_id: "task_cmd", status: "blocked" },
        ],
      },
    };
    const gateList = {
      ok: true,
      result: { gates: [{ id: "gate_child", run_id: "run_sub", task_id: "task_child", question: "q", status: "pending" }] },
    };

    const child = createFakeClient({ gateList, taskList: family });
    const result = await resolveGate(child.client, {
      gateId: "gate_child",
      resolution: "approve",
      run: "run_sub",
      taskId: "task_cmd",
    });
    expect(result).toMatchObject({ gateId: "gate_child", resolved: true, taskId: "task_child" });

    // 自分自身の task のゲートは task-list を読み足しせずに解決できる
    const own = createFakeClient({
      gateList: {
        ok: true,
        result: { gates: [{ id: "gate_own", run_id: "run_sub", task_id: "task_cmd", question: "q", status: "pending" }] },
      },
      taskList: family,
    });
    const ownResult = await resolveGate(own.client, {
      gateId: "gate_own",
      resolution: "approve",
      run: "run_sub",
      taskId: "task_cmd",
    });
    expect(ownResult).toMatchObject({ gateId: "gate_own", resolved: true });
    expect(own.calls.some((call) => call.startsWith("taskList:"))).toBe(false);
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
      // cancel の探索前提(worker-list / run-list)は揃えた上で fence 失敗を再現する
      workerList: async () => ({
        ok: true,
        result: {
          workers: [
            {
              dispatchId: "ctx_42e6925ec35f",
              taskId: "task_3208dcf22c18",
              workerState: "in_progress",
              agentTerminalHandle: "term_cmd",
            },
          ],
        },
      }),
      runList: async () => ({ ok: true, result: { runs: [] } }),
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

  it("worker-stop が stop_unknown を返したら停止成功に数えない(cancel_incomplete / fullyStopped: false)", async () => {
    // 実測 2026-10-14: worker-stop は stop_unknown / processAction: none を返し得る。
    // dispatch は active のままなので task-update は task_not_startable で落ち、
    // 「fence 成功 + fullyStopped: true」は誤報になる。
    const client = {
      taskList: async () => runningTaskList,
      dispatchShow: async () => ({ ok: true, result: { dispatch: { id: "ctx_42e6925ec35f" } } }),
      workerList: async () => ({
        ok: true,
        result: {
          workers: [
            {
              dispatchId: "ctx_42e6925ec35f",
              taskId: "task_3208dcf22c18",
              workerState: "in_progress",
              agentTerminalHandle: "term_cmd",
            },
          ],
        },
      }),
      runList: async () => ({ ok: true, result: { runs: [] } }),
      workerStop: async () => ({ ok: true, result: { state: "stop_unknown", processAction: "none" } }),
      taskUpdate: async () => ({ ok: true, result: {} }),
    } as unknown as OrcaClient;

    const error = await cancelTask(client, { taskId: "task_3208dcf22c18" }).catch((e) => e);
    expect(error).toBeInstanceOf(JobError);
    expect((error as JobError).code).toBe("cancel_incomplete");
    const detail = (error as JobError).detail as JsonObject;
    expect(detail["fullyStopped"]).toBe(false);
    expect(detail["failedDispatches"]).toEqual(["ctx_42e6925ec35f"]);
    expect(detail["cancelledTasks"]).toEqual([]);
    // 停止を確定できないことを warning に出す
    expect(JSON.stringify(detail)).toContain("ctx_42e6925ec35f");
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
      taskList: { ok: true, result: { tasks: [{ id: "task_695cee4c872d", status: "dispatched", run_id: "run_x" }] } },
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
      workerList: async () => ({
        ok: true,
        result: {
          workers: [
            { dispatchId: "ctx_1", taskId: "task_3208dcf22c18", workerState: "in_progress", agentTerminalHandle: "term_cmd" },
          ],
        },
      }),
      runList: async () => ({ ok: true, result: { runs: [] } }),
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
          { id: "root", parent_id: null, status: "dispatched", run_id: "run_x" },
          ...Array.from({ length: 20 }, (_, index) => ({
            id: `child_${index}`,
            parent_id: "root",
            status: "dispatched" as const,
            run_id: "run_x",
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
          { id: "root", parent_id: null, status: "dispatched", run_id: "run_x" },
          ...Array.from({ length: 11 }, (_, index) => ({
            id: `child_${index}`,
            parent_id: "root",
            status: "dispatched" as const,
            run_id: "run_x",
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
        workerList: async () => ({ ok: true, result: { workers: [] } }),
        runList: async () => ({ ok: true, result: { runs: [] } }),
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

  it("バインドが空のターミナル(run_required)でも run-use でバインドして 1 回再試行する", async () => {
    const calls: string[] = [];
    let attempts = 0;
    const client = {
      gateList: async () => ({
        ok: true,
        result: { gates: [{ id: "gate_1", run_id: "run_gate", task_id: "task_child", status: "pending" }] },
      }),
      gateResolve: async (input: JsonObject) => {
        attempts += 1;
        calls.push(`gateResolve:${JSON.stringify(input)}`);
        if (attempts === 1) {
          throw new OrcaCommandError(
            { code: "run_required", message: "No Run is bound. Use orchestration run-create or run-use first." },
            { ok: false, args: ["orchestration", "gate-resolve"], exitCode: 1, stdout: "", stderr: "" },
          );
        }
        return { ok: true, result: {} };
      },
      runUse: async (id: string) => {
        calls.push(`runUse:${id}`);
        return { ok: true, result: {} };
      },
    } as unknown as OrcaClient;

    const result = await resolveGate(client, { gateId: "gate_1", resolution: "approve", run: "run_gate" });
    expect(result["resolved"]).toBe(true);
    expect(calls).toEqual([
      'gateResolve:{"id":"gate_1","resolution":"approve"}',
      "runUse:run_gate",
      'gateResolve:{"id":"gate_1","resolution":"approve"}',
    ]);
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

describe("commanderSpec — runId 注入とプレースホルダ漏れ", () => {
  it("{{runId}} の全箇所を埋め、leaked を返さない(実測で sub-run 逸脱の温床になった文言)", () => {
    const { spec, leaked } = commanderSpec({ spec: "goal text", repo: "id:repo1" }, "run_abc");
    expect(leaked).toEqual([]);
    expect(spec).not.toContain("{{");
    expect((spec.match(/run_abc/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(spec).toContain("goal text");
    expect(spec).toContain("id:repo1");
  });

  it("既定の repo / constraints 文言が入る", () => {
    const { spec } = commanderSpec({ spec: "goal" }, "run_abc");
    expect(spec).toContain("the current repository");
    expect(spec).toContain("- Preserve existing APIs and project conventions.");
  });

  it("制約の箇条書きが Constraints 欄に入る", () => {
    const { spec } = commanderSpec({ spec: "goal", constraints: ["マージしない"] }, "run_abc");
    expect(spec).toContain("- マージしない");
  });
});

describe("matchSubRuns — coordinator_handle 照合", () => {
  const runs: JsonObject[] = [
    { id: "run_sub", objective: "sub", coordinator_handle: "term_cmd", created_at: "2026-10-13T06:53:49Z" },
    { id: "run_caller", objective: "caller", coordinator_handle: "term_cmd", created_at: "2026-10-13T06:50:52Z" },
    { id: "run_orphan", objective: "orphan", coordinator_handle: null, created_at: "2026-10-13T06:54:00Z" },
    { id: "run_other", objective: "other", coordinator_handle: "term_someone_else", created_at: "2026-10-13T06:54:00Z" },
    { id: "run_ancient", objective: "ancient", coordinator_handle: "term_cmd", created_at: "2026-01-01T00:00:00Z" },
  ];

  it("handle 一致の sub-run だけ拾い、呼び出し元 Run 自身 / handle 無し / 他人の Run を除外する", () => {
    const matched = matchSubRuns(runs, {
      callerRunId: "run_caller",
      handles: ["term_cmd"],
      taskCreatedAt: "2026-10-13 06:50:52",
    });
    expect(matched.map((run) => run["runId"])).toEqual(["run_sub"]);
    expect(matched[0]).toMatchObject({ objective: "sub", coordinatorHandle: "term_cmd" });
  });

  it("handle が無いと 1 件も拾わない(照合キーが無い)", () => {
    expect(matchSubRuns(runs, { callerRunId: null, handles: [] })).toEqual([]);
  });

  it("対象タスクより 24 分以上前に作られた Run は除外する(terminal 再利用の誤マッチ対策)", () => {
    const matched = matchSubRuns(runs, {
      callerRunId: "run_caller",
      handles: ["term_cmd", "term_none"],
      taskCreatedAt: "2026-10-13 06:50:52",
    });
    expect(matched.map((run) => run["runId"])).not.toContain("run_ancient");
  });

  it("照合できる Run は MAX_SUB_RUNS 件で打ち切る", () => {
    const many = Array.from({ length: 8 }, (_, index) => ({
      id: `run_sub_${index}`,
      coordinator_handle: "term_cmd",
      created_at: "2026-10-13T06:53:49Z",
    }));
    expect(matchSubRuns(many, { callerRunId: null, handles: ["term_cmd"] })).toHaveLength(MAX_SUB_RUNS);
  });
});

describe("selectSubRunRoots — sub-run 内の root 特定", () => {
  // 実測: Commander は sub-run 内で新しい root を作り、子 6 件はその root を指す
  // (呼び出し元 Run の Commander task を指す parent_id は使われない)
  const tasks: JsonObject[] = [
    { id: "task_root", parent_id: null, created_by_terminal_handle: "term_cmd" },
    { id: "task_child", parent_id: "task_root", created_by_terminal_handle: "term_cmd" },
    { id: "task_orphan", parent_id: "task_gone", created_by_terminal_handle: "term_cmd" },
    { id: "task_foreign", parent_id: null, created_by_terminal_handle: "term_other" },
  ];

  it("sub-run 内に親を持たない行 + Commander の handle が作った行だけを root にする", () => {
    expect(selectSubRunRoots(tasks, ["term_cmd"]).map((row) => row["id"])).toEqual(["task_root", "task_orphan"]);
  });

  it("handle が一致しない行は root にしない", () => {
    expect(selectSubRunRoots(tasks, ["term_nobody"])).toEqual([]);
  });
});

describe("extractRuns / toRunRow", () => {
  it("run-list の result.runs[] と run-show の result.run 両方から取り出す", () => {
    expect(
      extractRuns({ ok: true, result: { runs: [{ id: "run_a" }, { id: "run_b" }] } }).map((run) => run["id"]),
    ).toEqual(["run_a", "run_b"]);
    expect(extractRuns({ ok: true, result: { run: { id: "run_one" } } })).toHaveLength(1);
    expect(extractRuns({ ok: true })).toEqual([]);
  });

  it("キー名の揺れを吸収して正規化する", () => {
    expect(
      toRunRow({ runId: "run_a", objective: "goal", coordinatorHandle: "term_x", created_at: "2026-10-13T06:53:49Z" }),
    ).toMatchObject({ runId: "run_a", objective: "goal", coordinatorHandle: "term_x", createdAt: "2026-10-13T06:53:49Z" });
    expect(toRunRow({}).coordinatorHandle).toBeNull();
  });
});

/** sub-run を持つ family の fake client(実測ペイロードの形に寄せる)。 */
function createSubRunClient(options: { runs?: JsonObject[] } = {}) {
  const calls: string[] = [];
  // workerStop を叩いた dispatch は「stopped」に変わる(停止後の読み直しを実データにするため)
  const stoppedDispatches = new Set<string>();
  const callerTasks: JsonObject[] = [
    {
      id: "task_cmd",
      run_id: "run_caller",
      parent_id: null,
      status: "dispatched",
      assignee_handle: "term_cmd",
      created_at: "2026-10-13 06:50:52",
    },
  ];
  const subTasks: JsonObject[] = [
    {
      id: "task_sub_root",
      run_id: "run_sub",
      parent_id: null,
      created_by_terminal_handle: "term_cmd",
      // 実測で一致した来歴(terminal list の tabId:leafId / ptyId:incarnationId)
      created_by_pane_key: "tab_1:leaf_1",
      created_by_process_incarnation: "pty_1:inc_1",
      status: "blocked",
      result: "blocked: 承認ゲート待ち",
      created_at: "2026-10-13 06:55:24",
    },
    {
      id: "task_sub_a",
      run_id: "run_sub",
      parent_id: "task_sub_root",
      created_by_terminal_handle: "term_cmd",
      status: "completed",
      result: "core.md 完成",
    },
    {
      id: "task_sub_b",
      run_id: "run_sub",
      parent_id: "task_sub_root",
      created_by_terminal_handle: "term_cmd",
      status: "dispatched",
    },
  ];
  const dispatchesByTask: Record<string, string> = {
    task_cmd: "disp_cmd",
    task_sub_root: "disp_root",
    task_sub_a: "disp_a",
    task_sub_b: "disp_b",
  };
  const client = {
    taskList: async (input: JsonObject) => {
      const run = input["run"];
      calls.push(`taskList:${run ?? "bind"}`);
      return { ok: true, result: { tasks: run === "run_sub" ? subTasks : callerTasks } };
    },
    runList: async (input: JsonObject) => {
      calls.push(`runList:${JSON.stringify(input)}`);
      // 実測の keyset cursor: 2 ページ目以降は空で終端する
      if (input["cursor"] !== undefined) {
        return { ok: true, result: { runs: [] } };
      }
      return {
        ok: true,
        result: {
          runs: options.runs ?? [
            { id: "run_sub", objective: "sub", coordinator_handle: "term_cmd", created_at: "2026-10-13T06:53:49Z" },
            { id: "run_caller", objective: "caller", coordinator_handle: "term_cmd", created_at: "2026-10-13T06:50:52Z" },
            { id: "run_orphan", objective: "orphan", coordinator_handle: null, created_at: "2026-10-13T06:54:00Z" },
          ],
          nextCursor: "cursor_1",
        },
      };
    },
    dispatchShow: async (task: string) => {
      calls.push(`dispatchShow:${task}`);
      const dispatchId = dispatchesByTask[task];
      return { ok: true, result: { dispatch: dispatchId === undefined ? null : { id: dispatchId } } };
    },
    workerList: async (input: JsonObject) => {
      const run = input["run"];
      calls.push(`workerList:${run ?? "bind"}`);
      const rows =
        run === "run_sub"
          ? [
              { dispatchId: "disp_a", taskId: "task_sub_a", workerState: "succeeded", agentTerminalHandle: "term_wa" },
              { dispatchId: "disp_b", taskId: "task_sub_b", workerState: "in_progress", agentTerminalHandle: "term_wb" },
            ]
          : [{ dispatchId: "disp_cmd", taskId: "task_cmd", workerState: "in_progress", agentTerminalHandle: "term_cmd" }];
      return {
        ok: true,
        result: {
          workers: rows.map((row) => ({
            ...row,
            workerState: stoppedDispatches.has(row.dispatchId) ? "stopped" : row.workerState,
          })),
        },
      };
    },
    gateList: async (input: JsonObject) => {
      const run = input["run"];
      calls.push(`gateList:${run ?? "bind"}`);
      return {
        ok: true,
        result: {
          gates:
            run === "run_sub"
              ? [{ id: "gate_sub", task_id: "task_sub_b", status: "pending", question: "merge してよい?" }]
              : [],
        },
      };
    },
    workerRead: async (input: JsonObject) => {
      const dispatch = String(input["dispatch"]);
      calls.push(`workerRead:${dispatch}`);
      return { ok: true, result: { text: `output of ${dispatch}`, source: "transcript" } };
    },
    workerStop: async (dispatch: string) => {
      calls.push(`workerStop:${dispatch}`);
      stoppedDispatches.add(dispatch);
      return { ok: true, result: { state: "stopped" } };
    },
    taskUpdate: async (input: JsonObject) => {
      calls.push(`taskUpdate:${JSON.stringify(input)}`);
      return { ok: true, result: {} };
    },
    runUse: async (runId: string) => {
      calls.push(`runUse:${runId}`);
      return { ok: true, result: {} };
    },
    terminalList: async () => ({
      ok: true,
      result: {
        terminals: [{ handle: "term_cmd", tabId: "tab_1", leafId: "leaf_1", ptyId: "pty_1", incarnationId: "inc_1" }],
      },
    }),
  };
  return { client: client as unknown as OrcaClient, calls };
}

describe("getTaskStatus(poll) — sub-run の自動集約", () => {
  it("呼び出し元 Run に見えない sub-run の子を children に sourceRunId 付きで合算する", async () => {
    const { client, calls } = createSubRunClient();
    const view = await getTaskStatus(client, { taskId: "task_cmd", run: "run_caller" });

    // 実測の事故: 呼び出し元 Run の poll は childCount: 0 を返していた
    expect(view["childCount"]).toBe(1);
    const children = view["children"] as JsonObject[];
    expect(children[0]).toMatchObject({
      taskId: "task_sub_root",
      state: "blocked",
      sourceRunId: "run_sub",
    });
    expect(view["subRunsDiscovered"]).toBe(1);
    expect((view["subRuns"] as JsonObject[])[0]).toMatchObject({
      runId: "run_sub",
      coordinatorHandle: "term_cmd",
      taskCount: 3,
      rootTaskIds: ["task_sub_root"],
    });
    expect(view["warnings"]).toEqual([]);
    expect(calls).toContain("runList:" + JSON.stringify({ limit: 50 }));
    expect(calls.some((call) => call === "taskList:run_sub")).toBe(true);
  });

  it("sub-run のゲートも gates に出し、phase を decision_gate にする", async () => {
    const { client } = createSubRunClient();
    const view = await getTaskStatus(client, { taskId: "task_cmd", run: "run_caller" });
    const gates = view["gates"] as JsonObject[];
    expect(gates.map((gate) => gate["id"])).toEqual(["gate_sub"]);
    // 実測の欠陥: gate に所属 Run が無いと orca_resolve_gate の run が決まらない。
    // gate 行の run_id が無い CLI 版でも、照合した sub-run 名義で補完する。
    expect(gates[0]).toMatchObject({ id: "gate_sub", runId: "run_sub", taskId: "task_sub_b" });
    expect(view["phase"]).toBe("decision_gate");
    const gateReason = (view["blockedReasons"] as JsonObject[]).find((reason) => reason["kind"] === "gate");
    expect(gateReason).toMatchObject({ taskId: "task_sub_b", role: "child" });
    expect(gateReason?.["detail"]).toMatchObject({ gateId: "gate_sub", runId: "run_sub" });
  });

  it("includeSubRuns: false なら run-list を読まない(呼び出し元 Run だけ)", async () => {
    const { client, calls } = createSubRunClient();
    const view = await getTaskStatus(client, { taskId: "task_cmd", run: "run_caller", includeSubRuns: false });
    expect(calls.some((call) => call.startsWith("runList:"))).toBe(false);
    expect(view["childCount"]).toBe(0);
    expect(view["subRunsDiscovered"]).toBe(0);
  });

  it("run-list が読めなくても poll は壊さず warning だけ添える", async () => {
    const { client } = createSubRunClient();
    client.runList = (async () => {
      throw new Error("runtime_unavailable");
    }) as unknown as typeof client.runList;
    const view = await getTaskStatus(client, { taskId: "task_cmd", run: "run_caller" });
    expect(view["state"]).toBe("running");
    expect((view["warnings"] as string[]).join("|")).toContain("run-list");
  });

  it("worker / dispatch が無い queued では sub-run 探索を走らせない", async () => {
    const { client, calls } = createSubRunClient();
    client.taskList = (async () => ({
      ok: true,
      result: { tasks: [{ id: "task_cmd", run_id: "run_caller", status: "ready" }] },
    })) as unknown as typeof client.taskList;
    client.dispatchShow = (async () => ({ ok: true, result: { dispatch: null } })) as unknown as typeof client.dispatchShow;
    client.workerList = (async () => ({ ok: true, result: { workers: [] } })) as unknown as typeof client.workerList;
    const view = await getTaskStatus(client, { taskId: "task_cmd", run: "run_caller" });
    expect(calls.some((call) => call.startsWith("runList:"))).toBe(false);
    expect(view["subRunsDiscovered"]).toBe(0);
    expect(view["state"]).toBe("queued");
  });
});

describe("cancelTask — sub-run まで止める cascade", () => {
  it("sub-run の部分金を呼び出し元 Run の Commander より先に、子から順に止める", async () => {
    const { client, calls } = createSubRunClient();
    const result = await cancelTask(client, { taskId: "task_cmd", run: "run_caller" });

    expect(result["cancelled"]).toBe(true);
    expect(result["fullyStopped"]).toBe(true);
    expect(result["subRunsDiscovered"]).toBe(1);

    // 終端(completed)の子は触らない = task_sub_a は更新も fence もしない
    const updates = calls.filter((call) => call.startsWith("taskUpdate:"));
    expect(updates.map((call) => (call.match(/"id":"(\w+)"/) ?? [])[1])).toEqual([
      "task_sub_b",
      "task_sub_root",
      "task_cmd",
    ]);
    expect(calls).not.toContain("workerStop:disp_a");
    expect(calls).toContain("workerStop:disp_b");
    expect(calls).toContain("workerStop:disp_root");
    expect(calls).toContain("workerStop:disp_cmd");
    // Commander を止めるのは sub-run の worker より後(子が先)
    expect(calls.indexOf("workerStop:disp_b")).toBeLessThan(calls.indexOf("workerStop:disp_cmd"));
    expect(calls.indexOf("workerStop:disp_root")).toBeLessThan(calls.indexOf("workerStop:disp_cmd"));
    // sub-run のタスクは sub-run 名義で叩いている(task-update の Run スコープ)
    expect(updates[0]).toContain('"run":"run_sub"');
    expect(updates[updates.length - 1]).toContain('"run":"run_caller"');
    expect((result["tasks"] as JsonObject[]).map((row) => row["taskId"])).toEqual([
      "task_sub_b",
      "task_sub_root",
      "task_cmd",
    ]);
  });

  it("includeSubRuns: false は sub-run を対象にしない(後方互換の逃げ道)", async () => {
    const { client, calls } = createSubRunClient();
    const result = await cancelTask(client, { taskId: "task_cmd", run: "run_caller", includeSubRuns: false });
    expect(calls.some((call) => call.startsWith("runList:"))).toBe(false);
    expect(result["subRunsDiscovered"]).toBe(0);
    expect(result["taskCount"]).toBe(1);
  });

  it("sub-run 込みで上限を超えたら何も変更する前に断る", async () => {
    const { client, calls } = createSubRunClient();
    const many = Array.from({ length: 12 }, (_, index) => ({
      id: `task_sub_${index}`,
      run_id: "run_sub",
      parent_id: "task_sub_root",
      created_by_terminal_handle: "term_cmd",
      status: "dispatched" as const,
    }));
    client.taskList = (async (input: JsonObject) => {
      const run = input["run"];
      calls.push(`taskList:${run ?? "bind"}`);
      return {
        ok: true,
        result: {
          tasks:
            run === "run_sub"
              ? [
                  {
                    id: "task_sub_root",
                    run_id: "run_sub",
                    parent_id: null,
                    created_by_terminal_handle: "term_cmd",
                    created_by_pane_key: "tab_1:leaf_1",
                    created_by_process_incarnation: "pty_1:inc_1",
                    status: "dispatched",
                  },
                  ...many,
                ]
              : [{ id: "task_cmd", run_id: "run_caller", parent_id: null, status: "dispatched", assignee_handle: "term_cmd" }],
        },
      };
    }) as unknown as typeof client.taskList;

    const error = await cancelTask(client, { taskId: "task_cmd", run: "run_caller" }).catch((e) => e);
    expect(error).toBeInstanceOf(JobError);
    expect((error as JobError).code).toBe("cancel_scope_too_large");
    expect((error as JobError).detail).toMatchObject({ taskCount: 14, subRunsDiscovered: 1 });
    // 部分 cancel をしない = 変更系コマンドを 1 回も叩いていない
    expect(calls.some((call) => call.startsWith("taskUpdate:"))).toBe(false);
    expect(calls.some((call) => call.startsWith("workerStop:"))).toBe(false);
  });
});

describe("getTaskResult(result) — sub-run の成果集約", () => {
  it("includeChildren: true は sub-run の子タスクも sourceRunId 付きで集約する", async () => {
    const { client } = createSubRunClient();
    const result = await getTaskResult(client, { taskId: "task_cmd", run: "run_caller", includeChildren: true });

    const children = result["children"] as JsonObject[];
    expect(children.map((child) => child["taskId"])).toEqual(["task_sub_root"]);
    expect(children[0]).toMatchObject({ sourceRunId: "run_sub", state: "blocked" });
    expect(result["subRunsDiscovered"]).toBe(1);
  });

  it("既定(includeChildren: false)は sub-run を読まない", async () => {
    const { client, calls } = createSubRunClient();
    const result = await getTaskResult(client, { taskId: "task_cmd", run: "run_caller" });
    expect(result["children"]).toEqual([]);
    expect(calls.some((call) => call.startsWith("runList:"))).toBe(false);
  });
});

describe("parseParentMarker / buildTerminalIdentities — 発見の候補と来歴", () => {
  it("objective のマーカーから親の run / task を取り出す", () => {
    expect(parseParentMarker(`orca-mcp-parent: run=run_caller task=task_cmd\nsub job`)).toEqual({
      runId: "run_caller",
      taskId: "task_cmd",
    });
    expect(parseParentMarker("orca-mcp-parent: run=run_x")).toEqual({ runId: "run_x", taskId: null });
    expect(parseParentMarker("sub job")).toBeNull();
  });

  it("terminal list から handle → pane key / incarnation の対応表を作る", () => {
    const identities = buildTerminalIdentities({
      ok: true,
      result: {
        terminals: [
          { handle: "term_cmd", tabId: "t1", leafId: "l1", ptyId: "p1", incarnationId: "i1" },
          { tabId: "t2" },
        ],
      },
    });
    expect(identities.get("term_cmd")).toMatchObject({ tabId: "t1", leafId: "l1", ptyId: "p1", incarnationId: "i1" });
    expect(identities.size).toBe(1);
  });
});

describe("classifySubRunOwnership — handle 一致だけでは verified にしない", () => {
  const terminals = buildTerminalIdentities({
    ok: true,
    result: { terminals: [{ handle: "term_cmd", tabId: "t1", leafId: "l1", ptyId: "p1", incarnationId: "i1" }] },
  });
  const run: JsonObject = { runId: "run_sub", coordinatorHandle: "term_cmd", objective: "sub" };
  const root: JsonObject = {
    id: "task_sub_root",
    created_by_terminal_handle: "term_cmd",
    created_by_pane_key: "t1:l1",
    created_by_process_incarnation: "p1:i1",
  };

  it("pane key と incarnation が揃って一致すれば verified(auto-cancel の対象)", () => {
    const verdict = classifySubRunOwnership({
      run,
      roots: [root],
      handles: ["term_cmd"],
      callerRunId: "run_caller",
      terminals,
    });
    expect(verdict.ownership).toBe("verified");
    expect(verdict.cancelEligible).toBe(true);
    expect(verdict.source).toBe("provenance");
  });

  it("来歴が読めない handle 一致は probable(破壊的操作には使わない)", () => {
    const verdict = classifySubRunOwnership({
      run,
      roots: [{ id: "task_sub_root", created_by_terminal_handle: "term_cmd" }],
      handles: ["term_cmd"],
      callerRunId: "run_caller",
      terminals: new Map(),
    });
    expect(verdict.ownership).toBe("probable");
    expect(verdict.cancelEligible).toBe(false);
  });

  it("pane key が一致しても incarnation が違えば conflicting", () => {
    const verdict = classifySubRunOwnership({
      run,
      roots: [{ ...root, created_by_process_incarnation: "p9:i9" }],
      handles: ["term_cmd"],
      callerRunId: "run_caller",
      terminals,
    });
    expect(verdict.ownership).toBe("conflicting");
    expect(verdict.cancelEligible).toBe(false);
  });

  it("objective のマーカーは来歴と組み合わせてだけ使う(別の Run を指したら conflicting)", () => {
    const verdict = classifySubRunOwnership({
      run: { ...run, objective: "orca-mcp-parent: run=run_other task=task_x" },
      roots: [root],
      handles: ["term_cmd"],
      callerRunId: "run_caller",
      terminals,
    });
    expect(verdict.ownership).toBe("conflicting");
    expect(verdict.verificationReasons.join("|")).toContain("別の Run");
  });

  it("マーカーだけでは verified にしない(来歴が読めなければ probable)", () => {
    const verdict = classifySubRunOwnership({
      run: { ...run, objective: "orca-mcp-parent: run=run_caller task=task_cmd" },
      roots: [{ id: "task_sub_root", created_by_terminal_handle: "term_cmd" }],
      handles: ["term_cmd"],
      callerRunId: "run_caller",
      terminals: new Map(),
    });
    expect(verdict.ownership).toBe("probable");
    expect(verdict.source).toBe("explicit");
  });

  it("coordinator_handle が Commander の handle でなければ unverified", () => {
    const verdict = classifySubRunOwnership({
      run: { ...run, coordinatorHandle: "term_other" },
      roots: [root],
      handles: ["term_cmd"],
      callerRunId: "run_caller",
      terminals,
    });
    expect(verdict.ownership).toBe("unverified");
    expect(verdict.cancelEligible).toBe(false);
  });
});

describe("getTaskStatus(poll) — sub-run の所有判定とスキャンの完全性", () => {
  it("subRuns に ownership / cancelEligible / verificationReasons を載せる", async () => {
    const { client } = createSubRunClient();
    const view = await getTaskStatus(client, { taskId: "task_cmd", run: "run_caller" });
    const sub = (view["subRuns"] as JsonObject[])[0]!;
    expect(sub).toMatchObject({
      runId: "run_sub",
      ownership: "verified",
      cancelEligible: true,
      discoverySource: "provenance",
    });
    expect((sub["verificationReasons"] as string[]).join("|")).toContain("pane key");
    expect(view["subRunOwnershipComplete"]).toBe(true);
  });

  it("run-list を cursor でページングし、読み切った件数を応答に載せる", async () => {
    const { client, calls } = createSubRunClient();
    const view = await getTaskStatus(client, { taskId: "task_cmd", run: "run_caller" });
    expect(view["subRunScanComplete"]).toBe(true);
    expect(view["subRunScanPageCount"]).toBe(2);
    expect(view["subRunScanRunCount"]).toBe(3);
    const runListCalls = calls.filter((call) => call.startsWith("runList:"));
    expect(runListCalls).toHaveLength(2);
    expect(runListCalls[1]).toContain('"cursor":"cursor_1"');
  });

  it("来歴が読めない sub-run は probable とし、ownershipComplete を false にする", async () => {
    const { client } = createSubRunClient();
    client.terminalList = (async () => ({ ok: true, result: { terminals: [] } })) as unknown as typeof client.terminalList;
    const view = await getTaskStatus(client, { taskId: "task_cmd", run: "run_caller" });
    expect((view["subRuns"] as JsonObject[])[0]).toMatchObject({ ownership: "probable", cancelEligible: false });
    expect(view["subRunOwnershipComplete"]).toBe(false);
    expect(view["warnings"]).toEqual([]);
  });

  it("run-list をページ上限で打ち切ったら scanComplete: false + warning", async () => {
    const { client } = createSubRunClient();
    let seen = 0;
    client.runList = (async () => {
      seen += 1;
      return {
        ok: true,
        result: {
          runs: [{ id: "run_x", objective: "x", coordinator_handle: "term_other", created_at: "2026-10-13T06:53:49Z" }],
          // 毎回新しい cursor を返す = 上限(MAX_SCAN_PAGES)まで歩き続ける
          nextCursor: `cursor_next_${seen}`,
        },
      };
    }) as unknown as typeof client.runList;
    const view = await getTaskStatus(client, { taskId: "task_cmd", run: "run_caller" });
    expect(view["subRunScanComplete"]).toBe(false);
    expect(view["subRunScanPageCount"]).toBe(5);
    expect((view["warnings"] as string[]).join("|")).toContain("打ち切りました(ページ上限に到達)");
  });

  it("同じ cursor が戻るページングはループとして打ち切る(無限に読み続けない)", async () => {
    const { client } = createSubRunClient();
    client.runList = (async () => ({
      ok: true,
      result: {
        runs: [{ id: "run_x", objective: "x", coordinator_handle: "term_other", created_at: "2026-10-13T06:53:49Z" }],
        nextCursor: "cursor_same",
      },
    })) as unknown as typeof client.runList;
    const view = await getTaskStatus(client, { taskId: "task_cmd", run: "run_caller" });
    expect(view["subRunScanComplete"]).toBe(false);
    expect(view["subRunScanPageCount"]).toBe(2);
    expect((view["warnings"] as string[]).join("|")).toContain("同じ cursor が戻った(ループ)");
  });

  it("hasMore: true に対して nextCursor が無い応答は打ち切りとして出す", async () => {
    const { client } = createSubRunClient();
    client.runList = (async () => ({
      ok: true,
      result: {
        runs: [{ id: "run_x", objective: "x", coordinator_handle: "term_other", created_at: "2026-10-13T06:53:49Z" }],
        page: { hasMore: true },
      },
    })) as unknown as typeof client.runList;
    const view = await getTaskStatus(client, { taskId: "task_cmd", run: "run_caller" });
    expect(view["subRunScanComplete"]).toBe(false);
    expect((view["warnings"] as string[]).join("|")).toContain("hasMore: true に対して nextCursor が無い");
  });
});

describe("cancelTask — 所有検証・dispatch 重複・停止後の読み直し", () => {
  it("所有が verified でない sub-run があれば preflight で断る(何も変更しない)", async () => {
    const { client, calls } = createSubRunClient();
    client.terminalList = (async () => ({ ok: true, result: { terminals: [] } })) as unknown as typeof client.terminalList;
    const error = await cancelTask(client, { taskId: "task_cmd", run: "run_caller" }).catch((e) => e);
    expect(error).toBeInstanceOf(JobError);
    expect((error as JobError).code).toBe("cancel_ownership_unverified");
    expect((error as JobError).detail).toMatchObject({
      subRuns: [{ runId: "run_sub", ownership: "probable", cancelEligible: false }],
    });
    expect(calls.some((call) => call.startsWith("workerStop:"))).toBe(false);
    expect(calls.some((call) => call.startsWith("taskUpdate:"))).toBe(false);
    expect(calls.some((call) => call.startsWith("runUse:"))).toBe(false);
  });

  it("停止後も worker が残っていれば fullyStopped: false で正直に返す", async () => {
    const { client } = createSubRunClient();
    // workerStop を叩いても worker-list は in_progress を返し続ける(= 実際に止まっていない)
    client.workerList = (async (input: JsonObject) => ({
      ok: true,
      result: {
        workers:
          input["run"] === "run_sub"
            ? [{ dispatchId: "disp_b", taskId: "task_sub_b", workerState: "in_progress" }]
            : [{ dispatchId: "disp_cmd", taskId: "task_cmd", workerState: "in_progress" }],
      },
    })) as unknown as typeof client.workerList;

    const result = await cancelTask(client, { taskId: "task_cmd", run: "run_caller" });
    expect(result["cancelled"]).toBe(true);
    expect(result["fullyStopped"]).toBe(false);
    expect((result["residualWorkers"] as JsonObject[]).map((row) => row["taskId"])).toEqual(["task_cmd", "task_sub_b"]);
    expect((result["warnings"] as string[]).join("|")).toContain("生存");
  });

  it("同じ dispatch を 2 回叩かない(sub-run 集約と task ツリーが同じ dispatch を持つ)", async () => {
    const { client, calls } = createSubRunClient();
    client.dispatchShow = (async (task: string) => ({
      ok: true,
      result: { dispatch: { id: task === "task_sub_b" ? "disp_b" : "disp_shared" } },
    })) as unknown as typeof client.dispatchShow;

    await cancelTask(client, { taskId: "task_cmd", run: "run_caller" });
    expect(calls.filter((call) => call === "workerStop:disp_shared")).toHaveLength(1);
  });

  it("worker-list をページ上限で打ち切ったら subRunWorkerScanComplete: false + fullyStopped: false", async () => {
    // review10 §1: worker 行の取りこぼしは停止漏れなので、打ち切りを完走として扱わない。
    const { client } = createSubRunClient();
    let seen = 0;
    client.workerList = (async (input: JsonObject) => {
      const run = input["run"];
      const rows =
        run === "run_sub"
          ? [
              { dispatchId: "disp_a", taskId: "task_sub_a", workerState: "stopped" },
              { dispatchId: "disp_b", taskId: "task_sub_b", workerState: "stopped" },
            ]
          : [{ dispatchId: "disp_cmd", taskId: "task_cmd", workerState: "stopped" }];
      if (run !== "run_sub") {
        return { ok: true, result: { workers: rows } };
      }
      seen += 1;
      // hasMore: true が続く = 3 ページ(MAX_WORKER_PAGES)で打ち切る
      return { ok: true, result: { workers: rows, page: { hasMore: true, nextCursor: `cursor_${seen}` } } };
    }) as unknown as typeof client.workerList;

    const result = await cancelTask(client, { taskId: "task_cmd", run: "run_caller" });
    expect(result["cancelled"]).toBe(true);
    expect(result["subRunWorkerScanComplete"]).toBe(false);
    expect(result["fullyStopped"]).toBe(false);
    expect((result["residualWorkers"] as JsonObject[]).map((row) => row["status"])).toContain("scan_incomplete");
    expect((result["warnings"] as string[]).join("|")).toContain("worker-list を 3 ページで打ち切りました");
  });

  it("cancel 前提の worker-list が読めなければ preflight で断る(cancel_discovery_incomplete / 変更ゼロ)", async () => {
    // review10 §2: 探索の前提が欠けたまま進めると、見落とした worker を走りたまま cancelled: true で返す。
    const { client, calls } = createSubRunClient();
    client.workerList = (async () => {
      throw new Error("worker list unavailable");
    }) as unknown as typeof client.workerList;

    const error = await cancelTask(client, { taskId: "task_cmd", run: "run_caller" }).catch((e) => e);
    expect(error).toBeInstanceOf(JobError);
    expect((error as JobError).code).toBe("cancel_discovery_incomplete");
    expect((error as JobError).detail).toMatchObject({
      taskId: "task_cmd",
      runId: "run_caller",
    });
    expect((((error as JobError).detail as JsonObject)["discoveryFailures"] as string[]).join("|")).toContain("worker-list");
    expect(calls.some((call) => call.startsWith("workerStop:"))).toBe(false);
    expect(calls.some((call) => call.startsWith("taskUpdate:"))).toBe(false);
    expect(calls.some((call) => call.startsWith("runUse:"))).toBe(false);
  });

  it("sub-run 探索の run-list が読めなければ preflight で断る(「sub-run は無い」と言わない)", async () => {
    const { client, calls } = createSubRunClient();
    client.runList = (async () => {
      throw new Error("run list unavailable");
    }) as unknown as typeof client.runList;

    const error = await cancelTask(client, { taskId: "task_cmd", run: "run_caller" }).catch((e) => e);
    expect(error).toBeInstanceOf(JobError);
    expect((error as JobError).code).toBe("cancel_discovery_incomplete");
    expect((error as JobError).detail).toMatchObject({ subRunScanComplete: false });
    expect(calls.some((call) => call.startsWith("workerStop:"))).toBe(false);
    expect(calls.some((call) => call.startsWith("taskUpdate:"))).toBe(false);
  });

  it("cascade: false / includeSubRuns: false なら探索を走らせない(逃げ道は生かす)", async () => {
    const { client, calls } = createSubRunClient();
    client.workerList = (async () => {
      throw new Error("worker list unavailable");
    }) as unknown as typeof client.workerList;

    const cascadeOff = await cancelTask(client, { taskId: "task_cmd", run: "run_caller", cascade: false });
    expect(cascadeOff["cancelled"]).toBe(true);

    const subRunsOff = await cancelTask(client, { taskId: "task_cmd", run: "run_caller", includeSubRuns: false });
    expect(subRunsOff["cancelled"]).toBe(true);
    expect(calls.some((call) => call.startsWith("runList:"))).toBe(false);
  });

  it("workerList を持たない client では cascade cancel を安全側で断る(成功扱いしない)", async () => {
    // review11 §4: 「探索機能が走れない」を完全成功の経路にしない。
    const calls: string[] = [];
    const client = {
      taskList: async () => ({
        ok: true,
        result: { tasks: [{ id: "task_cmd", run_id: "run_caller", status: "dispatched", dispatch_id: "disp_cmd" }] },
      }),
      dispatchShow: async () => ({ ok: true, result: { dispatch: { id: "disp_cmd" } } }),
      runList: async () => ({ ok: true, result: { runs: [] } }),
      workerStop: async (dispatch: string) => {
        calls.push(`workerStop:${dispatch}`);
        return { ok: true, result: { state: "stopped" } };
      },
      taskUpdate: async (input: JsonObject) => {
        calls.push(`taskUpdate:${JSON.stringify(input)}`);
        return { ok: true, result: {} };
      },
    } as unknown as OrcaClient;

    const error = await cancelTask(client, { taskId: "task_cmd", run: "run_caller" }).catch((e) => e);
    expect(error).toBeInstanceOf(JobError);
    expect((error as JobError).code).toBe("cancel_discovery_incomplete");
    expect((((error as JobError).detail as JsonObject)["discoveryFailures"] as string[]).join("|")).toContain("workerList");
    expect(calls).toEqual([]);

    // 逃げ道(cascade: false)は従来どおり通す
    const escape = await cancelTask(client, { taskId: "task_cmd", run: "run_caller", cascade: false });
    expect(escape["cancelled"]).toBe(true);
  });

  it("呼び出し元 Run の worker-list がページ上限に到達したら cancel 前に拒否する(変更ゼロ)", async () => {
    // review11 §5: worker 行を取りこぼしたまま「全部止めた」を返さない。
    const { client, calls } = createSubRunClient();
    let seen = 0;
    client.workerList = (async (input: JsonObject) => {
      const run = input["run"];
      const rows =
        run === "run_sub"
          ? [
              { dispatchId: "disp_a", taskId: "task_sub_a", workerState: "stopped", agentTerminalHandle: "term_wa" },
              { dispatchId: "disp_b", taskId: "task_sub_b", workerState: "stopped", agentTerminalHandle: "term_wb" },
            ]
          : [{ dispatchId: "disp_cmd", taskId: "task_cmd", workerState: "stopped", agentTerminalHandle: "term_cmd" }];
      if (run !== "run_caller") {
        return { ok: true, result: { workers: rows } };
      }
      seen += 1;
      // 呼び出し元 Run の worker-list が hasMore を出し続ける(毎回新しい cursor)
      return { ok: true, result: { workers: rows, page: { hasMore: true, nextCursor: `caller_cursor_${seen}` } } };
    }) as unknown as typeof client.workerList;

    const error = await cancelTask(client, { taskId: "task_cmd", run: "run_caller" }).catch((e) => e);
    expect(error).toBeInstanceOf(JobError);
    expect((error as JobError).code).toBe("cancel_discovery_incomplete");
    const failures = ((error as JobError).detail as JsonObject)["discoveryFailures"] as string[];
    expect(failures.join("|")).toContain("呼び出し元 Run の worker-list を 3 ページで打ち切りました");
    expect(calls.some((call) => call.startsWith("workerStop:"))).toBe(false);
    expect(calls.some((call) => call.startsWith("taskUpdate:"))).toBe(false);
  });

  it("worker-list を読み直せる Run が無い cancel は fullyStopped: false で返す", async () => {
    // run 名義が無い = 停止後の残存 worker を検証できない(review11 §4 の安全側)。
    const { client } = createFakeClient({
      taskList: { ok: true, result: { tasks: [{ id: "task_orphan", status: "dispatched", dispatch_id: "disp_orphan" }] } },
    });
    const result = await cancelTask(client, { taskId: "task_orphan", cascade: false });
    expect(result["cancelled"]).toBe(true);
    expect(result["fullyStopped"]).toBe(false);
    expect((result["warnings"] as string[]).join("|")).toContain("worker-list を読み直せる Run");
  });
});
