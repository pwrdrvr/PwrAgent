import type {
  ThreadToolInvocationRecord,
  ThreadUsageLineRecord,
} from "@pwragent/shared";

/**
 * Lookups that price Token Miser gates against one thread's usage ledger.
 *
 * Each gate needs its helper's usage line and its parent turn's usage line.
 * Scanning the ledger for both, once per gate, made a thread read cost
 * G × P. These indexes are built once per computation from the caller's
 * snapshot and dropped with it, so a fresh read always sees fresh rows.
 * They return exactly what the first-match scans returned.
 */
export type TokenMiserPricingIndex = {
  /** The first line whose `sourceItemId` is `monitorId`. */
  gateUsageLine(monitorId: string): ThreadUsageLineRecord | undefined;
  /**
   * The first non-monitor line with a model whose thread is `threadId` and
   * whose `turnId` or `usageTurnId` is `turnId`.
   */
  parentUsageLine(
    threadId: string,
    turnId: string,
  ): ThreadUsageLineRecord | undefined;
  /**
   * Record a gate line appended to the indexed ledger. A line that already
   * matched keeps precedence, as it would in a scan of the appended ledger.
   */
  appendGateUsageLine(line: ThreadUsageLineRecord): void;
};

export function indexTokenMiserPricingLines(
  lines: Iterable<ThreadUsageLineRecord>,
): TokenMiserPricingIndex {
  const gateLines = new Map<string, ThreadUsageLineRecord>();
  // Keys keep the scan's raw `===` comparison, absent ids included.
  const parentLines = new Map<unknown, Map<unknown, ThreadUsageLineRecord>>();
  const addGateLine = (line: ThreadUsageLineRecord) => {
    const sourceItemId = line.sourceItemId;
    if (sourceItemId !== undefined && !gateLines.has(sourceItemId)) {
      gateLines.set(sourceItemId, line);
    }
  };
  for (const line of lines) {
    addGateLine(line);
    if (line.scope === "monitor" || !line.model) {
      continue;
    }
    let byTurn = parentLines.get(line.threadId);
    if (!byTurn) {
      byTurn = new Map();
      parentLines.set(line.threadId, byTurn);
    }
    if (!byTurn.has(line.turnId)) {
      byTurn.set(line.turnId, line);
    }
    if (!byTurn.has(line.usageTurnId)) {
      byTurn.set(line.usageTurnId, line);
    }
  }
  return {
    appendGateUsageLine: addGateLine,
    gateUsageLine: (monitorId) => gateLines.get(monitorId),
    parentUsageLine: (threadId, turnId) =>
      parentLines.get(threadId)?.get(turnId),
  };
}

/**
 * Cached replays after a tool call, for gates that predate observed replay
 * tracking: model round trips in the same turn after the tool's own
 * invocation, less the first, which received the result uncached.
 *
 * Each turn is ordered once, on first use, instead of once per gate.
 */
export type TokenMiserCachedReplayIndex = {
  countAfterInvocation(params: { toolUseId: string; turnId: string }): number;
};

type OrderedTurn = {
  firstPositionByItemId: Map<string, number>;
  length: number;
};

export function indexTokenMiserCachedReplays(
  invocations: readonly ThreadToolInvocationRecord[],
): TokenMiserCachedReplayIndex {
  let invocationsByTurn:
    | Map<string | undefined, ThreadToolInvocationRecord[]>
    | undefined;
  const orderedTurns = new Map<string, OrderedTurn>();
  const orderTurn = (turnId: string): OrderedTurn => {
    if (!invocationsByTurn) {
      invocationsByTurn = new Map();
      for (const invocation of invocations) {
        const group = invocationsByTurn.get(invocation.turnId);
        if (group) {
          group.push(invocation);
        } else {
          invocationsByTurn.set(invocation.turnId, [invocation]);
        }
      }
    }
    // Array sort is stable, so ties order as they did in the whole-list sort.
    const ordered = (invocationsByTurn.get(turnId) ?? []).sort((left, right) =>
      left.observedAt - right.observedAt
      || left.invocationId.localeCompare(right.invocationId)
    );
    const firstPositionByItemId = new Map<string, number>();
    ordered.forEach((invocation, position) => {
      if (!firstPositionByItemId.has(invocation.itemId)) {
        firstPositionByItemId.set(invocation.itemId, position);
      }
    });
    return { firstPositionByItemId, length: ordered.length };
  };
  return {
    countAfterInvocation: ({ toolUseId, turnId }) => {
      let turn = orderedTurns.get(turnId);
      if (!turn) {
        turn = orderTurn(turnId);
        orderedTurns.set(turnId, turn);
      }
      const selectedIndex = turn.firstPositionByItemId.get(toolUseId);
      if (selectedIndex === undefined) {
        return 0;
      }
      // The first later round trip is the uncached request that initially
      // receives the tool result. Cached replay begins with the next request.
      return Math.max(0, turn.length - selectedIndex - 2);
    },
  };
}
