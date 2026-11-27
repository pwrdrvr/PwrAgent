import {
  isPromptPlaceholderTitle,
  isInjectedContextPlaceholderTitle,
} from "@pwragent/owner-core/thread-naming-lifecycle";
import type { ClaudeSelfStartedTurnSource } from "../claude/claude-self-started-turns";
import { shortenDerivedThreadTitle } from "@pwragent/shared/thread-titles";
import {
  type AppServerThreadEntry,
  type AppServerReviewContext,
  type AppServerThreadMessageOrigin,
  type AppServerThreadReviewEntry,
  type AppServerThreadReplay,
  type AppServerThreadSummary,
  type AppServerBackendKind,
} from "@pwragent/shared/contracts/normalized-app-server";
import { type ThreadSubAgentSummary } from "@pwragent/shared/contracts/navigation";
import { type CompleteMonitoringToolArgs } from "@pwragent/shared/contracts/task-monitor-tools";
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
    let timedIndex = nextEntries.findIndex(
      (candidate) =>
        typeof candidate.createdAt === "number" &&
        candidate.createdAt > (entry.createdAt as number),
    );
    if (timedIndex !== -1) {
      // Never split an existing turn when placing an entry from another turn
      // (or a turnless entry). If the first later-stamped row sits inside a
      // turn that already started earlier in the transcript, place this entry
      // after that turn finishes.
      const splitTurnId = nextEntries[timedIndex]?.turn?.id;
      if (
        splitTurnId
        && timedIndex > 0
        && nextEntries.slice(0, timedIndex).some((prior) => prior.turn?.id === splitTurnId)
      ) {
        const lastSplitTurnIndex = nextEntries.findLastIndex(
          (candidate) => candidate.turn?.id === splitTurnId,
        );
        timedIndex = lastSplitTurnIndex + 1;
      }
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

  const reviewIds = new Set<string>();
  for (const review of params.entries) {
    reviewIds.add(review.id);
  }

  // Partition replay entries into immutable base entries (never removed during
  // this merge) and gap buckets positioned immediately before each base entry
  // (gap `baseEntries.length` is after the final base entry). Any existing
  // replay entry whose id matches an incoming review is seeded into its exact
  // gap so sequential remove-then-insert semantics are preserved in O(N + R log N + R^2)
  // without O(N * R) scans or copies of baseEntries.
  const baseEntries: AppServerThreadEntry[] = [];
  const baseTurnIds: Array<string | undefined> = [];
  const firstBaseByTurnId = new Map<string, number>();
  const lastBaseByTurnId = new Map<string, number>();
  const prefixMaxBaseCreatedAt: number[] = [];
  const slotReviews = new Map<number, AppServerThreadEntry[]>();
  const activeSlots: number[] = [];
  const liveReviewIds = new Set<string>();

  const ensureSlotBucket = (slot: number): AppServerThreadEntry[] => {
    let bucket = slotReviews.get(slot);
    if (!bucket) {
      bucket = [];
      slotReviews.set(slot, bucket);
      let insertAt = activeSlots.length;
      while (insertAt > 0 && activeSlots[insertAt - 1]! > slot) {
        insertAt -= 1;
      }
      activeSlots.splice(insertAt, 0, slot);
    }
    return bucket;
  };

  let runningMax = -Infinity;
  for (const entry of params.replay.entries) {
    const entryId = entry.id;
    if (reviewIds.has(entryId)) {
      ensureSlotBucket(baseEntries.length).push(entry);
      liveReviewIds.add(entryId);
      continue;
    }
    const baseIndex = baseEntries.length;
    baseEntries.push(entry);
    const turnId = entry.turn?.id;
    baseTurnIds.push(turnId);
    if (turnId) {
      if (!firstBaseByTurnId.has(turnId)) {
        firstBaseByTurnId.set(turnId, baseIndex);
      }
      lastBaseByTurnId.set(turnId, baseIndex);
    }
    const createdAt = entry.createdAt;
    if (typeof createdAt === "number" && createdAt > runningMax) {
      runningMax = createdAt;
    }
    prefixMaxBaseCreatedAt.push(runningMax);
  }

  const removeReviewById = (id: string): void => {
    if (!liveReviewIds.has(id)) {
      return;
    }
    for (let slotIdx = activeSlots.length - 1; slotIdx >= 0; slotIdx -= 1) {
      const slot = activeSlots[slotIdx]!;
      const bucket = slotReviews.get(slot)!;
      let writeIdx = 0;
      for (let i = 0; i < bucket.length; i += 1) {
        if (bucket[i]!.id !== id) {
          bucket[writeIdx] = bucket[i]!;
          writeIdx += 1;
        }
      }
      if (writeIdx === 0) {
        slotReviews.delete(slot);
        activeSlots.splice(slotIdx, 1);
      } else if (writeIdx < bucket.length) {
        bucket.length = writeIdx;
      }
    }
    liveReviewIds.delete(id);
  };

  const insertAt = (slot: number, index: number, entry: AppServerThreadEntry): void => {
    ensureSlotBucket(slot).splice(index, 0, entry);
    liveReviewIds.add(entry.id);
  };

  const findLastTurnPosition = (turnId: string): { slot: number; index: number } | undefined => {
    const baseLast = lastBaseByTurnId.get(turnId);
    for (let slotIdx = activeSlots.length - 1; slotIdx >= 0; slotIdx -= 1) {
      const slot = activeSlots[slotIdx]!;
      if (baseLast !== undefined && slot <= baseLast) {
        break;
      }
      const bucket = slotReviews.get(slot)!;
      for (let i = bucket.length - 1; i >= 0; i -= 1) {
        if (bucket[i]!.turn?.id === turnId) {
          return { slot, index: i + 1 };
        }
      }
    }
    if (baseLast !== undefined) {
      return { slot: baseLast + 1, index: 0 };
    }
    return undefined;
  };

  const hasEarlierTurnEntry = (
    turnId: string,
    beforeSlot: number,
    beforeIndex: number,
  ): boolean => {
    const firstBase = firstBaseByTurnId.get(turnId);
    if (firstBase !== undefined && firstBase < beforeSlot) {
      return true;
    }
    for (const slot of activeSlots) {
      if (slot > beforeSlot) {
        break;
      }
      const bucket = slotReviews.get(slot)!;
      const limit = slot === beforeSlot ? Math.min(beforeIndex, bucket.length) : bucket.length;
      for (let i = 0; i < limit; i += 1) {
        if (bucket[i]!.turn?.id === turnId) {
          return true;
        }
      }
    }
    return false;
  };

  const findFirstBaseAfterCreatedAt = (createdAt: number): number => {
    let low = 0;
    let high = baseEntries.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (prefixMaxBaseCreatedAt[mid]! > createdAt) {
        high = mid;
      } else {
        low = mid + 1;
      }
    }
    return low;
  };

  for (const review of params.entries) {
    removeReviewById(review.id);

    const turnId = review.turn?.id;
    if (turnId) {
      const sameTurnPos = findLastTurnPosition(turnId);
      if (sameTurnPos) {
        insertAt(sameTurnPos.slot, sameTurnPos.index, review);
        continue;
      }
    }

    if (typeof review.createdAt === "number") {
      const baseTimed = findFirstBaseAfterCreatedAt(review.createdAt);
      let placed = false;
      for (const slot of activeSlots) {
        if (slot > baseTimed) {
          break;
        }
        const bucket = slotReviews.get(slot)!;
        for (let i = 0; i < bucket.length; i += 1) {
          const candidate = bucket[i]!;
          if (typeof candidate.createdAt === "number" && candidate.createdAt > review.createdAt) {
            const splitTurnId = candidate.turn?.id;
            if (splitTurnId && hasEarlierTurnEntry(splitTurnId, slot, i)) {
              const afterTurn = findLastTurnPosition(splitTurnId)!;
              insertAt(afterTurn.slot, afterTurn.index, review);
            } else {
              insertAt(slot, i, review);
            }
            placed = true;
            break;
          }
        }
        if (placed) {
          break;
        }
      }
      if (placed) {
        continue;
      }
      if (baseTimed < baseEntries.length) {
        const splitTurnId = baseTurnIds[baseTimed];
        if (splitTurnId && hasEarlierTurnEntry(splitTurnId, baseTimed, Infinity)) {
          const afterTurn = findLastTurnPosition(splitTurnId)!;
          insertAt(afterTurn.slot, afterTurn.index, review);
        } else {
          const existingBucket = slotReviews.get(baseTimed);
          insertAt(baseTimed, existingBucket?.length ?? 0, review);
        }
        continue;
      }
    }

    const trailingBucket = slotReviews.get(baseEntries.length);
    insertAt(baseEntries.length, trailingBucket?.length ?? 0, review);
  }

  const entries: AppServerThreadEntry[] = [];
  for (let index = 0; index < baseEntries.length; index += 1) {
    const before = slotReviews.get(index);
    if (before) {
      entries.push(...before);
    }
    entries.push(baseEntries[index]!);
  }
  const trailing = slotReviews.get(baseEntries.length);
  if (trailing) {
    entries.push(...trailing);
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
  const monitorPrefix =
    "A lightweight PwrAgent monitor subagent finished a long-running task.";
  const seenMessageIds = new Set<string>();
  const indexedMessages: Array<{
    message: { id: string; text: string; createdAt?: number };
    index: number;
  }> = [];
  const collectCandidate = (
    message: { id: string; text: string; createdAt?: number },
  ): void => {
    if (seenMessageIds.has(message.id)) {
      return;
    }
    seenMessageIds.add(message.id);
    if (origins[message.id] || !message.text.startsWith(monitorPrefix)) {
      return;
    }
    indexedMessages.push({ message, index: indexedMessages.length });
  };
  for (const entry of params.replay.entries) {
    if (entry.type === "message" && entry.role === "user") {
      collectCandidate(entry);
    }
  }
  for (const message of params.replay.messages) {
    if (message.role === "user") {
      collectCandidate(message);
    }
  }
  if (indexedMessages.length === 0) {
    return params.origins;
  }
  const messages = indexedMessages
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
    if (origins[message.id]) {
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
