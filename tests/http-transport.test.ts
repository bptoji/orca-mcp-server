import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { McpRequestContext, McpServer } from "@modelcontextprotocol/server";
import { SERVER_NAME, SERVER_VERSION, createServer } from "../src/index.js";
import { OrcaClient } from "../src/orca/client.js";
import type { CommandRunner, OrcaCommandResult } from "../src/orca/command.js";
import { STATUS_TOOL_NAME } from "../src/tools/status.js";
import { STATIC_TOKEN_CLIENT_ID } from "../src/server/auth.js";
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

/** orca を叩いた回数を数えるスタブ(runner 実行の有無をテストから見るため)。 */
function createRecordingClient(): { client: OrcaClient; calls: string[][] } {
  const calls: string[][] = [];
  const runner: CommandRunner = async (args) => {
    calls.push(args);
    const data = { ok: true, state: "ready", echoArgs: args };
    return { args, ok: true, exitCode: 0, stdout: JSON.stringify(data), stderr: "", data };
  };
  return { client: new OrcaClient(runner), calls };
}

async function startServer(
  env: Record<string, string> = {},
  factory: (ctx: McpRequestContext) => McpServer = () => createServer(createStubClient()),
): Promise<HttpServerHandle> {
  const config = resolveTransportConfig({
    ORCA_MCP_TRANSPORT: "http",
    ORCA_MCP_HTTP_PORT: "0",
    ...env,
  });
  return startHttpServer({
    config,
    createServer: (ctx) => factory(ctx),
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

/** 413 のあとは接続が切れることがある(server が 413 を書いて socket を壊すため)。 */
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
    req.on("error", (error: NodeJS.ErrnoException) => {
      resolve({ status: 0, text: error.code ?? error.message });
    });
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

  it("4 MiB を超える body は handler に到達しない(413 / 413 後の接続断)", async () => {
    const recording = createRecordingClient();
    handle = await startServer({}, () => createServer(recording.client));
    const huge = callStatus(4);
    // 上限(4 MiB)をわずかに超える量にする(大きくしすぎると書き込み中に接続が切れる)。
    (huge.params as Record<string, unknown>).arguments = { pad: "x".repeat(4 * 1024 * 1024 + 4096) };
    // 413 のあと接続が切れるため、fetch ではなく node:http で読む。
    const response = await rawPost(handle, huge);
    expect([413, 0]).toContain(response.status); // 0 = 応答を読む前に接続が切れた
    if (response.status === 413) {
      expect(response.text).toContain("Payload Too Large");
    }
    // 本体の検証: 大きな body でサーバーは起動していない。
    expect(recording.calls).toEqual([]);

    // 同じサーバーがそのまま使える(1 リクエスト失敗で壊れていない)。
    expect((await post(handle, LIST_TOOLS)).status).toBe(200);
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

  it("IPv6 loopback は bind 用表記(::1)で起動する", async () => {
    try {
      handle = await startServer({ ORCA_MCP_HTTP_HOST: "::1" });
    } catch (error) {
      // IPv6 loopback を使えない環境ではスキップする。
      expect((error as Error).message).toContain("::1");
      return;
    }
    expect(handle.host).toBe("::1");
    const response = await fetch(`http://[::1]:${handle.port}${MCP_ENDPOINT_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(LIST_TOOLS),
    });
    expect(response.status).toBe(200);
  });

  it("Content-Type が application/json でなければ 415", async () => {
    handle = await startServer();
    const response = await fetch(urlOf(handle), {
      method: "POST",
      headers: { "content-type": "text/plain", accept: "application/json, text/event-stream" },
      body: JSON.stringify(LIST_TOOLS),
    });
    expect(response.status).toBe(415);
  });

  it("検証済み AuthInfo が factory まで届く(stateless で client 情報を保持できる)", async () => {
    const seen: Array<string | undefined> = [];
    handle = await startServer({ ORCA_MCP_AUTH_TOKEN: TEST_TOKEN }, (ctx) => {
      seen.push(ctx.authInfo?.clientId);
      return createServer(createStubClient());
    });

    expect((await post(handle, LIST_TOOLS, AUTH)).status).toBe(200);
    expect(seen).toEqual([STATIC_TOKEN_CLIENT_ID]);
  });

  it("handler が例外を投げても 500 で応答し、プロセスは生きたまま次を通す", async () => {
    let first = true;
    handle = await startServer({}, () => {
      if (first) {
        first = false;
        throw new Error("boom");
      }
      return createServer(createStubClient());
    });

    const failed = await post(handle, LIST_TOOLS);
    expect(failed.status).toBe(500);
    expect(JSON.parse(failed.text)).toMatchObject({
      jsonrpc: "2.0",
      error: { code: -32603 },
    });

    const recovered = await post(handle, LIST_TOOLS);
    expect(recovered.status).toBe(200);
  });
});
