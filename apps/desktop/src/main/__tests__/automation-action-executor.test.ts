import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildPendingDeliveryActionResults,
  executeAutomationOutputActions,
  registerAutomationSourceMessageDeliveryHandler,
  setAutomationSourceMessageDeliveryHandler,
  setAutomationTargetMessageDeliveryHandler,
} from "../automations/automation-action-executor";
import type { AutomationRunArtifact } from "@pwragent/shared";

afterEach(() => {
  setAutomationSourceMessageDeliveryHandler(undefined);
  setAutomationTargetMessageDeliveryHandler(undefined);
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

  it("delivers messaging_target actions to an alternate conversation", async () => {
    const deliver = vi.fn(async () => ({ ok: true, message: "presented" }));
    setAutomationTargetMessageDeliveryHandler(deliver);

    await expect(
      executeAutomationOutputActions({
        actions: [
          {
            id: "ops-channel",
            kind: "messaging_target",
            target: {
              channel: "telegram",
              conversationId: "-100999",
              conversationKind: "channel",
              title: "Incident Reports",
            },
          },
        ],
        artifact: artifact({
          outputDecision: { kind: "post_card", summary: "Investigated alert." },
        }),
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        actionId: "ops-channel",
        kind: "messaging_target",
        status: "completed",
        message: "presented",
      }),
    ]);
    expect(deliver).toHaveBeenCalledWith({
      intentId: "automation-action:run-1:ops-channel",
      target: expect.objectContaining({ conversationId: "-100999" }),
      text: "Investigated alert.",
    });
  });

  it("does not re-post a delivery action left pending by a prior attempt", async () => {
    const deliver = vi.fn(async () => ({ ok: true, message: "presented" }));
    setAutomationSourceMessageDeliveryHandler(deliver);

    await expect(
      executeAutomationOutputActions({
        actions: [
          { id: "slack-thread", kind: "source_message", destination: "source_thread" },
        ],
        artifact: artifact({
          actionResults: [
            {
              actionId: "slack-thread",
              kind: "source_message",
              status: "pending",
              attemptedAt: 1_500,
            },
          ],
        }),
        source: {
          kind: "messaging",
          sourceEventKey: "slack:C123:171::B123",
          receivedAt: 1_000,
          matchedTriggerId: "datadog-error",
          actor: { platformUserId: "B123", isBot: true },
          conversation: { channel: "slack", conversationId: "C123" },
        },
      }),
    ).resolves.toEqual([
      expect.objectContaining({ actionId: "slack-thread", status: "pending" }),
    ]);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("builds pending markers only for fresh delivery actions", () => {
    const pending = buildPendingDeliveryActionResults(
      [
        { id: "agent-context", kind: "agent_context" },
        { id: "reply", kind: "source_message", destination: "source_thread" },
        {
          id: "ops",
          kind: "messaging_target",
          target: { channel: "telegram", conversationId: "-100" },
        },
        { id: "done", kind: "source_message", destination: "source_channel" },
      ],
      [
        {
          actionId: "done",
          kind: "source_message",
          status: "completed",
          completedAt: 1,
        },
      ],
    );

    expect(pending.map((result) => result.actionId)).toEqual(["reply", "ops"]);
    expect(pending.every((result) => result.status === "pending")).toBe(true);
  });

  it("reports messaging_target unsupported when no handler is registered", async () => {
    await expect(
      executeAutomationOutputActions({
        actions: [
          {
            id: "ops-channel",
            kind: "messaging_target",
            target: { channel: "telegram", conversationId: "-100999" },
          },
        ],
        artifact: artifact(),
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        actionId: "ops-channel",
        kind: "messaging_target",
        status: "unsupported",
      }),
    ]);
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
