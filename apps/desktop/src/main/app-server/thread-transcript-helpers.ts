import {
  isPromptPlaceholderTitle,
  isInjectedContextPlaceholderTitle,
} from "@pwragent/owner-core/thread-naming-lifecycle";
import type { ClaudeSelfStartedTurnSource } from "../claude/claude-self-started-turns";
import {
  shortenDerivedThreadTitle,
  type AppServerThreadEntry,
  type AppServerReviewContext,
  type AppServerThreadMessageOrigin,
  type AppServerThreadReviewEntry,
  type AppServerThreadReplay,
  type AppServerThreadSummary,
  type AppServerBackendKind,
  type ThreadSubAgentSummary,
  type CompleteMonitoringToolArgs,
} from "@pwragent/shared";
import { buildMinimalGrokHelperSessionPolicy } from "../acp/minimal-helper-session";
import { type ThreadTurnQueueOrigin } from "@pwragent/owner-core/thread-turn-queue";
import { type QueuedMessageTitleSettlement } from "./queued-message-title";
import {
  type ReviewSubAgentRecord,
  type TaskMonitorDelegationRecord,
  type ThreadTitleHelperResult,
  type ThreadTitleService,
} from "./backend-registry-types";


/** Each immutable held prompt keeps the title of its own source. */
export function selfStartedTurnTitle(source: ClaudeSelfStartedTurnSource): string {
  return source === "task_notification" ? "Claude's answer to a finished background task"
    : source === "loop_wakeup" ? "Claude's /loop wake-up"
    : "Claude's scheduled task";
}

export const REPLAY_THREAD_TITLE_ENV = "PWRAGENT_REPLAY_THREAD_TITLE";
export const GROK_TITLE_HELPER_SESSION_POLICY = buildMinimalGrokHelperSessionPolicy({
  description: "Generate a concise title for a PwrAgent thread.",
  name: "pwragent-title-helper",
  systemPrompt:
    "Generate the requested thread title. Follow the user prompt exactly, do not use tools, and return only the requested JSON object.",
});

export function assistantOutputForTurn(
  replay: AppServerThreadReplay,
  turnId: string,
): Array<{ type: "text"; text: string }> {
  for (let index = replay.entries.length - 1; index >= 0; index -= 1) {
    const entry = replay.entries[index];
    if (
      entry?.type === "message" &&
      entry.role === "assistant" &&
      entry.turn?.id === turnId &&
      entry.turn.status === "completed" &&
      entry.text.trim()
    ) {
      return [{ type: "text", text: entry.text }];
    }
  }

  return [];
}

export function insertTranscriptEntry(
  entries: AppServerThreadEntry[],
  entry: AppServerThreadEntry,
): AppServerThreadEntry[] {
  const nextEntries = [...entries];
  const turnId = entry.turn?.id;
  if (turnId) {
    const sameTurnIndex = nextEntries.findLastIndex((entry) => entry.turn?.id === turnId);
    if (sameTurnIndex !== -1) {
      nextEntries.splice(sameTurnIndex + 1, 0, entry);
      return nextEntries;
    }
  }

  if (typeof entry.createdAt === "number") {
    const timedIndex = nextEntries.findIndex(
      (candidate) =>
        typeof candidate.createdAt === "number" &&
        candidate.createdAt > (entry.createdAt as number),
    );
    if (timedIndex !== -1) {
      nextEntries.splice(timedIndex, 0, entry);
      return nextEntries;
    }
  }

  nextEntries.push(entry);
  return nextEntries;
}

export function mergeManagedReviewEntries(params: {
  replay: AppServerThreadReplay;
  entries?: AppServerThreadReviewEntry[];
}): AppServerThreadReplay {
  if (!params.entries?.length) {
    return params.replay;
  }

  let entries = params.replay.entries;
  for (const reviewEntry of params.entries) {
    entries = insertTranscriptEntry(
      entries.filter((entry) => entry.id !== reviewEntry.id),
      reviewEntry,
    );
  }
  return {
    ...params.replay,
    entries,
  };
}

export function reviewEntryReviewer(
  record: Pick<
    ReviewSubAgentRecord,
    "backend" | "model" | "reasoningEffort"
  >,
): NonNullable<AppServerThreadReviewEntry["reviewer"]> {
  return {
    backend: record.backend,
    ...(record.model ? { model: record.model } : {}),
    ...(record.reasoningEffort ? { reasoningEffort: record.reasoningEffort } : {}),
  };
}

