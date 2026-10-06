#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { OrcaClient } from "./orca/client.js";
import { registerStatusTool } from "./tools/status.js";
// 次のフェーズで登録する足場(未登録): tools/delegate.ts / tools/task-status.ts / tools/message.ts

export const SERVER_NAME = "orca-mcp";
export const SERVER_VERSION = "1.0.0";

/** 登録済みツールを備えた McpServer を生成する(テスト・インポート利用時もここを使う)。 */
export function createServer(client: OrcaClient = new OrcaClient()): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );
  // フェーズ 1: 観測のみ。エージェントを起動するツール(delegate 等)はまだ登録しない。
  registerStatusTool(server, client);
  return server;
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isMainModule()) {
  const handle = serveStdio(() => createServer(), {
    onerror: (error) => {
      // stdout は MCP ワイヤー専用。診断は stderr へ出すこと。
      console.error(`[${SERVER_NAME}]`, error);
    },
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void handle.close().finally(() => process.exit(0));
    });
  }
}
