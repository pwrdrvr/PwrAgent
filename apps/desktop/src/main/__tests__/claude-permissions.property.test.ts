import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { CLAUDE_MCP_GATEWAY_TOOL, createClaudePermissionHandler } from "../claude/claude-permissions";

const input = { connectionId: "fixture", toolName: "lookup", schemaRevision: "r1", arguments: {} };
const context = (): Parameters<CanUseTool>[2] => ({
  signal: new AbortController().signal, toolUseID: "tool", requestId: "sdk-request",
  mcpServer: { name: "pwragent", source: "sdk" },
});

describe("Claude plan gateway approval properties", () => {
  it("preserves the ordinary human approval path whenever an operator ask rule matched", async () => {
    await fc.assert(fc.asyncProperty(fc.record({
      source: fc.constantFrom("user", "project", "local", "managed"),
      toolName: fc.constantFrom(CLAUDE_MCP_GATEWAY_TOOL, "mcp__pwragent__*"),
      ruleContent: fc.option(fc.string(), { nil: undefined }),
    }), async (matchedAskRule) => {
      // The ordinary permission bridge is the oracle for every human decision.
      // Plan mode must not turn a rule-forced denial into an automatic allow.
      for (const decision of ["accept", "approve", "decline", "cancel", undefined]) {
        const request = vi.fn().mockResolvedValue({ decision });
        const handler = (plan: boolean) => createClaudePermissionHandler({
          threadId: "thread", turnId: () => "turn", planTurn: () => plan,
          request, cancelRequest: async () => {},
        });
        const callContext = { ...context(), matchedAskRule };
        const ordinary = await handler(false)(CLAUDE_MCP_GATEWAY_TOOL, input, callContext);
        const plan = await handler(true)(CLAUDE_MCP_GATEWAY_TOOL, input, callContext);
        expect(request).toHaveBeenCalledTimes(2);
        expect(plan).toEqual(ordinary);
        expect(request.mock.calls[1]?.[0]).toMatchObject({
          method: "item/commandExecution/requestApproval",
          params: { toolName: CLAUDE_MCP_GATEWAY_TOOL, arguments: input },
        });
      }
    }));
  });

  it("never grants the shortcut to a server whose host origin is unverified", async () => {
    const untrustedSource = fc.oneof(
      fc.constantFrom("project", "user", "plugin", "local", "dynamic", "managed"),
      fc.string().filter((source) => source !== "sdk"),
    );
    const unverifiedServer = fc.option(fc.oneof(
      fc.record({ name: fc.constant("pwragent"), source: untrustedSource }),
      fc.record({ name: fc.string().filter((name) => name !== "pwragent"), source: fc.constant("sdk") }),
    ), { nil: undefined });
    await fc.assert(fc.asyncProperty(unverifiedServer, async (mcpServer) => {
      // Server names are configuration text. Even an exact tool-name match
      // cannot replace the SDK's host-origin assertion; absent metadata asks too.
      const request = vi.fn().mockResolvedValue({ decision: "decline" });
      const handler = createClaudePermissionHandler({
        threadId: "thread", turnId: () => "turn", planTurn: () => true,
        request, cancelRequest: async () => {},
      });
      const result = await handler(CLAUDE_MCP_GATEWAY_TOOL, input, { ...context(), mcpServer });
      expect(request).toHaveBeenCalledOnce();
      expect(result).toMatchObject({ behavior: "deny" });
    }));
  });
});
