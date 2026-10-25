import type {
  ThreadToolInvocationRecord,
  ThreadUsageLineRecord,
} from "@pwragent/shared";
import { describe, expect, it } from "vitest";
import {
  indexTokenMiserCachedReplays,
  indexTokenMiserPricingLines,
} from "../app-server/token-miser-ledger-index";

// The indexes replace per-gate scans. Each case below compares them with the
// scan they replaced, written out verbatim, over a ledger built to make
// first-match order and sort ties matter.

describe("Token Miser ledger indexes", () => {
  it("returns the first gate and parent lines a scan would find", () => {
    const lines: ThreadUsageLineRecord[] = [];
    const threads = ["thread-a", "thread-b"];
    const turns = ["turn-1", "turn-2", "turn-3", undefined];
    let serial = 0;
    for (const threadId of threads) {
      for (const turnId of turns) {
        for (const usageTurnId of [...turns, "turn-1"]) {
          for (const scope of ["turn", "monitor"] as const) {
            for (const model of ["model-x", undefined, "model-y"]) {
              serial += 1;
              lines.push(line({
                model,
                scope,
                sourceItemId: serial % 5 === 0 ? undefined : `system:token-miser:gate-${serial % 7}`,
                threadId,
                turnId,
                usageTurnId,
                usageLineId: `line-${serial}`,
              }));
            }
          }
        }
      }
    }
    const index = indexTokenMiserPricingLines(lines);
    for (let gate = 0; gate < 9; gate += 1) {
      const monitorId = `system:token-miser:gate-${gate}`;
      expect(index.gateUsageLine(monitorId)).toBe(
        lines.find((candidate) => candidate.sourceItemId === monitorId),
      );
    }
    for (const threadId of [...threads, "thread-missing"]) {
      for (const turnId of [...turns, "turn-missing"]) {
        const entry = { threadId, turnId: turnId as string };
        expect(index.parentUsageLine(entry.threadId, entry.turnId)).toBe(
          lines.find((candidate) =>
            candidate.scope !== "monitor"
            && candidate.threadId === entry.threadId
            && (candidate.turnId === entry.turnId || candidate.usageTurnId === entry.turnId)
            && Boolean(candidate.model),
          ),
        );
      }
    }
  });

  it("keeps an earlier gate line ahead of an appended one", () => {
    const first = line({ sourceItemId: "system:token-miser:a", usageLineId: "first" });
    const index = indexTokenMiserPricingLines([first]);
    index.appendGateUsageLine(line({ sourceItemId: "system:token-miser:a", usageLineId: "later" }));
    const appended = line({ sourceItemId: "system:token-miser:b", usageLineId: "appended" });
    index.appendGateUsageLine(appended);
    expect(index.gateUsageLine("system:token-miser:a")).toBe(first);
    expect(index.gateUsageLine("system:token-miser:b")).toBe(appended);
  });

  it("counts cached replays exactly as the per-gate sort did", () => {
    const invocations: ThreadToolInvocationRecord[] = [];
    const turns = ["turn-1", "turn-2", undefined];
    for (let serial = 0; serial < 60; serial += 1) {
      invocations.push(invocation({
        // Repeated times and item ids exercise the tiebreak and first match.
        invocationId: `invocation-${(serial * 37) % 60}`,
        itemId: `item-${serial % 11}`,
        observedAt: 1_000 + (serial % 9),
        turnId: turns[serial % 3],
      }));
    }
    const index = indexTokenMiserCachedReplays(invocations);
    for (const turnId of ["turn-1", "turn-2", "turn-missing"]) {
      for (let item = 0; item < 12; item += 1) {
        const toolUseId = `item-${item}`;
        const ordered = [...invocations]
          .filter((candidate) => candidate.turnId === turnId)
          .sort((left, right) =>
            left.observedAt - right.observedAt
            || left.invocationId.localeCompare(right.invocationId)
          );
        const selectedIndex = ordered.findIndex(
          (candidate) => candidate.itemId === toolUseId,
        );
        const expected = selectedIndex < 0
          ? 0
          : Math.max(0, ordered.length - selectedIndex - 2);
        expect(index.countAfterInvocation({ toolUseId, turnId })).toBe(expected);
      }
    }
    // The caller's array is never reordered.
    expect(invocations[0]?.invocationId).toBe("invocation-0");
    expect(invocations[1]?.invocationId).toBe("invocation-37");
  });
});

function line(params: {
  model?: string;
  scope?: ThreadUsageLineRecord["scope"];
  sourceItemId?: string;
  threadId?: string;
  turnId?: string;
  usageLineId: string;
  usageTurnId?: string;
}): ThreadUsageLineRecord {
  return {
    backend: "codex",
    cachedInputCostMicros: 0,
    cachedInputTokens: 0,
    createdAt: 0,
    currency: "USD",
    inputTokens: 0,
    ...(params.model ? { model: params.model } : {}),
    outputCostMicros: 0,
    outputTokens: 0,
    priceStatus: "unpriced",
    provider: "openai",
    reasoningOutputTokens: 0,
    scope: params.scope ?? "turn",
    source: "live",
    ...(params.sourceItemId ? { sourceItemId: params.sourceItemId } : {}),
    status: "finalized",
    threadId: params.threadId ?? "thread-a",
    totalCostMicros: 0,
    totalTokens: 0,
    ...(params.turnId ? { turnId: params.turnId } : {}),
    uncachedInputCostMicros: 0,
    uncachedInputTokens: 0,
    usageLineId: params.usageLineId,
    ...(params.usageTurnId ? { usageTurnId: params.usageTurnId } : {}),
  };
}

function invocation(params: {
  invocationId: string;
  itemId: string;
  observedAt: number;
  turnId?: string;
}): ThreadToolInvocationRecord {
  return {
    backend: "codex",
    threadId: "thread-a",
    ...(params.turnId ? { turnId: params.turnId } : {}),
    itemId: params.itemId,
    invocationId: params.invocationId,
    toolName: "commandExecution",
    category: "search",
    status: "completed",
    observedAt: params.observedAt,
    updatedAt: params.observedAt,
    outputChars: 0,
    outputLines: 0,
    estimatedOutputTokens: 0,
    warningLines: 0,
    errorLines: 0,
    infoLines: 0,
    debugLines: 0,
    outputTruncated: false,
    noisy: false,
  };
}