/**
 * Native review entries come from the provider transcript, which does not
 * carry reviewer configuration or PwrAgent's frozen workspace/PR provenance.
 * The durable review sub-agent summary is the authority for both, including
 * after an app restart.
 */
export function attachReviewEntryMetadata(params: {
  replay: AppServerThreadReplay;
  subAgents?: ThreadSubAgentSummary[];
}): AppServerThreadReplay {
  const metadataByTurnId = new Map<string, {
    context?: AppServerReviewContext;
    reviewer: NonNullable<AppServerThreadReviewEntry["reviewer"]>;
  }>();
  for (const subAgent of params.subAgents ?? []) {
    if (
      !subAgent.monitorId.startsWith("review:")
      || !subAgent.monitorTurnId
      || !subAgent.backend
    ) {
      continue;
    }
    const model =
      subAgent.preferredModel
      ?? subAgent.monitorUsage?.model
      ?? subAgent.monitorUsage?.cost?.model;
    metadataByTurnId.set(subAgent.monitorTurnId, {
      ...(subAgent.reviewContext ? { context: subAgent.reviewContext } : {}),
      reviewer: {
        backend: subAgent.backend,
        ...(model ? { model } : {}),
        ...(subAgent.preferredReasoningEffort
          ? { reasoningEffort: subAgent.preferredReasoningEffort }
          : {}),
      },
    });
  }

  if (metadataByTurnId.size === 0) {
    return params.replay;
  }

  let changed = false;
  const entries = params.replay.entries.map((entry) => {
    if (entry.type !== "review" || !entry.turn?.id) {
      return entry;
    }
    const metadata = metadataByTurnId.get(entry.turn.id);
    if (!metadata) {
      return entry;
    }
    const model = entry.reviewer?.model ?? metadata.reviewer.model;
    const reasoningEffort =
      entry.reviewer?.reasoningEffort ?? metadata.reviewer.reasoningEffort;
    const reviewer = {
      backend: entry.reviewer?.backend ?? metadata.reviewer.backend,
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
    };
    const context = entry.context ?? metadata.context;
    if (
      entry.reviewer?.backend === reviewer.backend
      && entry.reviewer?.model === reviewer.model
      && entry.reviewer?.reasoningEffort === reviewer.reasoningEffort
      && entry.context === context
    ) {
      return entry;
    }
    changed = true;
    return {
      ...entry,
      reviewer,
      ...(context ? { context } : {}),
    };
  });
  return changed ? { ...params.replay, entries } : params.replay;
}

export function mergeThreadMessageOrigins(
  replay: AppServerThreadReplay,
  originsByMessageId: Record<string, AppServerThreadMessageOrigin>,
): AppServerThreadReplay {
  if (Object.keys(originsByMessageId).length === 0) {
    return replay;
  }
  const firstUserMessageTurnIds = new Set<string>();
  const resolvedOriginsByMessageId: Record<string, AppServerThreadMessageOrigin> = {};
  const entries = replay.entries.map((entry): AppServerThreadEntry => {
    if (entry.type !== "message" || entry.role !== "user") {
      return entry;
    }
    const turnId = entry.turn?.id;
    const isFirstUserMessageForTurn = Boolean(
      turnId && !firstUserMessageTurnIds.has(turnId),
    );
    if (turnId) {
      firstUserMessageTurnIds.add(turnId);
    }
    const origin =
      originsByMessageId[entry.id]
      ?? (turnId && isFirstUserMessageForTurn
        ? originsByMessageId[buildTurnUserMessageOriginId(turnId)]
        : undefined);
    if (origin) {
      resolvedOriginsByMessageId[entry.id] = origin;
    }
    return origin ? { ...entry, origin } : entry;
  });
  const messages = replay.messages.map((message) => {
    const origin =
      originsByMessageId[message.id]
      ?? resolvedOriginsByMessageId[message.id];
    return origin && message.role === "user" ? { ...message, origin } : message;
  });
  return {
    ...replay,
    entries,
    messages,
  };
}

export function isCausalMessagingContext(
  context: TaskMonitorDelegationRecord["causalContext"],
): boolean {
  return Boolean(context?.causalMessagingSource || context?.causalMessagingAmbiguous);
}

