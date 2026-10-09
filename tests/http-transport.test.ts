import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import { SERVER_NAME, SERVER_VERSION, createServer } from "../src/index.js";
import { OrcaClient } from "../src/orca/client.js";
import type { CommandRunner, OrcaCommandResult } from "../src/orca/command.js";
import { STATUS_TOOL_NAME } from "../src/tools/status.js";
import { resolveTransportConfig } from "../src/server/config.js";
import { MCP_ENDPOINT_PATH, startHttpServer } from "../src/server/http.js";
import type { HttpServerHandle } from "../src/server/http.js";

const TEST_TOKEN = "test-bearer-token";
const AUTH = { authorization: `Bearer ${TEST_TOKEN}` };

/** orca ランタイムを使わずにツールを動かすためのスタブ runner。 */
function createStubClient(): OrcaClient {
  const runner: CommandRunner = async (args) => {
    const data = { ok: true, state: "ready", echoArgs: args };
    const result: OrcaCommandResult = {
      args,
      ok: true,
      exitCode: 0,
      stdout: JSON.stringify(data),
      stderr: "",
      data,
    };
    return result;
  };
  return new OrcaClient(runner);
}

async function startServer(env: Record<string, string> = {}): Promise<HttpServerHandle> {
  const config = resolveTransportConfig({
    ORCA_MCP_TRANSPORT: "http",
    ORCA_MCP_HTTP_PORT: "0",
    ...env,
  });
  return startHttpServer({
    config,
    createServer: () => createServer(createStubClient()),
    onDiagnostic: () => undefined,
  });
}

function urlOf(handle: HttpServerHandle, path = MCP_ENDPOINT_PATH): string {
  return `http://127.0.0.1:${handle.port}${path}`;
}

async function post(
  handle: HttpServerHandle,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; contentType: string | null; text: string }> {
  const response = await fetch(urlOf(handle), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    text: await response.text(),
  };
}

/** SSE の本文(`event: message` + `data: {...}`)から JSON-RPC メッセージを取り出す。 */
function messageOf(text: string): Record<string, unknown> {
  const line = text
    .split("\n")
    .find((candidate) => candidate.startsWith("data: "));
  if (line === undefined) {
    throw new Error(`SSE data 行が見つからない: ${text.slice(0, 200)}`);
  }
  return JSON.parse(line.slice("data: ".length)) as Record<string, unknown>;
}

function requestWithHost(
  handle: HttpServerHandle,
  host: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: handle.port,
        path: MCP_ENDPOINT_PATH,
        method: "POST",
        headers: {
          host,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...headers,
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          text += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify({ jsonrpc: "2.0", id: 90, method: "tools/list", params: {} }));
  });
}

function rawPost(
  handle: HttpServerHandle,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: handle.port,
        path: MCP_ENDPOINT_PATH,
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...headers,
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          text += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "vitest", version: "1" },
  },
};

const LIST_TOOLS = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };

function callStatus(id: number) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: STATUS_TOOL_NAME, arguments: {} },
  };
}

