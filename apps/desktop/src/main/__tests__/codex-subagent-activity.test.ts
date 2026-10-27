import { describe, expect, it } from "vitest";
import { subAgentActivityToolCall } from "../codex-app-server/subagent-activity";

describe("Codex worker activity adapter", () => {
  it.each([
    { model: "resolved-model", reasoningEffort: "high" },
    { model: null, reasoningEffort: null },
    {},
  ])("keeps reported metadata and accepts old records: %j", (metadata) => {
    const call = subAgentActivityToolCall({
      type: "subAgentActivity", id: "a", kind: "started",
      agentThreadId: "worker", agentPath: "/root/worker", ...metadata,
    })!;
    expect(call.model).toBe(metadata.model ?? null);
    expect(call.reasoningEffort).toBe(metadata.reasoningEffort ?? null);
  });
});
