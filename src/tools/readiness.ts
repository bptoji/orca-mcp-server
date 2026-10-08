import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { isJsonObject, pickString, unwrapResult } from "../orca/job.js";
import type { JsonObject, OrcaClient } from "../orca/client.js";
import { readinessInputSchema } from "../orca/schemas.js";
import { resultOf } from "./result.js";

export const READINESS_TOOL_NAME = "orca_readiness";

/** Commander が動くために必要な前提。名前が `missing` にそのまま出る。 */
const REQUIRED_SKILL = "orchestration";

/**
 * `orca skills installed` の providers 列挙に現れない**共有 skills ルート**を読むエージェント。
 * dsh は skill-filesystem が `agentsHome/skills`(既定は `~/.agents/skills`)をスキャンするため、
 * providers に `dsh` が並ばなくても orchestration skill を読める。実機で確認済み:
 * `~/.agents/skills/orchestration/SKILL.md` が dsh の skill catalog に並ぶ
 * (providers 列挙は claude / codex などで、dsh をはじくために使うと誤検地になる)。
 */
const SHARED_SKILLS_ROOT_AGENTS = new Set(["dsh"]);
const SHARED_SKILLS_ROOT = "~/.agents/skills";

export interface ReadinessCheck {
  name: string;
  ok: boolean;
  detail: string | null;
}

function capabilityList(runtime: JsonObject): string[] {
  return Array.isArray(runtime["capabilities"])
    ? runtime["capabilities"].filter((value): value is string => typeof value === "string")
    : [];
}

interface SkillRow {
  name: string;
  providers: string[];
}

function skillRows(skills: JsonObject): SkillRow[] {
  const source = unwrapResult(skills);
  const rows = Array.isArray(source["skills"]) ? source["skills"].filter(isJsonObject) : [];
  return rows
    .map((row) => {
      const name = pickString(row, ["name", "skill", "id"]);
      if (name === undefined) {
        return null;
      }
      const providers = Array.isArray(row["providers"])
        ? row["providers"].filter((value): value is string => typeof value === "string")
        : [];
      return { name: name.toLowerCase(), providers: providers.map((value) => value.toLowerCase()) };
    })
    .filter((row): row is SkillRow => row !== null);
}

/**
 * `orca status` と `orca skills installed` の応答から、Commander を起動してよいかを
 * 機械が読める形に落とす(テスト対象)。自動インストールはしない — 人間に
 * 実行コマンドを提示するだけ(勝手に skill を配らない)。
 *
 * `commanderAgent` を渡すと、そのエージェントが orchestration skill を読めるか
 * (`skills installed` の providers 列挙)まで見る。codex 起動なのに skill が
 * claude 側にしか無い、という状態を delegate 前に気づかせるためのもので、
 * 起動失敗を推測で埋めないための確認でもある。
 */