/**
 * Origin of a prompt PwrAgent writes into a monitor thread: its brief and
 * any recovery instruction. The sub-agent details link Claude and ACP
 * monitor transcripts, so without one the prompt reads as the operator's.
 * It carries no
 * `subAgent` block: that block marks a monitor result, which the
 * transcript draws as a completed-monitor card with an outcome.
 */
export function buildTaskMonitorPromptOrigin(
  causalContext: TaskMonitorDelegationRecord["causalContext"],
): AppServerThreadMessageOrigin {
  return { kind: "sub-agent", ...causalContext };
}

export function buildTaskMonitorMessageOrigin(params: {
  monitorId: string;
  monitorThreadId?: string;
  outcome: CompleteMonitoringToolArgs["outcome"];
  summary: string;
  task: string;
}): AppServerThreadMessageOrigin {
  return {
    kind: "sub-agent",
    ...(params.monitorThreadId
      ? {
          sourceThread: {
            backend: "codex",
            threadId: params.monitorThreadId,
            title: params.task,
          },
        }
      : {}),
    subAgent: {
      kind: "monitor",
      monitorId: params.monitorId,
      outcome: params.outcome,
      summary: params.summary,
      task: params.task,
    },
  };
}

export function inferLegacyTaskMonitorMessageOrigins(params: {
  origins: Record<string, AppServerThreadMessageOrigin>;
  replay: AppServerThreadReplay;
  subAgents?: ThreadSubAgentSummary[];
}): Record<string, AppServerThreadMessageOrigin> {
  if (!params.subAgents?.length) {
    return params.origins;
  }

  const origins = { ...params.origins };
  const messages = [
    ...params.replay.entries.filter(
      (entry): entry is Extract<AppServerThreadEntry, { type: "message" }> =>
        entry.type === "message" && entry.role === "user",
    ),
    ...params.replay.messages.filter((message) => message.role === "user"),
  ]
    .filter(
      (message, index, all) =>
        all.findIndex((candidate) => candidate.id === message.id) === index,
    )
    .map((message, index) => ({ message, index }))
    .sort((left, right) => {
      const leftTime = left.message.createdAt;
      const rightTime = right.message.createdAt;
      if (leftTime !== undefined && rightTime !== undefined) {
        return rightTime - leftTime;
      }
      return right.index - left.index;
    })
    .map(({ message }) => message);
  const availableSubAgents = [...params.subAgents].sort(
    (left, right) =>
      taskMonitorCompletionTime(right) - taskMonitorCompletionTime(left),
  );
  for (const message of messages) {
    if (
      origins[message.id]
      || !message.text.startsWith(
        "A lightweight PwrAgent monitor subagent finished a long-running task.",
      )
    ) {
      continue;
    }
    const task = message.text.match(/(?:^|\n)Task: ([^\n]+)/)?.[1]?.trim();
    const outcome = message.text.match(
      /(?:^|\n)Outcome: (success|failure|cancelled)(?:\n|$)/,
    )?.[1] as CompleteMonitoringToolArgs["outcome"] | undefined;
    if (!task || !outcome) {
      continue;
    }
    const candidates = availableSubAgents.filter((candidate) => {
      const candidateSummary = candidate.lastMessage?.trim();
      return (
        candidate.task === task
        && (candidate.outcome === outcome || candidate.status === outcome)
        && Boolean(
          candidateSummary
          && message.text.includes(`Summary: ${candidateSummary}`),
        )
      );
    });
    const messageTime = message.createdAt;
    const subAgent =
      messageTime === undefined
        ? candidates[0]
        : candidates.find(
            (candidate) => taskMonitorCompletionTime(candidate) <= messageTime,
          ) ?? candidates[0];
    if (!subAgent) {
      continue;
    }
    const summary = subAgent.lastMessage?.trim();
    if (!summary) {
      continue;
    }
    availableSubAgents.splice(availableSubAgents.indexOf(subAgent), 1);
    origins[message.id] = buildTaskMonitorMessageOrigin({
      monitorId: subAgent.monitorId,
      monitorThreadId: subAgent.monitorThreadId,
      outcome,
      summary,
      task,
    });
  }
  return origins;
}

export function taskMonitorCompletionTime(subAgent: ThreadSubAgentSummary): number {
  return subAgent.completedAt ?? subAgent.updatedAt ?? subAgent.createdAt;
}

export function buildTurnUserMessageOriginId(turnId: string): string {
  return `user:${turnId}`;
}

/**
 * The turn's merged causal routing context. No message has this id, and
 * origins are read by message id, so it never becomes a displayed origin.
 */
