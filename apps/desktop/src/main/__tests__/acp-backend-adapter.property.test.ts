import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import { FakeAcpAgentTransport } from "../acp/testing/fake-acp-agent";
import { AcpBackendAdapter } from "../app-server/acp-backend-adapter";
import { createAcpAgentStoreMock, createAcpSessionStoreMock } from "./helpers/backend-registry-fixture";

describe("Antigravity result usage", () => {
  it("emits normalized Antigravity session/prompt result usage with the selected model", async () => {
    await checkAntigravityPromptUsage({ reply: ["hello world"], stopReason: "end_turn", outputTokens: 541 });
  });

  it("emits Antigravity usage before failing a turn that exhausts its output budget without a reply", async () => {
    await checkAntigravityPromptUsage({ reply: [], stopReason: "max_tokens", outputTokens: 1 });
  });

  it("delivers Antigravity's reported usage exactly once before failing any prompt without visible text", async () => {
    await fc.assert(fc.asyncProperty(
      fc.constantFrom(undefined, "", " \n"),
      fc.constantFrom("end_turn", "max_tokens"),
      fc.integer({ min: 0, max: 10_000 }),
      async (reply, stopReason, outputTokens) => {
        await checkAntigravityPromptUsage({
          reply: reply === undefined ? [] : [reply],
          stopReason,
          outputTokens,
        });
      },
    ), { numRuns: 25 });
  });

  it("streams assistant chunks without an adapter session lookup for each delta", async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.stringMatching(/^[a-z]{1,20}$/u), { minLength: 1, maxLength: 10 }),
      async (reply) => {
        await checkAntigravityPromptUsage({ reply, stopReason: "end_turn", outputTokens: 541 });
      },
    ), { numRuns: 25 });
  });

  async function checkAntigravityPromptUsage({ reply, stopReason, outputTokens }: {
    reply: string[];
    stopReason: string;
    outputTokens: number;
  }): Promise<void> {
    const backendId = "acp:antigravity";
    const promptResponse = Promise.withResolvers<unknown>();
    const transport = new FakeAcpAgentTransport({
      "session/prompt": promptResponse.promise,
    });
    const events: AgentEvent[] = [];
    const terminal = Promise.withResolvers<void>();
    const terminalMethod = reply.join("").trim() ? "turn/completed" : "turn/failed";
    const adapter = new AcpBackendAdapter({
      discoverLocalAcpAgents: async () => [],
      acpAgentStore: createAcpAgentStoreMock([{
        backendId,
        registryId: "antigravity",
        name: "Antigravity",
        distributionKind: "local",
        distributionSource: "agy",
        installStatus: "installed",
        authStatus: "not-required",
        verificationStatus: "not-applicable",
        allowlistRuleId: "local-antigravity-cli",
        installedAt: 1000,
        updatedAt: 1000,
        launchDescriptor: {
          backendId,
          registryId: "antigravity",
          distributionKind: "local",
          command: "agy",
          args: ["acp", "--process-per-session"],
          env: {},
        },
      }]),
      acpSessionStore: createAcpSessionStoreMock([]),
      captureStores: [],
      createAcpTransport: () => transport,
      emit: async (event) => {
        events.push(event);
        if (event.notification.method === "turn/completed" || event.notification.method === "turn/failed") {
          terminal.resolve();
        }
      },
      handleServerRequest: async () => ({ decision: "accept" }),
    });

    try {
      const client = await adapter.getClient(backendId);
      const session = await client.startSession({
        cwd: "/repo",
        executionMode: "default",
        acpRuntime: { currentModelId: "gemini-4-neon" },
      });
      await client.startPrompt({
        sessionId: session.sessionId,
        prompt: "Read hello.txt",
        turnId: "turn-antigravity-usage",
      });
      const getSession = vi.spyOn(adapter, "getSession");
      for (const chunk of reply) {
        transport.emitSessionUpdate(session.sessionId, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: chunk },
        });
      }
      expect(getSession).not.toHaveBeenCalled();
      getSession.mockRestore();
      const thoughtTokens = Math.min(436, outputTokens);
      const totalTokens = 29_161 + outputTokens;
      promptResponse.resolve({
        stopReason,
        usage: {
          inputTokens: 16_793,
          outputTokens,
          cachedReadTokens: 12_368,
          cachedWriteTokens: 0,
          thoughtTokens,
          totalTokens,
        },
      });
      await terminal.promise;

      if (terminalMethod === "turn/completed") {
        const deltas = events.flatMap(({ notification }) =>
          notification.method === "item/agentMessage/delta" ? [notification.params.delta] : [],
        );
        expect(deltas).toEqual(reply);
      }

      const usageAndTerminal = events.filter(({ notification }) =>
        notification.method === "thread/tokenUsage/updated"
        || notification.method === "turn/completed"
        || notification.method === "turn/failed",
      );
      expect(usageAndTerminal.map(({ notification }) => notification.method)).toEqual([
        "thread/tokenUsage/updated",
        terminalMethod,
      ]);
      expect(usageAndTerminal[0]).toEqual({
        backend: backendId,
        notification: {
          method: "thread/tokenUsage/updated",
          params: {
            threadId: session.sessionId,
            turnId: "turn-antigravity-usage",
            model: "gemini-4-neon",
            tokenUsage: {
              last_token_usage: {
                input_tokens: 29_161,
                cached_input_tokens: 12_368,
                output_tokens: outputTokens,
                reasoning_output_tokens: thoughtTokens,
                total_tokens: totalTokens,
              },
            },
          },
        },
      });
    } finally {
      promptResponse.resolve({ stopReason: "cancelled" });
      await adapter.close();
    }
  }
});
