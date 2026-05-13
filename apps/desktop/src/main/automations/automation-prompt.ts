import type { AppServerTurnInputItem, AutomationRunSummary } from "@pwragent/shared";
import type { AutomationRecord } from "./automation-store.js";

export function buildAutomationTurnInput(params: {
  automation: AutomationRecord;
  run: AutomationRunSummary;
}): AppServerTurnInputItem[] {
  const { automation, run } = params;
  const scheduledWindows = run.scheduledWindows
    .map((window) => `- ${new Date(window.scheduledFor).toISOString()}`)
    .join("\n");
  const coalescedCount = Math.max(0, run.scheduledWindows.length - 1);
  const trigger =
    run.trigger === "manual"
      ? "manual Run Now"
      : coalescedCount > 0
        ? "scheduled catch-up"
        : "scheduled";
  const coalescedLine =
    coalescedCount > 0
      ? `Coalesced missed windows: ${coalescedCount}`
      : "Coalesced missed windows: 0";

  return [
    {
      type: "text",
      text: [
        "Automation run metadata:",
        `Automation: ${automation.name}`,
        `Trigger: ${trigger}`,
        `Schedule: ${automation.scheduleSummary}`,
        `Backlog policy: ${automation.backlogPolicy}`,
        coalescedLine,
        "Scheduled windows covered:",
        scheduledWindows || "- none; this was manually triggered",
        "",
        "Task:",
        automation.taskPrompt,
      ].join("\n"),
    },
  ];
}
