import type {
  AppServerTurnInputItem,
  AutomationGateRunResult,
  AutomationPriorRunContext,
  AutomationRunSourceMetadata,
  AutomationRunSummary,
} from "@pwragent/shared";
import type { AutomationRecord } from "./automation-store.js";

/** Longest prior-run summary/detail line injected into a prompt. */
const MAX_PRIOR_RUN_TEXT_CHARS = 500;

export function buildAutomationTurnInput(params: {
  automation: AutomationRecord;
  gateResult?: AutomationGateRunResult;
  /**
   * Outcomes of this automation's own recent runs, newest first, already
   * bounded by the automation's `priorRunLookback`. Injected so the prompt can
   * reason about recurrence — the run itself is an ephemeral sub-agent with no
   * memory, and "has this happened before?" is unanswerable without history.
   */
  priorRuns?: AutomationPriorRunContext[];
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
        ...formatPriorRuns(params.priorRuns),
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

/**
 * Render prior run outcomes for the prompt. Newest first, with explicit
 * timestamps so the model can judge recency ("three times in the last hour")
 * rather than only recurrence. An empty history when lookback is enabled is
 * itself signal, so the section states that instead of vanishing.
 */
function formatPriorRuns(
  priorRuns: AutomationPriorRunContext[] | undefined,
): string[] {
  if (!priorRuns) return [];
  if (priorRuns.length === 0) {
    return [
      "",
      "Prior runs of this automation (within the configured lookback): none.",
    ];
  }
  const lines = priorRuns.map((prior) => {
    const summary = boundPriorText(prior.summary) ?? "(no summary)";
    const details = boundPriorText(prior.details);
    return [
      `- ${new Date(prior.completedAt).toISOString()} [${prior.status}] ${summary}`,
      ...(details ? [`  ${details}`] : []),
    ].join("\n");
  });
  return [
    "",
    `Prior runs of this automation, newest first (${priorRuns.length} within the configured lookback):`,
    ...lines,
    "Use these to judge whether the current event is new, recurring, or escalating.",
  ];
}

function boundPriorText(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const flattened = text.replace(/\s+/g, " ").trim();
  if (!flattened) return undefined;
  return flattened.length > MAX_PRIOR_RUN_TEXT_CHARS
    ? `${flattened.slice(0, MAX_PRIOR_RUN_TEXT_CHARS)}…`
    : flattened;
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
