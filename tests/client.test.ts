import { describe, expect, it } from "vitest";
import {
  extractTaskId,
  extractTasks,
  OrcaClient,
  withFullRecord,
  type JsonObject,
} from "../src/orca/client.js";
import {
  OrcaCommandError,
  type CommandRunner,
  type OrcaCommandResult,
  type RunOptions,
} from "../src/orca/command.js";

/** 子プロセスを起動せずに argv 組み立てを検証するためのモック runner。 */
function createMockRunner(data: unknown = { ok: true }, failure?: { code: string; message: string }) {
  const calls: string[][] = [];
  const options: RunOptions[] = [];
  const runner: CommandRunner = async (args, runOptions) => {
    calls.push(args);
    options.push(runOptions ?? {});
    const result: OrcaCommandResult = failure
      ? { args, ok: false, exitCode: 2, stdout: "", stderr: failure.message, error: failure }
      : { args, ok: true, exitCode: 0, stdout: JSON.stringify(data), stderr: "", data };
    return result;
  };
  return { runner, calls, options };
}

describe("OrcaClient の引数組み立て", () => {
  it("dispatch は --task/--to とフラグを並べる", async () => {
    const { runner, calls } = createMockRunner();
    const client = new OrcaClient(runner);
    await client.dispatch({ task: "t1", to: "term_1", inject: true, run: "r1" });
    expect(calls[0]).toEqual([
      "orchestration",
      "dispatch",
      "--task",
      "t1",
      "--to",
      "term_1",
      "--run",
      "r1",
      "--inject",
      "--full",
      "--json",
    ]);
  });

  // 1.4.246 から orchestration の既定出力は簡易表示(項目が欠ける)。正規化は従来の出力が前提なので一律 --full。
  it("orchestration サブコマンドだけに --full を 1 回付ける", async () => {
    expect(withFullRecord(["orchestration", "task-list"])).toEqual(["orchestration", "task-list", "--full"]);
    expect(withFullRecord(["orchestration", "inbox", "--full"])).toEqual(["orchestration", "inbox", "--full"]);
    expect(withFullRecord(["status"])).toEqual(["status"]);
    expect(withFullRecord(["worktree", "list"])).toEqual(["worktree", "list"]);
    const { runner, calls } = createMockRunner();
    const client = new OrcaClient(runner);
    await client.inbox({ terminal: "dispatch:ctx_1", full: true });
    expect(calls[0]?.filter((arg) => arg === "--full")).toHaveLength(1);
    await client.status();
    expect(calls[1]).toEqual(["status", "--json"]);
  });

  it("task-create の deps は JSON 文字列になる", async () => {
    const { runner, calls } = createMockRunner();
    const client = new OrcaClient(runner);
    await client.taskCreate({ spec: "原稿を書く", title: "原稿", deps: ["t1", "t2"] });
    expect(calls[0]).toEqual([
      "orchestration",
      "task-create",
      "--spec",
      "原稿を書く",
      "--task-title",
      "原稿",
      "--deps",
      JSON.stringify(["t1", "t2"]),
      "--full",
      "--json",
    ]);
  });

  it("check の mode は対応するフラグになる", async () => {
    const { runner, calls } = createMockRunner();
    const client = new OrcaClient(runner);
    await client.check({ mode: "peek", types: ["task", "message"], wait: true, timeoutMs: 5000 });
    expect(calls[0]).toEqual([
      "orchestration",
      "check",
      "--peek",
      "--types",
      "task,message",
      "--wait",
      "--timeout-ms",
      "5000",
      "--full",
      "--json",
    ]);
  });

  it("send は省略したフラグを付与しない", async () => {
    const { runner, calls } = createMockRunner();
    const client = new OrcaClient(runner);
    await client.send({ subject: "hello", body: "world" });
    expect(calls[0]).toEqual(["orchestration", "send", "--subject", "hello", "--body", "world", "--full", "--json"]);
  });

  it("send は worker_done の outcome を --outcome で渡す(消すと CLI が拒否する)", async () => {
    const { runner, calls } = createMockRunner();
    const client = new OrcaClient(runner);
    await client.send({
      subject: "done",
      body: "work finished",
      type: "worker_done",
      outcome: "succeeded",
      taskId: "t1",
      dispatchId: "d1",
      run: "r1",
    });
    const args = calls[0] ?? [];
    expect(args).toContain("--outcome");
    expect(args).toContain("succeeded");
    expect(args).toEqual([
      "orchestration",
      "send",
      "--subject",
      "done",
      "--run",
      "r1",
      "--body",
      "work finished",
      "--type",
      "worker_done",
      "--outcome",
      "succeeded",
      "--task-id",
      "t1",
      "--dispatch-id",
      "d1",
      "--full",
      "--json",
    ]);
  });

  it("worktree ps は --limit を文字列で渡す", async () => {
    const { runner, calls } = createMockRunner();
    const client = new OrcaClient(runner);
    await client.worktreePs(5);
    expect(calls[0]).toEqual(["worktree", "ps", "--limit", "5", "--json"]);
  });

  it("worktree list は repo / limit をフラグで渡す", async () => {
    const { runner, calls } = createMockRunner();
    const client = new OrcaClient(runner);
    await client.worktreeList({ repo: "name:orca-mcp", limit: 10 });
    expect(calls[0]).toEqual([
      "worktree",
      "list",
      "--repo",
      "name:orca-mcp",
      "--limit",
      "10",
      "--json",
    ]);
    await client.worktreeList({});
    expect(calls[1]).toEqual(["worktree", "list", "--json"]);
  });

  it("worktree show は --worktree にセレクタをそのまま渡す", async () => {
    const { runner, calls } = createMockRunner();
    const client = new OrcaClient(runner);
    await client.worktreeShow({ worktree: "branch:main" });
    expect(calls[0]).toEqual(["worktree", "show", "--worktree", "branch:main", "--json"]);
  });

  it("task-list は --from を含めて渡す", async () => {
    const { runner, calls } = createMockRunner();
    const client = new OrcaClient(runner);
    await client.taskList({ status: "ready", ready: true, brief: true, run: "r1", from: "term_1" });
    expect(calls[0]).toEqual([
      "orchestration",
      "task-list",
      "--status",
      "ready",
      "--ready",
      "--brief",
      "--run",
      "r1",
      "--from",
      "term_1",
      "--full",
      "--json",
    ]);
  });

  it("worker-start は supervised worker 起動の argv をこの順で並べる", async () => {
    const { runner, calls } = createMockRunner();
    const client = new OrcaClient(runner);
    await client.workerStart({
      task: "t1",
      worktree: "new-child",
      agent: "codex",
      name: "Commander",
      repo: "name:foo",
      run: "r1",
    });
    expect(calls[0]).toEqual([
      "orchestration",
      "worker-start",
      "--task",
      "t1",
      "--worktree",
      "new-child",
      "--agent",
      "codex",
      "--name",
      "Commander",
      "--repo",
      "name:foo",
      "--run",
      "r1",
      "--full",
      "--json",
    ]);
  });

  it("worker-start は worktree 作成に耐える transport timeout を渡す(既定 30s では足りない)", async () => {
    const { runner, calls, options } = createMockRunner();
    const client = new OrcaClient(runner);
    await client.workerStart({ task: "t1", worktree: "new-child", agent: "claude", name: "E2E" });
    expect(options[0]?.timeoutMs).toBe(180_000);

    // 他のコマンドは transport timeout を上書きしない(既定 30s のまま)
    await client.taskList({});
    expect(options[1]?.timeoutMs).toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  it("worker-start は省略したフラグを付与しない", async () => {
    const { runner, calls } = createMockRunner();
    const client = new OrcaClient(runner);
    await client.workerStart({ task: "t1", worktree: "current", agent: "claude" });
    expect(calls[0]).toEqual([
      "orchestration",
      "worker-start",
      "--task",
      "t1",
      "--worktree",
      "current",
      "--agent",
      "claude",
      "--full",
      "--json",
    ]);
  });

  it("gate-resolve は --id / --resolution を渡し --run を付けない(gate は Run バインドスコープ)", async () => {
    const { runner, calls } = createMockRunner();
    const client = new OrcaClient(runner);
    await client.gateResolve({ id: "gate_1", resolution: "approve" });
    expect(calls[0]).toEqual([
      "orchestration",
      "gate-resolve",
      "--id",
      "gate_1",
      "--resolution",
      "approve",
      "--full",
      "--json",
    ]);
    await client.gateResolve({ id: "gate_1", resolution: "reject", from: "term_1" });
    expect(calls[1]).toEqual([
      "orchestration",
      "gate-resolve",
      "--id",
      "gate_1",
      "--resolution",
      "reject",
      "--from",
      "term_1",
      "--full",
      "--json",
    ]);
  });

  it("skills installed は skills / installed をそのまま渡す", async () => {
    const { runner, calls } = createMockRunner();
    const client = new OrcaClient(runner);
    await client.skillsInstalled();
    expect(calls[0]).toEqual(["skills", "installed", "--json"]);
  });

  it("run-list / run-show は読み取り専用の argv を組み立てる", async () => {
    const { runner, calls } = createMockRunner();
    const client = new OrcaClient(runner);
    await client.runList();
    // --full が無いと coordinator_handle が出ない(2026-11-08 実測・1.4.250)
    expect(calls[0]).toEqual(["orchestration", "run-list", "--full", "--json"]);
    await client.runList({ limit: 50, cursor: "abc" });
    expect(calls[1]).toEqual(["orchestration", "run-list", "--limit", "50", "--cursor", "abc", "--full", "--json"]);
    await client.runShow("run_8d1d20524d42");
    expect(calls[2]).toEqual(["orchestration", "run-show", "--id", "run_8d1d20524d42", "--full", "--json"]);
  });

  it("worker-start は --run を渡せる(sub-run 外でも同じ Run に置ける)", async () => {
    const { runner, calls } = createMockRunner();
    const client = new OrcaClient(runner);
    await client.workerStart({ task: "t1", agent: "codex", worktree: "new-child", run: "run_caller" });
    expect(calls[0]).toEqual([
      "orchestration",
      "worker-start",
      "--task",
      "t1",
      "--worktree",
      "new-child",
      "--agent",
      "codex",
      "--run",
      "run_caller",
      "--full",
      "--json",
    ]);
  });
});

describe("OrcaClient のエラー処理", () => {
  it("result.ok が false なら OrcaCommandError を投げる(code を保持)", async () => {
    const { runner } = createMockRunner(undefined, { code: "non_zero_exit", message: "boom" });
    const client = new OrcaClient(runner);
    const error = await client.status().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OrcaCommandError);
    expect((error as OrcaCommandError).code).toBe("non_zero_exit");
  });

  it("非ゼロ終了 + ok:false エンベロープなら CLI 側の code を優先する", async () => {
    const envelope = {
      ok: false,
      error: { code: "run_required", message: "No Run is bound.", data: { effectsApplied: false } },
    };
    const runner: CommandRunner = async (args) => ({
      args,
      ok: false,
      exitCode: 1,
      stdout: JSON.stringify(envelope),
      stderr: "",
      error: { code: "non_zero_exit", message: "終了コード 1" },
      orcaError: { code: "run_required", message: "No Run is bound.", data: { effectsApplied: false } },
    });
    const client = new OrcaClient(runner);
    const error = (await client.taskList().catch((e: unknown) => e)) as OrcaCommandError;
    expect(error.code).toBe("run_required");
    expect(error.exitCode).toBe(1);
    expect(error.data).toEqual({ effectsApplied: false });
  });

  it("終了コード 0 でも ok:false エンベロープなら CLI 側の code / data を投げる", async () => {
    const envelope = {
      id: "x1",
      ok: false,
      error: {
        code: "run_required",
        message: "No Run is bound.",
        data: { nextSteps: ["run: skills get orchestration --full"] },
      },
    };
    const runner: CommandRunner = async (args) => ({
      args,
      ok: true,
      exitCode: 0,
      stdout: JSON.stringify(envelope),
      stderr: "",
      data: envelope,
      orcaError: { code: "run_required", message: "No Run is bound.", data: envelope.error.data },
    });
    const client = new OrcaClient(runner);
    const error = (await client.taskList().catch((e: unknown) => e)) as OrcaCommandError;
    expect(error).toBeInstanceOf(OrcaCommandError);
    expect(error.code).toBe("run_required");
    expect(error.data).toEqual({ nextSteps: ["run: skills get orchestration --full"] });
  });
});

describe("extractTaskId", () => {
  it("キー候補とネストした task から ID を拾う", () => {
    expect(extractTaskId({ taskId: "t1" })).toBe("t1");
    expect(extractTaskId({ id: "t2" })).toBe("t2");
    expect(extractTaskId({ task: { id: "t3" } })).toBe("t3");
    expect(extractTaskId({})).toBeUndefined();
  });
});

describe("extractTasks", () => {
  it("tasks / items / 配列そのものから取り出す", () => {
    expect(extractTasks({ tasks: [{ id: "t1" }] })).toEqual([{ id: "t1" }]);
    expect(extractTasks({ items: [{ id: "t2" }] })).toEqual([{ id: "t2" }]);
    expect(extractTasks({ raw: null })).toEqual([]);
    const rows: JsonObject[] = [{ taskId: "t1" }, { taskId: "t2" }];
    expect(extractTasks({ tasks: rows })).toHaveLength(2);
  });
});
