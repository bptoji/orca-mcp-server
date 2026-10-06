import type { McpServer } from "@modelcontextprotocol/server";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { type JsonObject, type OrcaClient } from "../orca/client.js";
import { listAgentsInputSchema } from "../orca/schemas.js";
import { resultOf } from "./result.js";

export const LIST_AGENTS_TOOL_NAME = "orca_list_agents";

/** prompt の既定の切り詰め長(lastAssistantMessage は full のときだけ全文)。 */
export const PROMPT_PREVIEW_CHARS = 200;

/** ワークツリー照合に使う欄(セレクタ風の文字列を部分一致で当てる)。 */
const WORKTREE_FIELDS = [
  "worktreeId",
  "branch",
  "displayName",
  "repo",
  "path",
  "comment",
] as const;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function truncate(value: unknown, maxChars: number | undefined): string | null {
  const text = str(value);
  if (text === undefined) {
    return null;
  }
  if (maxChars === undefined || text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}…`;
}

/** `worktree ps` 応答(Envelope の result / 生の形どちらも)から worktrees 配列を取り出す。 */
export function extractWorktrees(payload: JsonObject): JsonObject[] {
  const source = isObject(payload["result"]) ? (payload["result"] as JsonObject) : payload;
  const list = source["worktrees"];
  if (!Array.isArray(list)) {
    return [];
  }
  return list.filter(isObject);
}

function matchesWorktree(worktree: JsonObject, needle: string): boolean {
  const lower = needle.toLowerCase();
  return WORKTREE_FIELDS.some((field) => {
    const value = str(worktree[field]);
    return value !== undefined && value.toLowerCase().includes(lower);
  });
}

export interface FlattenAgentsOptions {
  worktree?: string;
  state?: string;
  full: boolean;
}

/**
 * `orca worktree ps --json` の worktrees[].agents[] を 1 行ずつに平坦化する(純関数・テスト対象)。
 * 各行にワークツリー側の文脈(worktreeId / repo / branch / path)を載せる。
 */
export function flattenAgents(payload: JsonObject, options: FlattenAgentsOptions): JsonObject[] {
  const stateNeedle = options.state?.toLowerCase();
  const rows: JsonObject[] = [];

  for (const worktree of extractWorktrees(payload)) {
    if (options.worktree !== undefined && !matchesWorktree(worktree, options.worktree)) {
      continue;
    }
    const agents = Array.isArray(worktree["agents"]) ? worktree["agents"].filter(isObject) : [];
    for (const agent of agents) {
      const state = str(agent["state"]) ?? null;
      if (stateNeedle !== undefined) {
        if (state === null || !state.toLowerCase().includes(stateNeedle)) {
          continue;
        }
      }
      const row: JsonObject = {
        agentType: agent["agentType"] ?? null,
        state,
        worktreeId: worktree["worktreeId"] ?? null,
        repo: worktree["repo"] ?? null,
        branch: worktree["branch"] ?? null,
        worktreeDisplayName: worktree["displayName"] ?? null,
        worktreeStatus: worktree["status"] ?? null,
        path: worktree["path"] ?? null,
        paneKey: agent["paneKey"] ?? null,
        parentPaneKey: agent["parentPaneKey"] ?? null,
        taskTitle: agent["taskTitle"] ?? null,
        agentDisplayName: agent["displayName"] ?? null,
        toolName: agent["toolName"] ?? null,
        interrupted: agent["interrupted"] ?? null,
        stateStartedAt: agent["stateStartedAt"] ?? null,
        updatedAt: agent["updatedAt"] ?? null,
        prompt: truncate(agent["prompt"], options.full ? undefined : PROMPT_PREVIEW_CHARS),
      };
      if (options.full) {
        row["lastAssistantMessage"] = truncate(agent["lastAssistantMessage"], undefined);
      }
      rows.push(row);
    }
  }
  return rows;
}

/** 状態別の件数(一覧の俯瞰用)。 */
export function countByState(rows: JsonObject[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const key = str(row["state"]) ?? "unknown";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/**
 * orca_list_agents: `orca worktree ps --json` を 1 回呼んで agents[] を平坦化して返す観測ツール。
 * 内部で `orca terminal list` 等は呼ばない(1 コマンド・読み取りのみ)。
 */
export function registerListAgentsTool(server: McpServer, client: OrcaClient): void {
  server.registerTool(
    LIST_AGENTS_TOOL_NAME,
    {
      title: "Orca List Agents",
      description:
        "起動中のエージェント(dsh / codex / claude など)を worktree 横断で一覧化する。内部で `orca worktree ps --json` を 1 回実行するだけで、起動・送信・停止は一切行わない。既定では prompt を 200 文字に切り詰め、lastAssistantMessage は省略する。",
      inputSchema: listAgentsInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input): Promise<CallToolResult> =>
      resultOf(async () => {
        const payload = await client.worktreePs(input.limit);
        const rows = flattenAgents(payload, {
          worktree: input.worktree,
          state: input.state,
          full: input.full,
        });
        const source = isObject(payload["result"]) ? (payload["result"] as JsonObject) : payload;
        return {
          count: rows.length,
          byState: countByState(rows),
          worktreesScanned: extractWorktrees(payload).length,
          truncated: source["truncated"] ?? null,
          agents: rows,
        };
      }),
  );
}
