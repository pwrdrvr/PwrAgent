import { afterEach, describe, expect, it, vi } from "vitest";
import {
  executeAutomationOutputActions,
  registerAutomationSourceMessageDeliveryHandler,
  setAutomationSourceMessageDeliveryHandler,
} from "../automations/automation-action-executor";
import type { AutomationRunArtifact } from "@pwragent/shared";

afterEach(() => {
  setAutomationSourceMessageDeliveryHandler(undefined);
});

describe("executeAutomationOutputActions", () => {
  it("marks Agent-context delivery completed for legacy artifacts", async () => {
    await expect(
      executeAutomationOutputActions({
        actions: [{ id: "agent-context", kind: "agent_context" }],
        artifact: artifact(),
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        actionId: "agent-context",
        kind: "agent_context",
        status: "completed",
      }),
    ]);
  });

  it("delivers source-message actions through the registered handler", async () => {
    const deliver = vi.fn(async () => ({ ok: true, message: "presented" }));
    setAutomationSourceMessageDeliveryHandler(deliver);

    await expect(
      executeAutomationOutputActions({
        actions: [
          {
            id: "slack-thread",
            kind: "source_message",
            destination: "source_thread",
            broadcast: true,
          },
        ],
        artifact: artifact({
          outputDecision: {
            kind: "post_card",
            summary: "Investigated alert.",
          },
        }),
        source: {
          kind: "messaging",
          sourceEventKey: "slack:C123:171::B123",
          receivedAt: 1_000,
          matchedTriggerId: "datadog-error",
          actor: {
            platformUserId: "B123",
            isBot: true,
          },
          conversation: {
            channel: "slack",
            conversationId: "C123",
          },
        },
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        actionId: "slack-thread",
        kind: "source_message",
        status: "completed",
        message: "presented",
      }),
    ]);
    expect(deliver).toHaveBeenCalledWith({
      broadcast: true,
      destination: "source_thread",
      intentId: "automation-action:run-1:slack-thread",
      source: expect.objectContaining({
        sourceEventKey: "slack:C123:171::B123",
      }),
      text: "Investigated alert.",
    });
  });

  it("does not repeat completed actions", async () => {
    const deliver = vi.fn(async () => ({ ok: true, message: "presented" }));
    setAutomationSourceMessageDeliveryHandler(deliver);

    await expect(
      executeAutomationOutputActions({
        actions: [
          {
            id: "slack-thread",
            kind: "source_message",
            destination: "source_thread",
          },
        ],
        artifact: artifact({
          actionResults: [
            {
              actionId: "slack-thread",
              kind: "source_message",
              status: "completed",
              completedAt: 2_000,
            },
          ],
        }),
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        actionId: "slack-thread",
        status: "completed",
        completedAt: 2_000,
      }),
    ]);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("tries registered source-message handlers until one accepts delivery", async () => {
    const unsupported = vi.fn(async () => ({
      ok: false,
      unsupported: true,
      errorMessage: "wrong provider",
    }));
    const deliver = vi.fn(async () => ({ ok: true, message: "presented" }));
    const unregisterUnsupported =
      registerAutomationSourceMessageDeliveryHandler(unsupported);
    const unregisterDeliver = registerAutomationSourceMessageDeliveryHandler(deliver);

    try {
      await expect(
        executeAutomationOutputActions({
          actions: [
            {
              id: "slack-thread",
              kind: "source_message",
              destination: "source_thread",
            },
          ],
          artifact: artifact(),
          source: {
            kind: "messaging",
            sourceEventKey: "slack:C123:171::B123",
            receivedAt: 1_000,
            matchedTriggerId: "datadog-error",
            actor: {
              platformUserId: "B123",
              isBot: true,
            },
            conversation: {
              channel: "slack",
              conversationId: "C123",
            },
          },
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          actionId: "slack-thread",
          status: "completed",
          message: "presented",
        }),
      ]);
    } finally {
      unregisterUnsupported();
      unregisterDeliver();
    }

    expect(unsupported).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});

function artifact(
  overrides: Partial<AutomationRunArtifact> = {},
): AutomationRunArtifact {
  return {
    runId: "run-1",
    automationId: "automation-1",
    status: "completed",
    finalText: "Done.",
    actionResults: [],
    transcriptEvents: [],
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}
