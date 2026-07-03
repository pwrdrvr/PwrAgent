import type {
  AppServerTurnInputItem,
  AutomationGateRunResult,
  AutomationRunSourceMetadata,
  AutomationRunSummary,
} from "@pwragent/shared";
import type { AutomationRecord } from "./automation-store.js";

export function buildAutomationTurnInput(params: {
  automation: AutomationRecord;
  gateResult?: AutomationGateRunResult;
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
      : run.trigger === "inbound_message"
        ? "inbound message"
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
        scheduledWindows || "- none",
        ...formatInboundSource(run),
        ...formatGateOutput(params.gateResult),
        "",
        "Return a JSON object as your final answer using this shape:",
        '{"decision":"post_card|quiet","summary":"short operator-facing summary","details":"optional detail","actions":[{"id":"optional-action-id","kind":"agent_context|source_message"}]}',
        'Use "quiet" only when there is nothing useful to report.',
        "",
        "Task:",
        automation.taskPrompt,
      ].join("\n"),
    },
  ];
}

function formatInboundSource(run: AutomationRunSummary): string[] {
  if (run.trigger !== "inbound_message" || !run.source) {
    return [];
  }
  const source = run.source;
  return [
    "",
    "Inbound source message:",
    `Matched trigger: ${source.matchedTriggerName ?? source.matchedTriggerId}`,
    `Received at: ${new Date(source.receivedAt).toISOString()}`,
    `Provider: ${source.conversation.channel}`,
    `Conversation: ${source.conversation.title ?? source.conversation.conversationId}`,
    source.conversation.parentId
      ? `Parent/thread root: ${source.conversation.parentId}`
      : "",
    `Sender: ${source.actor.displayName ?? source.actor.username ?? source.actor.platformUserId}${source.actor.isBot ? " (bot)" : ""}`,
    source.message?.text ? "Message:" : "",
    source.message?.text ?? "",
    source.message?.textTruncated ? "[source message truncated]" : "",
    ...formatBatchedSources(source.batchedEvents),
  ].filter(Boolean);
}

function formatBatchedSources(
  batched: AutomationRunSourceMetadata["batchedEvents"],
): string[] {
  if (!batched || batched.length === 0) return [];
  const lines = [
    "",
    `Additional messages in this batch (${batched.length}):`,
  ];
  for (const entry of batched) {
    const sender =
      entry.actor.displayName ??
      entry.actor.username ??
      entry.actor.platformUserId;
    const text = entry.message?.text ?? "(no text)";
    lines.push(`- [${new Date(entry.receivedAt).toISOString()}] ${sender}: ${text}`);
  }
  return lines;
}

function formatGateOutput(gateResult: AutomationGateRunResult | undefined): string[] {
  if (!gateResult || gateResult.status !== "proceed") {
    return [];
  }
  const output = gateResult.output.trim();
  return [
    "",
    "Gate output:",
    output || "- gate passed with no output",
    gateResult.outputTruncated ? "[gate output truncated]" : "",
  ].filter(Boolean);
}
