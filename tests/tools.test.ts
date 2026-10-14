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
import { GET_RUN_TOOL_NAME, LIST_RUNS_TOOL_NAME, toRunRows } from "../src/tools/runs.js";
import {
  DELEGATE_TASK_TOOL_NAME,
  TASK_RESULT_TOOL_NAME,
  TASK_STATUS_TOOL_NAME,
} from "../src/tools/job.js";
import { CANCEL_TASK_TOOL_NAME, RESOLVE_GATE_TOOL_NAME, SEND_MESSAGE_TOOL_NAME } from "../src/tools/intervene.js";
import { READINESS_TOOL_NAME, evaluateReadiness } from "../src/tools/readiness.js";

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
    skillsInstalled: record("skillsInstalled"),
    worktreeList: record("worktreeList"),
    worktreeShow: record("worktreeShow"),
    worktreePs: record("worktreePs"),
    taskCreate: record("taskCreate"),
    taskList: record("taskList"),
    taskUpdate: record("taskUpdate"),
    dispatch: record("dispatch"),
    dispatchShow: record("dispatchShow"),
    workerStart: record("workerStart"),
    gateResolve: record("gateResolve"),
    send: record("send"),
    check: record("check"),
    reply: record("reply"),
    inbox: record("inbox"),
    runCreate: record("runCreate"),
    runCurrent: record("runCurrent"),
    runList: record("runList"),
    runShow: record("runShow"),
  };
  return { stub: stub as unknown as OrcaClient, calls };
}

describe("createServer", () => {
  it("Job API 3 + 介入 3 + 観測 read-only 7 が登録されている", () => {
    const { stub } = createStubClient();
    const server = createServer(stub);
    expect(server).toBeInstanceOf(McpServer);
    const registered = Object.keys(
      (server as unknown as RegisteredToolsAccess)._registeredTools,
    ).sort();
    expect(registered).toEqual(
      [
        DELEGATE_TASK_TOOL_NAME,
        TASK_STATUS_TOOL_NAME,
        TASK_RESULT_TOOL_NAME,
        SEND_MESSAGE_TOOL_NAME,
        CANCEL_TASK_TOOL_NAME,
        RESOLVE_GATE_TOOL_NAME,
        STATUS_TOOL_NAME,
        READINESS_TOOL_NAME,
        LIST_WORKTREES_TOOL_NAME,
        GET_WORKTREE_TOOL_NAME,
        LIST_AGENTS_TOOL_NAME,
        LIST_RUNS_TOOL_NAME,
        GET_RUN_TOOL_NAME,
      ].sort(),
    );
  });

  it("低レベルすぎる API と未登録の足場を公開していない", () => {
    const { stub } = createStubClient();
    const registered = Object.keys(
      (createServer(stub) as unknown as RegisteredToolsAccess)._registeredTools,
    );
    for (const hidden of [
      "orca_delegate",
      "orca_message",
      "orca_create_worktree",
      "orca_start_agent",
      "orca_send_terminal",
      "orca_terminal_send",
      "orca_terminal_create",
      "orca_worker_stop",
      "orca_worker_start",
      "orca_task_update",
      "orca_gate_create",
      "orca_run_use",
      "orca_skills_install",
    ]) {
      expect(registered).not.toContain(hidden);
    }
  });

  it("変更系ツールの annotations: submit と cancel は destructive、send / resolve_gate は非破壊", () => {
    const { stub } = createStubClient();
    const tools = (createServer(stub) as unknown as RegisteredToolsAccess)._registeredTools;
    const annotationsOf = (name: string) =>
      (tools[name] as { annotations?: Record<string, boolean> }).annotations;
    expect(annotationsOf(DELEGATE_TASK_TOOL_NAME)).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
    expect(annotationsOf(CANCEL_TASK_TOOL_NAME)).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
    expect(annotationsOf(SEND_MESSAGE_TOOL_NAME)).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    });
    expect(annotationsOf(RESOLVE_GATE_TOOL_NAME)).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    });
    expect(annotationsOf(TASK_STATUS_TOOL_NAME)).toMatchObject({ readOnlyHint: true });
    expect(annotationsOf(READINESS_TOOL_NAME)).toMatchObject({ readOnlyHint: true });
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

