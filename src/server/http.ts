/**
 * Streamable HTTP の起動。責務は「サーバー生成 + gate 合成 + 起動 / 停止」だけ。
 *
 * - stateless 既定: リクエストごとに `createServer()` を factory 経由で生成する
 *   (`Mcp-Session-Id` / session map / transport map は作らない)
 * - Node ↔ Web Standard の変換は書かない(`toNodeHandler` / `toWebRequest` に任せる)
 * - `Host` / `Origin` の guard は自分で 403 を回答する(`@modelcontextprotocol/node`)
 * - Bearer 拒否の応答も SDK が組み立てる(`bearerAuthChallengeResponse`)
 */

import http from "node:http";
import {
  DEFAULT_MAX_REQUEST_BODY_SIZE,
  bearerAuthChallengeResponse,
  createMcpHandler,
  verifyBearerToken,
} from "@modelcontextprotocol/server";
import type { AuthInfo, McpServer } from "@modelcontextprotocol/server";
import { hostHeaderValidation, originValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { StaticTokenVerifier } from "./auth.js";
import type { TransportConfig } from "./config.js";

export const MCP_ENDPOINT_PATH = "/mcp";

/** 404 の本文(エンドポイント以外へのリクエスト。JSON-RPC の -32000 を使う)。 */
function notFoundBody(path: string): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    error: { code: -32000, message: `Not found: ${path}` },
    id: null,
  });
}

export interface HttpServerOptions {
  readonly config: TransportConfig;
  /** リクエストごとに新しい `McpServer` を作る factory(stateless の要)。 */
  readonly createServer: () => McpServer;
  /** 診断出力(stderr へ出す想定。既定は `console.error`)。 */
  readonly onDiagnostic?: (message: string) => void;
  /** 要求 body の上限(バイト)。既定は SDK の 4 MiB。 */
  readonly maxRequestBodySize?: number;
}

export interface HttpServerHandle {
  readonly host: string;
  /** `port: 0` を渡したときに実際に割り当てられた port。 */
  readonly port: number;
  readonly close: () => Promise<void>;
}

type NodeRequest = http.IncomingMessage & { auth?: AuthInfo };

/** Web Standard の `Response` を Node の `ServerResponse` へ書き出す(拒否応答用)。 */
async function writeWebResponse(res: http.ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const body = Buffer.from(await response.arrayBuffer());
  res.writeHead(response.status, headers);
  res.end(body);
}

function endpointOf(req: http.IncomingMessage): string | null {
  const raw = req.url;
  if (raw === undefined) {
    return null;
  }
  try {
    return new URL(raw, `http://${req.headers.host ?? "localhost"}`).pathname;
  } catch {
    return null;
  }
}

/**
 * `http` トランスポートを起動する。呼び出し前に `startUpRefusal` で起動可否を見ること。
 */
export async function startHttpServer(options: HttpServerOptions): Promise<HttpServerHandle> {
  const { config, createServer } = options;
  const diagnostic = options.onDiagnostic ?? ((message: string) => console.error(message));
  const maxRequestBodySize = options.maxRequestBodySize ?? DEFAULT_MAX_REQUEST_BODY_SIZE;

  const handler = createMcpHandler(() => createServer(), {
    // 既定の 'stateless'(GET / DELETE は 405)。session map を作らない構成そのものにする。
    legacy: "stateless",
    maxRequestBodySize,
    onerror: (error) => diagnostic(`[http] ${error.message}`),
  });

  const nodeHandler = toNodeHandler(handler, {
    maxRequestBodySize,
    onerror: (error) => diagnostic(`[http] ${error.message}`),
  });

  const hostGate = hostHeaderValidation([...config.allowedHosts]);
  const originGate = originValidation([...config.allowedOrigins]);
  const verifier = config.authToken === null ? null : new StaticTokenVerifier(config.authToken);

  const server = http.createServer((req, res) => {
    void serve(req, res);
  });

  async function serve(rawReq: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const req = rawReq as NodeRequest;
    const path = endpointOf(req);
    if (path !== MCP_ENDPOINT_PATH) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(notFoundBody(path ?? req.url ?? ""));
      return;
    }
    // guard は拒否応答を自分で書く。false のときはこれ以上触らない。
    if (!hostGate(req, res)) {
      return;
    }
    if (!originGate(req, res)) {
      return;
    }
    if (verifier !== null) {
      try {
        req.auth = await verifyBearerToken(req.headers.authorization, { verifier });
      } catch (error) {
        await writeWebResponse(res, bearerAuthChallengeResponse(error));
        return;
      }
    }
    await nodeHandler(req, res);
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : config.port;
  diagnostic(`[http] listening on http://${config.host}:${port}${MCP_ENDPOINT_PATH}`);

  async function close(): Promise<void> {
    // 進行中の exchange を止めて per-request instance を閉じる。
    await handler.close();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // keep-alive のまま開いているクライアントを切る(close が終わるように)。
      if (typeof server.closeAllConnections === "function") {
        server.closeAllConnections();
      }
    });
  }

  return { host: config.host, port, close };
}
