import type {
  ThreadToolAccounting,
  ThreadToolInvocationAlert,
  ThreadToolInvocationRecord,
  ThreadUsageLineRecord,
} from "@pwragent/shared";
import {
  isFlaggedToolInvocation,
  TOOL_OUTPUT_CAP_CHARS,
} from "@pwragent/shared";

/**
 * One incident per thread, folded from every flagged tool call it has made.
 *
 * The alert stream is per-turn, which is why the notice stack reached "1 of
 * 41": each threshold trip minted its own durable card, each needing its own
 * dismissal. Nothing about that queue told the operator the thing they
 * actually want to know — how much this thread has cost since it started
 * misbehaving — because every card only knew about its own turn.
 *
 * This fold answers that instead, and it updates in place as the numbers move.
 */

/**
 * Whether the fold saw the whole thread.
 *
 * The live notification carries `readThreadToolAccounting`'s default page,
 * which caps at 200 invocations — so on a long thread these counts describe
 * recent activity, not the thread. The card says which it is rather than
 * presenting a capped count as a total; the explorer, which reads with
 * `includeAllToolInvocations`, is where the real totals live.
 */
export const INCIDENT_SNAPSHOT_INVOCATION_CAP = 200;

export type ThreadIncidentSummary = {
  backend: string;
  currency?: string;
  /**
   * Modeled cost of replaying the flagged output. Distinct from `spentMicros`,
   * which is money actually billed: this is the share of it attributable to
   * carrying large tool results through later round trips. Undefined when the
   * ledger has no cache-served rows to derive a rate from.
   */
  estimatedReplayWasteMicros?: number;
  firstWarningAt?: number;
  flaggedInvocationCount: number;
  /** False when the fold ran against a capped snapshot of a longer thread. */
  coversWholeThread: boolean;
  lastWarningAt?: number;
  /** Calls that reached the harness output cap and were truncated. */
  overCapCount: number;
  /**
   * Calls flagged as repeated queued checks. A distinct pathology from large
   * output — the cost is the round trip, not the payload — so the single card
   * still has to name it rather than folding it into a generic total.
   */
  pollingInvocationCount: number;
  /** Tokens carried through later round trips in the same turn. */
  replayedTokens: number;
  severity: ThreadToolInvocationAlert["severity"];
  /** Billed spend since the first warning, straight from the pricing ledger. */
  spentSinceFirstWarningMicros?: number;
  threadId: string;
  turnsWithWarnings: number;
};

export function buildThreadIncidentSummary(params: {
  accounting: ThreadToolAccounting;
  backend: string;
  /** Persisted baseline. Survives restart so the cost window does not reset. */
  firstWarningAt?: number;
  threadId: string;
  usageLines?: readonly ThreadUsageLineRecord[];
}): ThreadIncidentSummary | undefined {
  const invocations = params.accounting.invocations;
  /* Same predicate the explorer uses: a card that counted only rows the
     detectors happened to mark would under-report exactly the threads whose
     history predates them. */
  const flagged = invocations.filter(isFlaggedToolInvocation);
  if (flagged.length === 0) return undefined;

  const observedFirst = flagged.reduce(
    (earliest, entry) => Math.min(earliest, entry.observedAt),
    Number.POSITIVE_INFINITY,
  );
  /* The persisted baseline wins when it is older: a thread that warned
     yesterday keeps yesterday's cost window even though today's snapshot may
     no longer carry those rows. */
  const firstWarningAt = Math.min(
    params.firstWarningAt ?? Number.POSITIVE_INFINITY,
    observedFirst,
  );
  const overCapCount = flagged.filter(
    (entry) => entry.outputChars >= TOOL_OUTPUT_CAP_CHARS,
  ).length;
  /* Later-trip counts for every call in one pass, rather than an indexOf plus
     a filter per flagged call. The per-call form was O(flagged × n) with a
     linear scan inside it — safe only because the notification payload is
     capped at 200 rows, which is not a property this fold should depend on. */
  const laterTripsByInvocation = countLaterTripsByInvocation(invocations);
  const replayedTokens = flagged.reduce(
    (sum, entry) =>
      sum + entry.estimatedOutputTokens * (laterTripsByInvocation.get(entry) ?? 0),
    0,
  );
  const usageLines = params.usageLines ?? [];
  const spent = sumSpendSince(usageLines, firstWarningAt);
  const rate = deriveCachedInputMicrosPerToken(usageLines);

  return {
    backend: params.backend,
    ...(usageLines[0]?.currency ? { currency: usageLines[0].currency } : {}),
    ...(rate !== undefined
      ? { estimatedReplayWasteMicros: Math.round(replayedTokens * rate) }
      : {}),
    ...(Number.isFinite(firstWarningAt) ? { firstWarningAt } : {}),
    coversWholeThread: invocations.length < INCIDENT_SNAPSHOT_INVOCATION_CAP,
    flaggedInvocationCount: flagged.length,
    lastWarningAt: flagged.reduce(
      (latest, entry) => Math.max(latest, entry.observedAt),
      0,
    ),
    overCapCount,
    pollingInvocationCount: flagged.filter((entry) =>
      entry.noisyReason?.includes("poll")
    ).length,
    replayedTokens,
    severity: overCapCount > 0 ? "critical" : "warning",
    ...(spent !== undefined ? { spentSinceFirstWarningMicros: spent } : {}),
    threadId: params.threadId,
    turnsWithWarnings: new Set(flagged.map((entry) => entry.turnId ?? "")).size,
  };
}

