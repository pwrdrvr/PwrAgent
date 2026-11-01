import { describe, expect, it } from "vitest";
import {
  FORGE_APPROVAL_REMEMBER_CHOICE_META_KEY,
  FORGE_APPROVAL_REMEMBER_OPTIONS_META_KEY,
} from "@pwragent/shared";
import { createMcpElicitationState } from "../../thread-detail/mcp-elicitation";
import { approvalChoices } from "../approval-choices";
import type { OperatorWait } from "../operator-waits";

function forgeWait(meta: Record<string, unknown>): OperatorWait {
  const mcp = createMcpElicitationState({
    method: "mcpServer/elicitation/request",
    params: {
      threadId: "thread-1", turnId: "turn-1", requestId: "forge-tool:fixture",
      serverName: "GitHub", mode: "form", message: "Rerun failed CI jobs in pwrdrvr/PwrAgent?",
      requestedSchema: { type: "object", properties: {} },
      _meta: { pwragent_approval_kind: "mcp_tool_call", ...meta },
    },
  })!;
  return {
    key: "codex:thread-1:forge-tool:fixture",
    kind: "mcp-approval",
    backend: "codex",
    threadId: "thread-1",
    threadKey: "codex:thread-1",
    title: mcp.message,
    createdAt: 0,
    mcp,
  };
}

describe("approvalChoices for a forge approval", () => {
  it("offers each remembered rule as an Allow answer that carries its option id", () => {
    const choices = approvalChoices(forgeWait({
      [FORGE_APPROVAL_REMEMBER_OPTIONS_META_KEY]: [
        { id: "agent", label: "Always allow Codex in pwrdrvr/PwrAgent", description: "" },
        { id: "agent_model", label: "Always allow gpt-5.5 in pwrdrvr/PwrAgent", description: "" },
      ],
    }))!;

    expect(choices.alternatives.map((choice) => choice.label)).toEqual([
      "Always allow Codex in pwrdrvr/PwrAgent",
      "Always allow gpt-5.5 in pwrdrvr/PwrAgent",
      "Cancel turn",
    ]);
    const remember = choices.alternatives.find((choice) => choice.id === "remember:agent_model")!;
    expect(remember.effect).toBe("allow");
    expect(remember.buildResponse()).toEqual({
      action: "accept",
      content: {},
      _meta: { [FORGE_APPROVAL_REMEMBER_CHOICE_META_KEY]: "agent_model" },
    });
    expect(choices.accept?.buildResponse()).toEqual({ action: "accept", content: {}, _meta: null });
    expect(choices.decline?.buildResponse()).toEqual({ action: "decline", content: null, _meta: null });
  });

  it("adds nothing when the request offers no rule", () => {
    const choices = approvalChoices(forgeWait({}))!;
    expect(choices.alternatives.map((choice) => choice.id)).toEqual(["cancel"]);
  });
});
