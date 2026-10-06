import { describe, expect, it } from "vitest";
import {
  delegateInputSchema,
  getTaskStatusInputSchema,
  getWorktreeInputSchema,
  listAgentsInputSchema,
  listWorktreesInputSchema,
  messageInputSchema,
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
  it("brief の既定は true", () => {
    expect(getTaskStatusInputSchema.parse({}).brief).toBe(true);
  });

  it("id / status / run / from は任意", () => {
    const parsed = getTaskStatusInputSchema.parse({
      id: "t1",
      status: "ready",
      run: "run_legacy_local",
      from: "term_1",
    });
    expect(parsed.id).toBe("t1");
    expect(parsed.status).toBe("ready");
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