/**
 * How many calls follow each one inside its own turn. Every one of those is a
 * round trip that carried the earlier output through the model again.
 *
 * Computed for all calls at once: group by turn, order within the turn, then
 * read each position's distance from the end. Ties on `observedAt` — which a
 * full-history analyze pass produces in bulk — fall back to persisted order so
 * no trip is dropped.
 */
function countLaterTripsByInvocation(
  invocations: readonly ThreadToolInvocationRecord[],
): Map<ThreadToolInvocationRecord, number> {
  const byTurn = new Map<string, ThreadToolInvocationRecord[]>();
  const orderIndex = new Map<ThreadToolInvocationRecord, number>();
  invocations.forEach((invocation, index) => {
    orderIndex.set(invocation, index);
    const key = invocation.turnId ?? "";
    const bucket = byTurn.get(key);
    if (bucket) bucket.push(invocation);
    else byTurn.set(key, [invocation]);
  });
  const laterTrips = new Map<ThreadToolInvocationRecord, number>();
  for (const bucket of byTurn.values()) {
    const ordered = [...bucket].sort((left, right) =>
      left.observedAt - right.observedAt
      || (orderIndex.get(left) ?? 0) - (orderIndex.get(right) ?? 0));
    ordered.forEach((invocation, position) => {
      laterTrips.set(invocation, ordered.length - 1 - position);
    });
  }
  return laterTrips;
}

function sumSpendSince(
  lines: readonly ThreadUsageLineRecord[],
  since: number,
): number | undefined {
  if (!Number.isFinite(since)) return undefined;
  const matching = lines.filter((line) => line.createdAt >= since);
  if (matching.length === 0) return undefined;
  return matching.reduce((sum, line) => sum + line.totalCostMicros, 0);
}

/**
 * Effective cache-served input rate, derived from the thread's own billed rows
 * rather than a catalog lookup — replayed context is cache-served, and the
 * ledger already knows what this thread actually paid for it. Undefined when
 * nothing cache-served has been billed yet, in which case the caller reports
 * replayed tokens and no money.
 */
function deriveCachedInputMicrosPerToken(
  lines: readonly ThreadUsageLineRecord[],
): number | undefined {
  let micros = 0;
  let tokens = 0;
  for (const line of lines) {
    micros += line.cachedInputCostMicros;
    tokens += line.cachedInputTokens;
  }
  return tokens > 0 && micros > 0 ? micros / tokens : undefined;
}

export function threadIncidentNoticeId(params: {
  backend: string;
  threadId: string;
}): string {
  /* Deliberately no turn segment — that is what produced one card per turn. */
  return ["tool-accounting", params.backend, params.threadId].join(":");
}

/* One currency formatter for the whole feature: the card and the turn strip
   render the same ledger units, so they must not disagree about credits or
   sub-dollar precision. */
export { formatMicrosCurrency as formatIncidentMicros } from "../thread-detail/tool-output-incident-insights";
