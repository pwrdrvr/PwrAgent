import { describe, expect, it } from "vitest";
import { buildAutomationTurnInput } from "../automations/automation-prompt";
import type { AutomationRecord } from "../automations/automation-store";

function buildAutomation(): AutomationRecord {
  return {
    id: "automation-1",
    backend: "codex",
    threadId: "thread-1",
    name: "Check email",
    taskPrompt: "Summarize urgent unread mail.",
    status: "enabled",
    schedule: {
      kind: "interval",
      every: 5,
      unit: "minutes",
    },
    triggers: [
      {
        id: "schedule",
        kind: "schedule",
        schedule: {
          kind: "interval",
          every: 5,
          unit: "minutes",
        },
      },
    ],
    scheduleSummary: "every 5 minutes",
    backlogPolicy: "coalesce",
    outputActions: [{ id: "agent-context", kind: "agent_context" }],
    createdAt: 1_000,
    updatedAt: 1_000,
  };
}

describe("buildAutomationTurnInput", () => {
  it("includes catch-up metadata before the task prompt", () => {
    const input = buildAutomationTurnInput({
      automation: buildAutomation(),
      run: {
        id: "run-1",
        automationId: "automation-1",
        trigger: "scheduled",
        status: "pending",
        scheduledWindows: [
          { scheduledFor: Date.UTC(2026, 4, 13, 14, 10) },
          { scheduledFor: Date.UTC(2026, 4, 13, 14, 15) },
        ],
      },
    });

    expect(input).toEqual([
      {
        type: "text",
        text: expect.stringContaining("Trigger: scheduled catch-up"),
      },
    ]);
    expect(input[0]?.type === "text" ? input[0].text : "").toContain(
      "Coalesced missed windows: 1",
    );
    expect(input[0]?.type === "text" ? input[0].text : "").toContain(
      "Summarize urgent unread mail.",
    );
  });

  it("marks manual run-now prompts distinctly", () => {
    const [item] = buildAutomationTurnInput({
      automation: buildAutomation(),
      run: {
        id: "run-1",
        automationId: "automation-1",
        trigger: "manual",
        status: "pending",
        scheduledWindows: [],
      },
    });

    expect(item?.type === "text" ? item.text : "").toContain(
      "Trigger: manual Run Now",
    );
    expect(item?.type === "text" ? item.text : "").toContain("- none");
  });

  it("includes inbound message source context", () => {
    const [item] = buildAutomationTurnInput({
      automation: {
        ...buildAutomation(),
        schedule: undefined,
        triggers: [
          {
            id: "datadog-error",
            kind: "inbound_message",
            name: "Datadog ERROR",
            conversation: {
              channel: "slack",
              conversationId: "C123",
            },
          },
        ],
        scheduleSummary: "inbound: Datadog ERROR",
      },
      run: {
        id: "run-1",
        automationId: "automation-1",
        trigger: "inbound_message",
        status: "pending",
        scheduledWindows: [],
        source: {
          kind: "messaging",
          sourceEventKey: "slack:C123:171.000::B123",
          receivedAt: Date.UTC(2026, 4, 13, 14, 10),
          matchedTriggerId: "datadog-error",
          matchedTriggerName: "Datadog ERROR",
          actor: {
            platformUserId: "B123",
            displayName: "Datadog",
            isBot: true,
          },
          conversation: {
            channel: "slack",
            conversationId: "C123",
            title: "alerts",
          },
          message: {
            text: "ERROR api latency high",
          },
        },
      },
    });

    const text = item?.type === "text" ? item.text : "";
    expect(text).toContain("Trigger: inbound message");
    expect(text).toContain("Matched trigger: Datadog ERROR");
    expect(text).toContain("Conversation: alerts");
    expect(text).toContain("Sender: Datadog (bot)");
    expect(text).toContain("ERROR api latency high");
  });
});
