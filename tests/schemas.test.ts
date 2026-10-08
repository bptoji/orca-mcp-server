import { describe, expect, it } from "vitest";
import {
  cancelTaskInputSchema,
  delegateInputSchema,
  delegateTaskInputSchema,
  getTaskResultInputSchema,
  getTaskStatusInputSchema,
  getWorktreeInputSchema,
  listAgentsInputSchema,
  listWorktreesInputSchema,
  messageInputSchema,
  readinessInputSchema,
  resolveGateInputSchema,
  sendMessageInputSchema,
} from "../src/orca/schemas.js";

describe("delegateInputSchema", () => {
  it("spec と to が必須", () => {
    expect(delegateInputSchema.safeParse({ to: "term_1" }).success).toBe(false);
    expect(delegateInputSchema.safeParse({ spec: "docs 更新" }).success).toBe(false);
    expect(
      delegateInputSchema.safeParse({ spec: "docs 更新", to: "term_1" }).success,
    ).toBe(true);
  });

  it("inject の既定は false", () => {
    const parsed = delegateInputSchema.parse({ spec: "a", to: "term_1" });
    expect(parsed.inject).toBe(false);
  });
});

describe("getTaskStatusInputSchema", () => {
  it("taskId が必須(空文字は拒否)", () => {
    expect(getTaskStatusInputSchema.safeParse({}).success).toBe(false);
    expect(getTaskStatusInputSchema.safeParse({ taskId: "" }).success).toBe(false);
    expect(getTaskStatusInputSchema.safeParse({ taskId: "task_abc123" }).success).toBe(true);
  });

  it("run は任意", () => {
    const parsed = getTaskStatusInputSchema.parse({ taskId: "t1", run: "run_1" });
    expect(parsed.taskId).toBe("t1");
    expect(parsed.run).toBe("run_1");
  });
});

describe("delegateTaskInputSchema", () => {
  it("spec だけ必須(低レベルな target 指定は公開していない)", () => {
    expect(delegateTaskInputSchema.safeParse({}).success).toBe(false);
    expect(delegateTaskInputSchema.safeParse({ spec: "README を更新" }).success).toBe(true);
  });

  it("commanderAgent の既定は codex", () => {
    expect(delegateTaskInputSchema.parse({ spec: "a" }).commanderAgent).toBe("codex");
    expect(delegateTaskInputSchema.parse({ spec: "a", commanderAgent: "claude" }).commanderAgent).toBe("claude");
  });

  it("constraints は文字列配列(1 本の prompt は受け付けない)", () => {
    expect(delegateTaskInputSchema.safeParse({ spec: "a", constraints: ["既存APIを変更しない"] }).success).toBe(true);
    expect(delegateTaskInputSchema.safeParse({ spec: "a", constraints: [] }).success).toBe(true);
    expect(delegateTaskInputSchema.safeParse({ spec: "a", constraints: "テストを追加する" }).success).toBe(false);
    expect(delegateTaskInputSchema.safeParse({ spec: "a", constraints: [1] }).success).toBe(false);
  });

  it("deps は文字列配列", () => {
    expect(delegateTaskInputSchema.safeParse({ spec: "a", deps: ["t1", "t2"] }).success).toBe(true);
    expect(delegateTaskInputSchema.safeParse({ spec: "a", deps: [1] }).success).toBe(false);
  });

  it("terminal / worktree / prompt / agent は公開していない(strictObject で拒否)", () => {
    for (const key of ["terminal", "worktree", "prompt", "agent"]) {
      expect(delegateTaskInputSchema.safeParse({ spec: "a", [key]: "x" }).success).toBe(false);
    }
  });
});

describe("resolveGateInputSchema", () => {
  it("gateId / resolution / run が必須(gate は Run バインドスコープ)", () => {
    expect(resolveGateInputSchema.safeParse({}).success).toBe(false);
    expect(resolveGateInputSchema.safeParse({ gateId: "g1", resolution: "approve" }).success).toBe(false);
    expect(resolveGateInputSchema.safeParse({ gateId: "", resolution: "approve", run: "r1" }).success).toBe(false);
    expect(
      resolveGateInputSchema.safeParse({ gateId: "g1", resolution: "approve", run: "r1" }).success,
    ).toBe(true);
  });
});

describe("getTaskResultInputSchema", () => {
  it("taskId が必須、outputLimit は 1..200", () => {
    expect(getTaskResultInputSchema.safeParse({}).success).toBe(false);
    expect(getTaskResultInputSchema.safeParse({ taskId: "t1", outputLimit: 40 }).success).toBe(true);
    expect(getTaskResultInputSchema.safeParse({ taskId: "t1", outputLimit: 201 }).success).toBe(false);
  });

  it("includeChildren の既定は false(既定で応答を膨らませない)", () => {
    expect(getTaskResultInputSchema.parse({ taskId: "t1" }).includeChildren).toBe(false);
    expect(getTaskResultInputSchema.parse({ taskId: "t1", includeChildren: true }).includeChildren).toBe(true);
  });
});

