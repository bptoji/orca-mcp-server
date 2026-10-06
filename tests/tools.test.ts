import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { createServer, SERVER_NAME, SERVER_VERSION } from "../src/index.js";
import { OrcaClient, type JsonObject } from "../src/orca/client.js";
import { runMessageAction } from "../src/tools/message.js";
import { STATUS_TOOL_NAME } from "../src/tools/status.js";
import { countByState, flattenAgents } from "../src/tools/agents.js";
import {
  GET_WORKTREE_TOOL_NAME,
  LIST_WORKTREES_TOOL_NAME,
} from "../src/tools/worktrees.js";
import { LIST_AGENTS_TOOL_NAME } from "../src/tools/agents.js";
import { TASK_STATUS_TOOL_NAME } from "../src/tools/task-status.js";

// SDK 内部の登録テーブルにアクセスするための薄い型(スモークテスト用)。
interface RegisteredToolsAccess {
  _registeredTools: Record<string, unknown>;
}

/** メソッド呼び出しを記録するスタブクライアント。 */
function createStubClient() {
  const calls: Array<[string, unknown]> = [];
  const record =
    (name: string) =>
    (input: unknown): Promise<JsonObject> => {
      calls.push([name, input]);
      return Promise.resolve({ ok: true, echo: input });
    };
  const stub = {
    status: record("status"),
    worktreeList: record("worktreeList"),
    worktreeShow: record("worktreeShow"),
    worktreePs: record("worktreePs"),
    taskCreate: record("taskCreate"),
    taskList: record("taskList"),
    taskUpdate: record("taskUpdate"),
    dispatch: record("dispatch"),
    dispatchShow: record("dispatchShow"),
    send: record("send"),
    check: record("check"),
    reply: record("reply"),
    inbox: record("inbox"),
    runCreate: record("runCreate"),
    runCurrent: record("runCurrent"),
  };
  return { stub: stub as unknown as OrcaClient, calls };
}

describe("createServer", () => {
  it("McpServer を返し、読み取り(read-only)ツール 5 個だけが登録されている", () => {
    const { stub } = createStubClient();
    const server = createServer(stub);
    expect(server).toBeInstanceOf(McpServer);
    const registered = Object.keys(
      (server as unknown as RegisteredToolsAccess)._registeredTools,
    ).sort();
    expect(registered).toEqual(
      [
        STATUS_TOOL_NAME,
        LIST_WORKTREES_TOOL_NAME,
        GET_WORKTREE_TOOL_NAME,
        LIST_AGENTS_TOOL_NAME,
        TASK_STATUS_TOOL_NAME,
      ].sort(),
    );
  });

  it("エージェントを起動するツール(delegate / message)は未登録のまま", () => {
    const { stub } = createStubClient();
    const registered = Object.keys(
      (createServer(stub) as unknown as RegisteredToolsAccess)._registeredTools,
    );
    expect(registered).not.toContain("orca_delegate");
    expect(registered).not.toContain("orca_message");
  });

  it("サーバー名とバージョン", () => {
    expect(SERVER_NAME).toBe("orca-mcp");
    expect(SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("flattenAgents", () => {
  const payload: JsonObject = {
    ok: true,
    result: {
      worktrees: [
        {
          worktreeId: "repo::C:/a",
          repo: "orca-mcp",
          branch: "refs/heads/main",
          displayName: "main",
          path: "C:/a",
          status: "working",
          agents: [
            {
              paneKey: "p1",
              state: "working",
              agentType: "dsh",
              prompt: "x".repeat(500),
              toolName: "pwsh",
            },
            { paneKey: "p2", state: "idle", agentType: "codex", prompt: "short" },
          ],
        },
        {
          worktreeId: "repo::C:/b",
          repo: "other",
          agents: [{ paneKey: "p3", state: "waiting", agentType: "claude" }],
        },
      ],
      truncated: false,
    },
  };

  it("worktrees[].agents[] を平坦化し worktree 文脈を各行に載せる", () => {
    const rows = flattenAgents(payload, { full: false });
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      agentType: "dsh",
      state: "working",
      worktreeId: "repo::C:/a",
      repo: "orca-mcp",
      worktreeStatus: "working",
      paneKey: "p1",
    });
  });

  it("既定では prompt を 200 文字で切り詰め lastAssistantMessage を付けない", () => {
    const rows = flattenAgents(payload, { full: false });
    const prompt = rows[0]?.["prompt"] as string | undefined;
    expect(prompt?.length).toBeLessThanOrEqual(201);
    expect(prompt?.endsWith("…")).toBe(true);
    expect(rows[0]?.["lastAssistantMessage"]).toBeUndefined();
  });

  it("full: true なら prompt 全文と lastAssistantMessage を含める", () => {
    const rows = flattenAgents(payload, { full: true });
    expect((rows[0]?.["prompt"] as string | undefined)?.length).toBe(500);
    expect(rows[0]?.["lastAssistantMessage"]).toBeNull();
  });

  it("worktree / state で絞り込める(部分一致・英小文字で比較)", () => {
    expect(flattenAgents(payload, { worktree: "ORCA-MCP", state: undefined, full: false })).toHaveLength(2);
    expect(flattenAgents(payload, { state: "WORK", full: false })).toHaveLength(1);
    expect(flattenAgents(payload, { worktree: "C:/b", full: false })[0]?.["agentType"]).toBe("claude");
    expect(flattenAgents(payload, { worktree: "none", full: false })).toHaveLength(0);
  });

  it("worktrees が無い応答では空配列", () => {
    expect(flattenAgents({ ok: true }, { full: false })).toEqual([]);
  });

  it("countByState は状態別に件数を集計する", () => {
    expect(countByState(flattenAgents(payload, { full: false }))).toEqual({
      working: 1,
      idle: 1,
      waiting: 1,
    });
  });
});

describe("runMessageAction", () => {
  it("action ごとにクライアントメソッドへ転送する", async () => {
    const { stub, calls } = createStubClient();

    await runMessageAction(stub, { action: "send", subject: "hi", body: "b" });
    expect(calls[0]).toEqual(["send", { subject: "hi", body: "b" }]);

    await runMessageAction(stub, { action: "check", mode: "all", types: undefined, terminal: undefined, run: undefined, ack: undefined, wait: false, timeoutMs: undefined });
    expect(calls[1]?.[0]).toBe("check");

    await runMessageAction(stub, { action: "reply", id: "m1", body: "ok" });
    expect(calls[2]).toEqual(["reply", { id: "m1", body: "ok" }]);

    await runMessageAction(stub, { action: "inbox", limit: 10, terminal: undefined, full: false });
    expect(calls[3]?.[0]).toBe("inbox");
  });
});