export function buildTurnCausalMessagingContextId(turnId: string): string {
  return `turn-causal:${turnId}`;
}

export function resolveThreadMessageOrigin(params: {
  origin?: ThreadTurnQueueOrigin;
  messageOrigin?: AppServerThreadMessageOrigin;
}): AppServerThreadMessageOrigin | undefined {
  if (params.messageOrigin) {
    return params.messageOrigin;
  }
  if (params.origin === "automation" || params.origin === "messaging") {
    return { kind: params.origin };
  }
  return undefined;
}

export function titleHelperSubAgentId(
  backend: AppServerBackendKind,
  threadId: string,
): string {
  return `system:title-helper:${backend}:${threadId}`;
}

/**
 * One row per thread, not per message: a messaging thread handed dozens of
 * long messages would otherwise fill the Sub-agents rail with a card each.
 */
export function queuedMessageTitleHelperSubAgentId(
  backend: AppServerBackendKind,
  threadId: string,
): string {
  return `system:queued-message-titles:${backend}:${threadId}`;
}

export const QUEUED_MESSAGE_TITLE_COUNT_PATTERN = /^Named (\d+) queued messages?\./u;

/**
 * How many titles the row has landed so far. The count rides at the head of
 * the row's message because the summary has no counter field, and adding one
 * would change a shape that peers already read.
 */
export function queuedMessageTitleHelperCount(
  subAgent: ThreadSubAgentSummary | undefined,
): number {
  const match = QUEUED_MESSAGE_TITLE_COUNT_PATTERN.exec(subAgent?.lastMessage ?? "");
  return match ? Number(match[1]) : 0;
}

export function queuedMessageTitleHelperSubAgentMessage(params: {
  count: number;
  settlement: QueuedMessageTitleSettlement;
}): string {
  const { result, title, applied } = params.settlement;
  const run = title === undefined
    ? result.status === "ok"
      ? "Latest title rejected: the helper returned no usable title."
      : `Latest title failed: ${result.reason}`
    : applied
      ? `Latest: ${title}`
      : `Latest title not applied: ${title}. The message changed or left the queue.`;
  if (params.count === 0) return run;
  return `Named ${params.count} queued ${params.count === 1 ? "message" : "messages"}. ${run}`;
}

export function titleHelperSubAgentMessage(params: {
  result?: ThreadTitleHelperResult;
  status: "pending" | "running" | "success" | "failed" | "cancelled";
  reason?: string;
}): string {
  if (params.status === "pending") {
    return params.reason ?? "Title generation is queued.";
  }
  if (params.status === "running") {
    return params.reason ?? "Generating a title.";
  }
  if (params.status === "success") {
    const title =
      params.result?.status === "generated" ? params.result.title : undefined;
    if (title) {
      return params.reason
        ? `Generated title: ${title}. Not applied: ${params.reason}`
        : `Generated title: ${title}`;
    }
    return "Generated a title.";
  }
  if (params.status === "cancelled") {
    const title =
      params.result?.status === "generated" ? params.result.title : undefined;
    if (title) {
      return params.reason
        ? `Generated title: ${title}. Not applied: ${params.reason}`
        : `Generated title: ${title}. Not applied.`;
    }
    return params.reason
      ? `Title generation cancelled: ${params.reason}`
      : "Title generation cancelled.";
  }
  return params.reason
    ? `Title generation failed: ${params.reason}`
    : "Title generation failed.";
}

export function truncateLogValue(value: string | undefined): string | null {
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }
  return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized;
}

export function buildTitleEligibilityLogDetails(
  thread: AppServerThreadSummary | undefined,
  prompt: string,
): Record<string, unknown> {
  return {
    currentTitle: truncateLogValue(thread?.title),
    currentTitleSource: thread?.titleSource ?? null,
    promptTitle: truncateLogValue(shortenDerivedThreadTitle(prompt) ?? prompt),
    promptMatchesCurrentTitle: thread ? isPromptPlaceholderTitle(thread.title, prompt) : null,
    injectedContextPlaceholderTitle: thread
      ? isInjectedContextPlaceholderTitle(thread.title)
      : null,
  };
}

export function createReplayThreadTitleService(): ThreadTitleService | undefined {
  const title = process.env[REPLAY_THREAD_TITLE_ENV]?.trim();
  if (!title) {
    return undefined;
  }

  return {
    generateTitle: async () => ({
      status: "generated",
      title,
    }),
  };
}