describe("evaluateReadiness", () => {
  const readyStatus: JsonObject = {
    ok: true,
    result: {
      app: { running: true },
      runtime: { state: "ready", reachable: true, appVersion: "1.4.220", capabilities: ["orchestration.contract.v1"] },
    },
  };
  const skillsWithOrchestration: JsonObject = {
    ok: true,
    result: { skills: [{ name: "orchestration" }, { name: "orca-cli" }] },
  };

  it("ランタイム / orchestration / skill が揃っていれば ready", () => {
    const view = evaluateReadiness(readyStatus, skillsWithOrchestration);
    expect(view["ready"]).toBe(true);
    expect(view["missing"]).toEqual([]);
    expect(view["nextAction"]).toBe("delegate 可能");
    expect(view["checks"]).toHaveLength(3);
  });

  it("orchestration skill が無いと missing と nextAction にインストールコマンド", () => {
    const view = evaluateReadiness(readyStatus, { ok: true, result: { skills: [{ name: "orca-cli" }] } });
    expect(view["ready"]).toBe(false);
    expect(view["missing"]).toEqual(["orchestration skill installed"]);
    expect(view["nextAction"]).toContain("orca skills install --skill orchestration");
  });

  it("ランタイム未起動を missing に並べ、実行コマンドを nextAction で促す(自動では何もしない)", () => {
    const view = evaluateReadiness(
      { ok: true, result: { app: { running: false }, runtime: { state: "stopped", capabilities: [] } } },
      new Error("runtime_unavailable"),
    );
    expect(view["ready"]).toBe(false);
    expect(view["missing"]).toEqual([
      "orca runtime",
      "orchestration enabled",
      "orchestration skill installed",
    ]);
    expect(view["nextAction"]).toContain("orca open");
    // skills installed が失敗したことは check の detail としてそのまま見える(隠さない)
    expect(JSON.stringify(view)).toContain("runtime_unavailable");
  });

  it("commanderAgent が skill を読めない場合は missing に出し、そのエージェント向けのコマンドを促す", () => {
    const claudeOnly: JsonObject = {
      ok: true,
      result: { skills: [{ name: "orchestration", providers: ["agent-skills", "claude"] }] },
    };
    const view = evaluateReadiness(readyStatus, claudeOnly, "codex");
    expect(view["ready"]).toBe(false);
    expect(view["missing"]).toEqual(["orchestration available to codex"]);
    expect(view["nextAction"]).toContain("orca skills install --skill orchestration --agent codex");
    expect(JSON.stringify(view["checks"])).toContain("agent-skills, claude");
  });

  it("commanderAgent が providers に含まれていれば ready", () => {
    const claudeOnly: JsonObject = {
      ok: true,
      result: { skills: [{ name: "orchestration", providers: ["agent-skills", "claude"] }] },
    };
    expect(evaluateReadiness(readyStatus, claudeOnly, "claude")["ready"]).toBe(true);
  });

  it("providers 列挙が無い古い CLI では落とさない(判定不能を ok に寄せる)", () => {
    const noProviders: JsonObject = { ok: true, result: { skills: [{ name: "orchestration" }] } };
    const view = evaluateReadiness(readyStatus, noProviders, "codex");
    expect(view["ready"]).toBe(true);
    expect(view["missing"]).toEqual([]);
    expect(JSON.stringify(view["checks"])).toContain("判定不能");
  });

  it("dsh は共有 skills root を読むので providers 列挙に無くても落とさない", () => {
    const claudeOnly: JsonObject = {
      ok: true,
      result: { skills: [{ name: "orchestration", providers: ["agent-skills", "claude", "codex"] }] },
    };
    const view = evaluateReadiness(readyStatus, claudeOnly, "dsh");
    expect(view["ready"]).toBe(true);
    expect(view["missing"]).toEqual([]);
    expect(JSON.stringify(view["checks"])).toContain("共有 skills root");
  });

  it("dsh で skill が無いときは共有 skills root の確認を促す(--agent dsh を勧めない)", () => {
    const noOrchestration: JsonObject = { ok: true, result: { skills: [{ name: "orca-cli" }] } };
    const view = evaluateReadiness(readyStatus, noOrchestration, "dsh");
    expect(view["ready"]).toBe(false);
    expect(view["missing"]).toContain("orchestration available to dsh");
    expect(view["nextAction"]).toContain("~/.agents/skills/orchestration/SKILL.md");
    expect(view["nextAction"]).not.toContain("--agent dsh");
  });

  it("copilot も共有 skills root を読むので providers 列挙に無くても落とさない(実測: copilot skill list)", () => {
    const claudeOnly: JsonObject = {
      ok: true,
      result: { skills: [{ name: "orchestration", providers: ["agent-skills", "claude", "codex"] }] },
    };
    const view = evaluateReadiness(readyStatus, claudeOnly, "copilot");
    expect(view["ready"]).toBe(true);
    expect(view["missing"]).toEqual([]);
    expect(JSON.stringify(view["checks"])).toContain("共有 skills root");
  });

  it("copilot で skill が無いときは共有 skills root の確認を促す(--agent copilot を勧めない)", () => {
    // 実測: `orca skills install --agent copilot` は skills CLI 側の agent 名が
    // github-copilot なので "Invalid agents: copilot" で落ちる(exit 1)。
    const noOrchestration: JsonObject = { ok: true, result: { skills: [{ name: "orca-cli" }] } };
    const view = evaluateReadiness(readyStatus, noOrchestration, "copilot");
    expect(view["ready"]).toBe(false);
    expect(view["missing"]).toContain("orchestration available to copilot");
    expect(view["nextAction"]).toContain("~/.agents/skills/orchestration/SKILL.md");
    expect(view["nextAction"]).not.toContain("--agent copilot");
  });

  it("同じ skill 名の複数行を union して判定する(共有 root 行 + provider 宛て行)", () => {
    // 実機で codex 宛ての導入後に providers が 2 行へ分かれた。1 行目だけ見ると false negative。
    const splitRows: JsonObject = {
      ok: true,
      result: {
        skills: [
          { name: "orchestration", providers: ["agent-skills", "claude"] },
          { name: "orchestration", providers: ["codex"] },
        ],
      },
    };
    expect(evaluateReadiness(readyStatus, splitRows, "codex")["ready"]).toBe(true);
    expect(evaluateReadiness(readyStatus, splitRows, "claude")["ready"]).toBe(true);
    expect(evaluateReadiness(readyStatus, splitRows, "cursor")["ready"]).toBe(false);
  });

  it("commanderAgent 指定時は checks に 4 項目目が並ぶ", () => {
    const view = evaluateReadiness(readyStatus, skillsWithOrchestration, "codex");
    expect(view["checks"]).toHaveLength(4);
    expect(view["commanderAgent"]).toBe("codex");
  });
});

describe("toRunRows — run 観測の正規化", () => {
  it("run-list 応答を { runId, objective, coordinatorHandle, createdAt } に正規化する", () => {
    const rows = toRunRows({
      ok: true,
      result: {
        runs: [
          { id: "run_8d1d20524d42", objective: "sub", coordinator_handle: "term_30746ff6", created_at: "2026-10-13T06:53:49Z" },
          { id: "run_7652809742db", objective: "smoke", coordinator_handle: null, created_at: "2026-10-13T03:19:47Z" },
        ],
        nextCursor: "eyJpZCI6MX0",
      },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      runId: "run_8d1d20524d42",
      objective: "sub",
      coordinatorHandle: "term_30746ff6",
      createdAt: "2026-10-13T06:53:49Z",
    });
    expect(rows[1]?.["coordinatorHandle"]).toBeNull();
  });

  it("run-show 応答(result.run 単一)も 1 行に揃える", () => {
    expect(toRunRows({ ok: true, result: { run: { id: "run_a", objective: "goal" } } })).toMatchObject([
      { runId: "run_a", objective: "goal" },
    ]);
  });
});

describe("runMessageAction", () => {  it("action ごとにクライアントメソッドへ転送する", async () => {
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
