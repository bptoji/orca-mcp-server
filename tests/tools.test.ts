import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { createServer, SERVER_NAME, SERVER_VERSION } from "../src/index.js";
import { OrcaClient, type JsonObject } from "../src/orca/client.js";
import { runMessageAction } from "../src/tools/message.js";
import { STATUS_TOOL_NAME } from "../src/tools/status.js";

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
  it("McpServer を返し、フェーズ 1 の orca_status だけが登録されている", () => {
    const { stub } = createStubClient();
    const server = createServer(stub);
    expect(server).toBeInstanceOf(McpServer);
    const registered = Object.keys(
      (server as unknown as RegisteredToolsAccess)._registeredTools,
    ).sort();
    expect(registered).toEqual([STATUS_TOOL_NAME]);
  });

  it("サーバー名とバージョン", () => {
    expect(SERVER_NAME).toBe("orca-mcp");
    expect(SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
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