describe("http トランスポート(stateless / 1 リクエスト 1 サーバー)", () => {
  let handle: HttpServerHandle | null = null;

  afterEach(async () => {
    if (handle !== null) {
      await handle.close();
      handle = null;
    }
  });

  it("initialize / tools/list / tools/call が通る(認証込み)", async () => {
    handle = await startServer({ ORCA_MCP_AUTH_TOKEN: TEST_TOKEN });

    const initialized = await post(handle, INITIALIZE, AUTH);
    expect(initialized.status).toBe(200);
    const initMessage = messageOf(initialized.text);
    const result = initMessage.result as Record<string, unknown>;
    expect(result.serverInfo).toMatchObject({ name: SERVER_NAME, version: SERVER_VERSION });

    const listed = await post(handle, LIST_TOOLS, AUTH);
    expect(listed.status).toBe(200);
    const tools = (messageOf(listed.text).result as Record<string, unknown>).tools as Array<{
      name: string;
    }>;
    expect(tools.map((tool) => tool.name)).toContain(STATUS_TOOL_NAME);

    const called = await post(handle, callStatus(3), AUTH);
    expect(called.status).toBe(200);
    const callResult = messageOf(called.text).result as Record<string, unknown>;
    expect(JSON.stringify(callResult)).toContain("ready");
  });

  it("トークン未設定なら認証なしで通る(localhost 限定運用)", async () => {
    handle = await startServer();
    const listed = await post(handle, LIST_TOOLS);
    expect(listed.status).toBe(200);
  });

  it("トークン欠落は 401 + WWW-Authenticate", async () => {
    handle = await startServer({ ORCA_MCP_AUTH_TOKEN: TEST_TOKEN });
    const response = await fetch(urlOf(handle), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify(LIST_TOOLS),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("トークン不一致は 401", async () => {
    handle = await startServer({ ORCA_MCP_AUTH_TOKEN: TEST_TOKEN });
    const listed = await post(handle, LIST_TOOLS, { authorization: "Bearer wrong-token" });
    expect(listed.status).toBe(401);
  });

  it("Bearer 以外の scheme は 401", async () => {
    handle = await startServer({ ORCA_MCP_AUTH_TOKEN: TEST_TOKEN });
    const listed = await post(handle, LIST_TOOLS, { authorization: `token ${TEST_TOKEN}` });
    expect(listed.status).toBe(401);
  });

  it("scheme 名は大小文字を問わない", async () => {
    handle = await startServer({ ORCA_MCP_AUTH_TOKEN: TEST_TOKEN });
    const listed = await post(handle, LIST_TOOLS, { authorization: `bearer ${TEST_TOKEN}` });
    expect(listed.status).toBe(200);
  });

  it("許可リストに無い Host は 403", async () => {
    handle = await startServer();
    const response = await requestWithHost(handle, "evil.example");
    expect(response.status).toBe(403);
    expect(response.text).toContain("Invalid Host");
  });

  it("許可リスト内の Host(localhost)は通る", async () => {
    handle = await startServer();
    const response = await requestWithHost(handle, "localhost");
    expect(response.status).toBe(200);
  });

  it("許可リストに無い Origin は 403、Origin 無しは通る", async () => {
    handle = await startServer();
    const blocked = await post(handle, LIST_TOOLS, { origin: "http://evil.example" });
    expect(blocked.status).toBe(403);
    expect(blocked.text).toContain("Invalid Origin");

    const plain = await post(handle, LIST_TOOLS);
    expect(plain.status).toBe(200);
  });

  it("4 MiB を超える body は 413(サーバーを起動させない)", async () => {
    handle = await startServer();
    const huge = callStatus(4);
    // 上限(4 MiB)をわずかに超える量にする(大きくしすぎると書き込み中に接続が切れる)。
    (huge.params as Record<string, unknown>).arguments = { pad: "x".repeat(4 * 1024 * 1024 + 4096) };
    // 413 のあと接続が切れるため、fetch ではなく node:http でステータスを読む。
    const response = await rawPost(handle, huge);
    expect(response.status).toBe(413);
    expect(response.text).toContain("Payload Too Large");
  });

  it("2 クライアントが同時接続しても応答が混ざらない", async () => {
    handle = await startServer({ ORCA_MCP_AUTH_TOKEN: TEST_TOKEN });
    const [first, second] = await Promise.all([
      post(handle, callStatus(10), AUTH),
      post(handle, callStatus(11), AUTH),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(messageOf(first.text).id).toBe(10);
    expect(messageOf(second.text).id).toBe(11);
  });

  it("stateless なので GET / DELETE は 405(session 操作を受け付けない)", async () => {
    handle = await startServer();
    const get = await fetch(urlOf(handle), { method: "GET" });
    expect(get.status).toBe(405);
    const del = await fetch(urlOf(handle), { method: "DELETE" });
    expect(del.status).toBe(405);
  });

  it("/mcp 以外は 404", async () => {
    handle = await startServer();
    const response = await fetch(urlOf(handle, "/other"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(404);
  });

  it("close 後は接続できない", async () => {
    handle = await startServer();
    const port = handle.port;
    expect((await post(handle, LIST_TOOLS)).status).toBe(200);

    const closing = handle;
    handle = null;
    await closing.close();

    await expect(
      fetch(`http://127.0.0.1:${port}${MCP_ENDPOINT_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    ).rejects.toThrow();
  });
});
