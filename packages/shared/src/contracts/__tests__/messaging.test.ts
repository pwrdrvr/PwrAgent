import { describe, expect, it } from "vitest";

import {
  MESSAGING_BINDING_TARGET_KINDS,
  isMessagingBindingTargetKind,
  normalizeMessagingBindingTargetKind,
} from "../messaging";

describe("messaging contracts", () => {
  it("defines thread and agent-thread binding target kinds", () => {
    expect(MESSAGING_BINDING_TARGET_KINDS).toEqual(["thread", "agent_thread"]);
    expect(isMessagingBindingTargetKind("thread")).toBe(true);
    expect(isMessagingBindingTargetKind("agent_thread")).toBe(true);
    expect(isMessagingBindingTargetKind("automation")).toBe(false);
  });

  it("normalizes unknown binding target kinds to ordinary threads", () => {
    expect(normalizeMessagingBindingTargetKind("agent_thread")).toBe(
      "agent_thread",
    );
    expect(normalizeMessagingBindingTargetKind(undefined)).toBe("thread");
    expect(normalizeMessagingBindingTargetKind("")).toBe("thread");
  });
});
