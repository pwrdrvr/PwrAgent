import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { RestrictedAgentCapabilityPolicy } from "@pwragent/shared/contracts/agent-capability-policy";
import type { AppServerTurnInputItem } from "@pwragent/shared/contracts/normalized-app-server";
import { createDesktopBackendRegistry } from "../app-server/backend-registry-wiring";
import { createAgentOverlay, createOverlayStoreMock, MockBackendClient } from "./helpers/backend-registry-fixture";

const restricted: RestrictedAgentCapabilityPolicy = {
  version: 1,
  mode: "restricted",
  executionModeCeiling: "default",
  workspaceRoots: [{ path: "/work/jira", access: "read" }],
  executables: [{ path: "/usr/bin/jira", approval: "prompt" }],
  mcpServers: [],
  skills: ["jira"],
  networkOrigins: [],
};

const input: AppServerTurnInputItem[] = [{ type: "text", text: "Check the ticket." }];

describe("Agent capability admission at the owner", () => {
  it("never hands off a restricted turn or child, regardless of requested mode and cwd", async () => {
    const agentOverlay = createAgentOverlay();
    const identity = { backend: agentOverlay.backend, threadId: agentOverlay.threadId };
    const client = new MockBackendClient({ initializeResult: { methods: ["thread/start", "turn/start"] } });
    const registry = createDesktopBackendRegistry({
      codexClient: client,
      overlayStore: createOverlayStoreMock({
        overlays: {
          [`${identity.backend}:${identity.threadId}`]: {
            ...agentOverlay,
            agent: { ...agentOverlay.agent!, capabilityPolicy: restricted },
          },
        },
      }),
    });
    try {
      await fc.assert(fc.asyncProperty(
        fc.constantFrom("default", "auto", "full-access"),
        fc.constantFrom("/work/jira", "/work/other"),
        async (executionMode, cwd) => {
          await expect(registry.startTurn({ ...identity, input, executionMode }))
            .rejects.toThrow("interactive execution");
          await expect(registry.startAutomationHeadlessTurn({
            backend: identity.backend, agentThreadId: identity.threadId,
            automationRunId: "test-run", input, executionMode, cwd,
          })).rejects.toThrow("automation execution");
          await expect(registry.startThread({
            backend: "codex", parentThreadId: identity.threadId, executionMode, cwd,
          })).rejects.toThrow("child execution");
          await expect(registry.forkThread({
            backend: "codex", sourceThreadId: identity.threadId, executionMode,
          })).rejects.toThrow("child execution");
          expect(client.lastStartThreadParams).toBeUndefined();
          expect(client.startTurnCalls).toHaveLength(0);
        },
      ), { numRuns: 18 });
      await expect(registry.setThreadExecutionMode({ ...identity, executionMode: "full-access" }))
        .rejects.toThrow("interactive execution");
      await expect(registry.setThreadAgent({ ...identity, agent: null }))
        .rejects.toThrow("interactive execution");
      const review = { ...identity, target: { type: "uncommittedChanges" as const } };
      await expect(registry.startReview(review)).rejects.toThrow("child execution");
      await expect(registry.submitReview(review)).rejects.toThrow("child execution");
    } finally {
      await registry.close();
    }
  });

  it("refuses a restricted Agent at creation before the provider receives a start request", async () => {
    const client = new MockBackendClient({ initializeResult: { methods: ["thread/start", "turn/start"] } });
    const registry = createDesktopBackendRegistry({ codexClient: client, overlayStore: createOverlayStoreMock() });
    try {
      await expect(registry.startThread({
        backend: "codex",
        agent: { name: "Jira Agent", capabilityPolicy: restricted },
      })).rejects.toThrow("interactive execution");
      expect(client.lastStartThreadParams).toBeUndefined();
    } finally {
      await registry.close();
    }
  });

  it.each([undefined, { version: 1, mode: "legacy" } as const])(
    "starts an automation using the provider's existing settings for legacy policy %j",
    async (capabilityPolicy) => {
      const agentOverlay = createAgentOverlay();
      const client = new MockBackendClient({ initializeResult: { methods: ["thread/start", "turn/start"] } });
      const registry = createDesktopBackendRegistry({
        codexClient: client,
        overlayStore: createOverlayStoreMock({
          overlays: {
            [`codex:${agentOverlay.threadId}`]: {
              ...agentOverlay,
              agent: { ...agentOverlay.agent!, capabilityPolicy },
            },
          },
        }),
      });
      try {
        await expect(registry.startAutomationHeadlessTurn({
          backend: "codex", agentThreadId: agentOverlay.threadId, automationRunId: "test-run", input,
        })).resolves.toMatchObject({ backend: "codex" });
        expect(client.lastStartThreadParams).toMatchObject({ ephemeral: true, sandbox: "workspace-write" });
        expect(client.startTurnCalls).toHaveLength(1);
      } finally {
        await registry.close();
      }
    },
  );
});
