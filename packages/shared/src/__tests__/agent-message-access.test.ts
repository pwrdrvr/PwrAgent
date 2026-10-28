import { describe, expect, it } from "vitest";
import {
  agentMessageAccessRefusalMessage,
  isAgentMessageAccessRefusal,
} from "../agent-message-access";

describe("agent message access refusal", () => {
  it("names both modes in a refusal that the sender can recognize", () => {
    const message = agentMessageAccessRefusalMessage({
      senderExecutionMode: "default",
      targetExecutionMode: "full-access",
    });
    expect(message).toContain("Default Access");
    expect(message).toContain("Full Access");
    expect(message).toContain("add_todo");
    expect(isAgentMessageAccessRefusal(message)).toBe(true);
    expect(isAgentMessageAccessRefusal("Thread not found: t-1")).toBe(false);
  });
});
