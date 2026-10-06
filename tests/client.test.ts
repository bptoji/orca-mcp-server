import { describe, expect, it } from "vitest";
import {
  extractTaskId,
  extractTasks,
  OrcaClient,
  type JsonObject,
} from "../src/orca/client.js";
import {
  OrcaCommandError,
  type CommandRunner,
  type OrcaCommandResult,
} from "../src/orca/command.js";

/** 子プロセスを起動せずに argv 組み立てを検証するためのモック runner。 */
function createMockRunner(data: unknown = { ok: true }, failure?: { code: string; message: string }) {
  const calls: string[][] = [];
  const runner: CommandRunner = async (args) => {
    calls.push(args);
    const result: OrcaCommandResult = failure
      ? { args, ok: false, exitCode: 2, stdout: "", stderr: failure.message, error: failure }
      : { args, ok: true, exitCode: 0, stdout: JSON.stringify(data), stderr: "", data };
    return result;
  };
  return { runner, calls };
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
      "--json",
    ]);
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
      "--json",
    ]);
  });

  it("send は省略したフラグを付与しない", async () => {
    const { runner, calls } = createMockRunner();
    const client = new OrcaClient(runner);
    await client.send({ subject: "hello", body: "world" });
    expect(calls[0]).toEqual(["orchestration", "send", "--subject", "hello", "--body", "world", "--json"]);
  });

  it("worktree ps は --limit を文字列で渡す", async () => {
    const { runner, calls } = createMockRunner();
    const client = new OrcaClient(runner);
    await client.worktreePs(5);
    expect(calls[0]).toEqual(["worktree", "ps", "--limit", "5", "--json"]);
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
