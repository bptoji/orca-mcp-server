#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { OrcaClient } from "./orca/client.js";
import { registerStatusTool } from "./tools/status.js";
import { registerGetWorktreeTool, registerListWorktreesTool } from "./tools/worktrees.js";
import { registerListAgentsTool } from "./tools/agents.js";
import { registerGetTaskStatusTool } from "./tools/task-status.js";
// 未登録の足場(エージェントを起動する): tools/delegate.ts / tools/message.ts

export const SERVER_NAME = "orca-mcp";
export const SERVER_VERSION = "1.0.0";

/** 登録済みツールを備えた McpServer を生成する(テスト・インポート利用時もここを使う)。 */
export function createServer(client: OrcaClient = new OrcaClient()): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );
  // フェーズ 2: 読み取り(read-only)ツールのみ。エージェントを起動・変更するツールは未登録。
  registerStatusTool(server, client);
  registerListWorktreesTool(server, client);
  registerGetWorktreeTool(server, client);
  registerListAgentsTool(server, client);
  registerGetTaskStatusTool(server, client);
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
