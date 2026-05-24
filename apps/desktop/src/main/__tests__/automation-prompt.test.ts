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
    scheduleSummary: "every 5 minutes",
    backlogPolicy: "coalesce",
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
    expect(item?.type === "text" ? item.text : "").toContain(
      "- none; this was manually triggered",
    );
  });
});
