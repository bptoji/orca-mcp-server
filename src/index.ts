#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { OrcaClient } from "./orca/client.js";
import { registerJobTools } from "./tools/job.js";
import { registerInterveneTools } from "./tools/intervene.js";
import { registerStatusTool } from "./tools/status.js";
import { registerGetWorktreeTool, registerListWorktreesTool } from "./tools/worktrees.js";
import { registerListAgentsTool } from "./tools/agents.js";
import { registerReadinessTool } from "./tools/readiness.js";
import {
  TransportConfigError,
  resolveTransportConfig,
  startUpRefusal,
  transportWarnings,
} from "./server/config.js";
import { startHttpServer } from "./server/http.js";
// 未登録の足場(低レベルすぎる API を外部に出さない): tools/delegate.ts / tools/message.ts

export const SERVER_NAME = "orca-mcp";
export const SERVER_VERSION = "1.0.0";

/** 登録済みツールを備えた McpServer を生成する(テスト・インポート利用時もここを使う)。 */
export function createServer(client: OrcaClient = new OrcaClient()): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );
  // 主軸: 非同期 Job API(submit / poll / result)。1 呼び出しでワーカーを待たせない。
  registerJobTools(server, client);
  // 介入: 明示的に頼まれたときだけ変更する 2 個(変更系コマンドはここに集約する)。
  registerInterveneTools(server, client);
  // 観測用 read-only(デバッグ・状況確認用)。低レベルの作成系は登録しない。
  registerStatusTool(server, client);
  registerReadinessTool(server, client);
  registerListWorktreesTool(server, client);
  registerGetWorktreeTool(server, client);
  registerListAgentsTool(server, client);
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
  startFromEnv();
}

/**
 * 既定は stdio(既存の起動経路を変えない)。`ORCA_MCP_TRANSPORT=http` のときだけ HTTP で立つ。
 * 設定の解釈・起動可否の判定は src/server/config.js の純粋関数にあり、ここでは配線だけ行う。
 */
function startFromEnv(): void {
  let config;
  try {
    config = resolveTransportConfig();
  } catch (error) {
    if (error instanceof TransportConfigError) {
      console.error(`[${SERVER_NAME}] ${error.code}: ${error.message}`);
      process.exit(1);
      return;
    }
    throw error;
  }

  if (config.transport === "stdio") {
    startStdio();
    return;
  }

  const refusal = startUpRefusal(config);
  if (refusal !== null) {
    console.error(`[${SERVER_NAME}] ${refusal.code}: ${refusal.message}`);
    process.exit(1);
    return;
  }
  for (const warning of transportWarnings(config)) {
    console.error(`[${SERVER_NAME}] ${warning}`);
  }

  void startHttp(config);
}

function startStdio(): void {
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

async function startHttp(config: ReturnType<typeof resolveTransportConfig>): Promise<void> {
  try {
    // 1 リクエスト 1 サーバー。context は使わないが factory の形に合わせる。
    const handle = await startHttpServer({ config, createServer: () => createServer() });
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.on(signal, () => {
        void handle.close().finally(() => process.exit(0));
      });
    }
  } catch (error) {
    // listen 失敗(port 占有 / bind 不可)は起動失敗として終わる。
    console.error(`[${SERVER_NAME}] http_start_failed: ${(error as Error).message}`);
    process.exit(1);
  }
}