export function evaluateReadiness(
  status: JsonObject,
  skills: JsonObject | Error,
  commanderAgent?: string,
): JsonObject {
  const checks: ReadinessCheck[] = [];

  const statusResult = unwrapResult(status);
  const app = isJsonObject(statusResult["app"]) ? (statusResult["app"] as JsonObject) : {};
  const runtime = isJsonObject(statusResult["runtime"]) ? (statusResult["runtime"] as JsonObject) : {};
  const capabilities = capabilityList(runtime);
  const appRunning = app["running"] === true;
  const runtimeReady = runtime["reachable"] === true || runtime["state"] === "ready";
  const appVersion = pickString(runtime, ["appVersion"]) ?? null;

  checks.push({
    name: "orca runtime",
    ok: appRunning && runtimeReady,
    detail: `app.running=${String(appRunning)} runtime.state=${pickString(runtime, ["state"]) ?? "unknown"}${
      appVersion !== null ? ` appVersion=${appVersion}` : ""
    }`,
  });

  const orchestrationCapabilities = capabilities.filter((capability) =>
    capability.startsWith("orchestration."),
  );
  checks.push({
    name: "orchestration enabled",
    ok: orchestrationCapabilities.length > 0,
    detail: `capabilities: ${orchestrationCapabilities.length} orchestration.*`,
  });

  const rows = skills instanceof Error ? [] : skillRows(skills);
  if (skills instanceof Error) {
    checks.push({
      name: "orchestration skill installed",
      ok: false,
      detail: `orca skills installed が失敗: ${skills.message}`,
    });
  } else {
    checks.push({
      name: "orchestration skill installed",
      ok: rows.some((row) => row.name === REQUIRED_SKILL),
      detail: `installed skills: ${rows.length}`,
    });
  }

  if (commanderAgent !== undefined) {
    const agent = commanderAgent.toLowerCase();
    // 同じ skill 名で複数行あり得る(共有 root 由来と provider 宛てのコピーが別登録)。
    // 1 行目だけ見ると codex のような後続行を取りこぼす(実測で E2E が止まった)。
    const skillRows = rows.filter((candidate) => candidate.name === REQUIRED_SKILL);
    const providers = [...new Set(skillRows.flatMap((row) => row.providers))];
    if (skills instanceof Error) {
      checks.push({
        name: `orchestration available to ${commanderAgent}`,
        ok: false,
        detail: "skills installed が読めないため判定不能",
      });
    } else if (skillRows.length === 0) {
      checks.push({
        name: `orchestration available to ${commanderAgent}`,
        ok: false,
        detail: "orchestration skill がインストール一覧に無い",
      });
    } else if (SHARED_SKILLS_ROOT_AGENTS.has(agent)) {
      // providers 列挙はこのエージェントの読み取り経路を表現しない(共有ルートを scan する)
      checks.push({
        name: `orchestration available to ${commanderAgent}`,
        ok: true,
        detail: `共有 skills root(${SHARED_SKILLS_ROOT})経由で読み取り可能(providers 列挙: ${
          providers.length > 0 ? providers.join(", ") : "無"
        })`,
      });
    } else if (providers.length === 0) {
      // providers 列挙が無い古い CLI: 判定できないので落とさない(ノイズにしない)
      checks.push({
        name: `orchestration available to ${commanderAgent}`,
        ok: true,
        detail: "providers 列挙が無いため判定不能(インストール自体は確認済み)",
      });
    } else {
      checks.push({
        name: `orchestration available to ${commanderAgent}`,
        ok: providers.includes(agent),
        detail: `orchestration skill providers: ${providers.join(", ")}`,
      });
    }
  }

  const missing = checks.filter((check) => !check.ok).map((check) => check.name);
  const nextActions: string[] = [];
  if (missing.includes("orca runtime")) {
    nextActions.push("Run: orca open(ランタイムを起動してから orca status --json で確認)");
  }
  if (missing.includes("orchestration enabled")) {
    nextActions.push("Run: orca status --json で orchestration.* capability が並ぶか確認");
  }
  if (missing.includes("orchestration skill installed")) {
    nextActions.push("Run: orca skills install --skill orchestration");
  }
  if (commanderAgent !== undefined && missing.some((name) => name.startsWith("orchestration available to"))) {
    if (SHARED_SKILLS_ROOT_AGENTS.has(commanderAgent.toLowerCase())) {
      // このエージェントは providers 宛てのインストール対象にならない(共有ルートを scan する)
      nextActions.push(
        `確認: ${SHARED_SKILLS_ROOT}/orchestration/SKILL.md が存在するか(このエージェントは providers 宛てのインストール対象ではない)`,
      );
    } else {
      nextActions.push(`Run: orca skills install --skill orchestration --agent ${commanderAgent}`);
    }
  }

  return {
    ready: missing.length === 0,
    checks,
    missing,
    commanderAgent: commanderAgent ?? null,
    nextAction: missing.length === 0 ? "delegate 可能" : nextActions.join(" / "),
  };
}

/**
 * orca_readiness: Commander 起動の前提だけを機械的に確認する read-only 観測。
 * 起動・インストールは行わない(足りないものは nextAction として人間に提示する)。
 */
export function registerReadinessTool(server: McpServer, client: OrcaClient): void {
  server.registerTool(
    READINESS_TOOL_NAME,
    {
      title: "Orca Readiness",
      description:
        "委譲の前に、Orca ランタイムが起動しているか / orchestration が有効か / orchestration skill がインストール済みかを機械的に確認する。commanderAgent を指定すると、そのエージェントが orchestration skill を読めるか(skills installed の providers)まで見る。内部で `orca status --json` と `orca skills installed --json` を読むだけで、何も変更・インストールしない。足りないものは missing と nextAction(実行コマンド)で返す。",
      inputSchema: readinessInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input): Promise<CallToolResult> =>
      resultOf(async () => {
        const status = await client.status();
        const skills = await client.skillsInstalled().catch((error: unknown) =>
          error instanceof Error ? error : new Error(String(error)),
        );
        return evaluateReadiness(status, skills, input.commanderAgent);
      }),
  );
}