describe("readinessInputSchema", () => {
  it("全て任意(commanderAgent は省略できる)", () => {
    expect(readinessInputSchema.safeParse({}).success).toBe(true);
    expect(readinessInputSchema.safeParse({ commanderAgent: "codex" }).success).toBe(true);
    expect(readinessInputSchema.safeParse({ commanderAgent: "" }).success).toBe(false);
    expect(readinessInputSchema.safeParse({ agent: "codex" }).success).toBe(false);
  });
});

describe("listWorktreesInputSchema", () => {
  it("全て任意(repo / limit のみ受け付ける)", () => {
    expect(listWorktreesInputSchema.safeParse({}).success).toBe(true);
    expect(listWorktreesInputSchema.safeParse({ repo: "name:orca-mcp", limit: 10 }).success).toBe(
      true,
    );
    expect(listWorktreesInputSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(listWorktreesInputSchema.safeParse({ limit: 201 }).success).toBe(false);
    expect(listWorktreesInputSchema.safeParse({ limit: 1.5 }).success).toBe(false);
    expect(listWorktreesInputSchema.safeParse({ unknown: "x" }).success).toBe(true);
  });
});

describe("getWorktreeInputSchema", () => {
  it("worktree が必須で空文字は拒否", () => {
    expect(getWorktreeInputSchema.safeParse({}).success).toBe(false);
    expect(getWorktreeInputSchema.safeParse({ worktree: "" }).success).toBe(false);
    expect(getWorktreeInputSchema.safeParse({ worktree: "active" }).success).toBe(true);
    expect(getWorktreeInputSchema.safeParse({ worktree: "branch:main" }).success).toBe(true);
  });
});

describe("listAgentsInputSchema", () => {
  it("full の既定は false(大きな欄を既定で返さない)", () => {
    expect(listAgentsInputSchema.parse({}).full).toBe(false);
  });

  it("limit は 1..200 の整数", () => {
    expect(listAgentsInputSchema.safeParse({ limit: 200 }).success).toBe(true);
    expect(listAgentsInputSchema.safeParse({ limit: 201 }).success).toBe(false);
  });

  it("worktree / state 絞り込みは任意の文字列", () => {
    const parsed = listAgentsInputSchema.parse({ worktree: "orca-mcp", state: "working" });
    expect(parsed.worktree).toBe("orca-mcp");
    expect(parsed.state).toBe("working");
  });
});

describe("sendMessageInputSchema", () => {
  it("subject だけ必須", () => {
    expect(sendMessageInputSchema.safeParse({}).success).toBe(false);
    expect(sendMessageInputSchema.safeParse({ subject: "方針変更" }).success).toBe(true);
  });

  it("type は CLI が受け付ける種別の列挙に限定する", () => {
    expect(sendMessageInputSchema.safeParse({ subject: "a", type: "escalation" }).success).toBe(true);
    expect(sendMessageInputSchema.safeParse({ subject: "a", type: "broadcast" }).success).toBe(false);
  });

  it("outcome は succeeded / failed のみ", () => {
    expect(
      sendMessageInputSchema.safeParse({ subject: "a", type: "worker_done", outcome: "succeeded" })
        .success,
    ).toBe(true);
    expect(
      sendMessageInputSchema.safeParse({ subject: "a", outcome: "maybe" }).success,
    ).toBe(false);
  });
});

describe("cancelTaskInputSchema", () => {
  it("taskId が必須、mode の既定は stop", () => {
    expect(cancelTaskInputSchema.safeParse({}).success).toBe(false);
    expect(cancelTaskInputSchema.parse({ taskId: "t1" }).mode).toBe("stop");
  });

  it("mode は stop / abandon のみ", () => {
    expect(cancelTaskInputSchema.safeParse({ taskId: "t1", mode: "abandon" }).success).toBe(true);
    expect(cancelTaskInputSchema.safeParse({ taskId: "t1", mode: "nuke" }).success).toBe(false);
  });

  it("cascade の既定は true(既定で子孫まで止める)", () => {
    expect(cancelTaskInputSchema.parse({ taskId: "t1" }).cascade).toBe(true);
    expect(cancelTaskInputSchema.parse({ taskId: "t1", cascade: false }).cascade).toBe(false);
  });

  it("strict なので未知のキー(terminal / force など)は拒否する", () => {
    expect(cancelTaskInputSchema.safeParse({ taskId: "t1", terminal: "term_1" }).success).toBe(false);
    expect(cancelTaskInputSchema.safeParse({ taskId: "t1", force: true }).success).toBe(false);
  });
});

describe("messageInputSchema", () => {
  it("action ごとに必須キーを検証する", () => {
    expect(messageInputSchema.safeParse({ action: "send", subject: "hi" }).success).toBe(true);
    expect(messageInputSchema.safeParse({ action: "send" }).success).toBe(false);
    expect(messageInputSchema.safeParse({ action: "reply", id: "m1", body: "ok" }).success).toBe(
      true,
    );
    expect(messageInputSchema.safeParse({ action: "check" }).success).toBe(true);
    expect(messageInputSchema.safeParse({ action: "inbox" }).success).toBe(true);
  });

  it("未知の action は拒否する", () => {
    expect(messageInputSchema.safeParse({ action: "broadcast" }).success).toBe(false);
  });

  it("check の mode 既定は unread", () => {
    const parsed = messageInputSchema.parse({ action: "check" });
    expect(parsed.action === "check" && parsed.mode).toBe("unread");
  });
});
