import { describe, expect, it } from "vitest";
import {
  delegateInputSchema,
  messageInputSchema,
  taskStatusInputSchema,
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

describe("taskStatusInputSchema", () => {
  it("brief の既定は true", () => {
    expect(taskStatusInputSchema.parse({}).brief).toBe(true);
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
