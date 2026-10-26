import { estimateTokenUsageCost } from "@pwragent/shared";
import type {
  ThreadSubAgentSummary,
  ThreadToolAccounting,
  ThreadToolInvocationRecord,
  ThreadUsageLineRecord,
} from "@pwragent/shared";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import type { TokenMiserObjectMetadata } from "../token-miser/token-miser-types";
import { openInMemoryStateDb } from "./sqlite-test-utils";
import { TestTokenMiserStore } from "./token-miser-test-store";

// Thread reads price every Token Miser gate. A packaged profile showed that
// work scanning the whole pricing ledger and re-sorting every tool invocation
// once per gate, and building card text that the totals discard. These tests
// drive the production read, persist, and live-replay paths with a contrived
// workload of G gates, P usage lines, and I invocations, and count the record
// properties each path reads. A count is a pure function of the code path, so
// a budget can be exact about scaling without measuring time.

const THREAD_ID = "thread-scale";
const GATE_MODEL = "gpt-5.6-luna";
const PARENT_MODELS = ["gpt-5.6-terra", "gpt-6-astra"] as const;
const VARIANTS = 8;

type Workload = {
  entries: TokenMiserObjectMetadata[];
  invocations: ThreadToolInvocationRecord[];
  liveLines: ThreadUsageLineRecord[];
  persistedLines: ThreadUsageLineRecord[];
};

type Internals = {
  tokenMiserStore?: TestTokenMiserStore;
  liveTokenMiserUsageLines: Map<string, Map<string, ThreadUsageLineRecord>>;
  liveTokenMiserSubAgents: Map<string, Map<string, ThreadSubAgentSummary>>;
  withTokenMiserAccounting(params: {
    accounting: ThreadToolAccounting;
    backend: "codex";
    threadId: string;
  }): Promise<ThreadToolAccounting>;
  persistTokenMiserLedgerEntries(
    entries: readonly TokenMiserObjectMetadata[],
  ): Promise<void>;
  publishLiveTokenMiserReplayEntries(
    entries: readonly TokenMiserObjectMetadata[],
  ): Promise<void>;
};

describe("Token Miser savings scaling", () => {
  let directory: string;
  let stateDb: StateDb;
  let store: SqliteOverlayStore;
  let registry: DesktopBackendRegistry;
  let internals: Internals;

  beforeEach(() => {
    directory = mkdtempSync(path.join(os.tmpdir(), "pwragent-token-miser-scale-"));
    stateDb = openInMemoryStateDb();
    store = new SqliteOverlayStore(stateDb);
    registry = new DesktopBackendRegistry({
      codexClient: {
        close: async () => {},
        getInitializeResult: async () => ({ methods: [] }),
        listThreads: async () => [],
        onNotification: () => () => {},
        onPendingRequest: () => () => {},
      } as never,
      overlayStore: store,
    });
    internals = registry as unknown as Internals;
    internals.tokenMiserStore = new TestTokenMiserStore(
      path.join(directory, "token-miser"),
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    try {
      await registry.close();
    } finally {
      stateDb.close();
      rmSync(directory, { force: true, recursive: true });
    }
  });

  async function readSavings(
    work: Workload,
    counter: ReadCounter = new ReadCounter(),
  ) {
    const lines = counter.wrap("pricing", work.persistedLines);
    vi.spyOn(store, "readThreadPricing").mockResolvedValue({ lines, summaries: [] });
    vi.spyOn(internals.tokenMiserStore!, "listMetadata").mockResolvedValue(work.entries);
    internals.liveTokenMiserUsageLines.set(
      THREAD_ID,
      new Map(counter.wrap("pricing", work.liveLines).map((line) => [line.usageLineId, line])),
    );
    const accounting = await store.readThreadToolAccounting({
      backend: "codex",
      threadId: THREAD_ID,
    });
    return internals.withTokenMiserAccounting({
      accounting: {
        ...accounting,
        invocations: counter.wrap("invocations", work.invocations),
      },
      backend: "codex",
      threadId: THREAD_ID,
    });
  }

  it("keeps thread-read savings totals and replay counts identical to the per-gate path", async () => {
    const result = (await readSavings(buildWorkload(2))).tokenMiser!;
    expect(result.savings).toMatchInlineSnapshot(`
      {
        "currency": "USD",
        "directlyObservedReplayCount": 7,
        "gateCostMicros": 4828,
        "gateCount": 16,
        "gateModel": "gpt-5.6-luna",
        "helperDecisionCount": 14,
        "helperPassThroughCount": 2,
        "parentModel": "gpt-5.6-terra",
        "passThroughCount": 4,
        "policyPassThroughCount": 2,
        "pricedGateCount": 12,
        "reconstructedReplayCount": 18,
        "revealedCostMicros": 14566,
        "savingsMicros": 330034,
        "withoutGateCostMicros": 349428,
      }
    `);
    expect(result.cachedReplayCount).toMatchInlineSnapshot(`30`);
    expect(result.interceptions?.map((entry) =>
      `${entry.objectId} ${entry.cachedReplayCount} ${entry.cachedBaselineTokens} ${entry.cachedRevealedTokens}`
    )).toMatchInlineSnapshot(`
      [
        "gate-0000 0 0 0",
        "gate-0001 1 3060 103",
        "gate-0002 7 21840 735",
        "gate-0003 3 9540 360",
        "gate-0004 3 9720 930",
        "gate-0005 0 0 0",
        "gate-0006 2 6720 230",
        "gate-0007 3 10260 300",
        "gate-0008 3 10440 360",
        "gate-0009 1 3540 105",
        "gate-0010 0 0 0",
        "gate-0011 1 3660 120",
        "gate-0012 3 11160 939",
        "gate-0013 1 3780 115",
        "gate-0014 2 7680 200",
        "gate-0015 0 0 0",
      ]
    `);
  });

  it("keeps persisted and live gate artifacts identical", async () => {
    const work = buildWorkload(1);
    vi.spyOn(store, "readThreadPricing").mockResolvedValue({
      lines: work.persistedLines,
      summaries: [],
    });
    vi.spyOn(store, "readTokenMiserGatePricingLines").mockResolvedValue(work.persistedLines);
    vi.spyOn(store, "readThreadToolAccounting").mockImplementation(async (params) => ({
      ...await (SqliteOverlayStore.prototype.readThreadToolAccounting.call(store, params)),
      invocations: work.invocations,
    }));
    await internals.persistTokenMiserLedgerEntries(work.entries);
    const overlay = await store.getThreadOverlayState({ backend: "codex", threadId: THREAD_ID });
    expect(overlay?.subAgents?.map(projectSubAgent)).toMatchSnapshot("persisted sub-agents");

    internals.liveTokenMiserUsageLines.set(
      THREAD_ID,
      new Map([...work.persistedLines, ...work.liveLines].map((line) => [line.usageLineId, line])),
    );
    await internals.publishLiveTokenMiserReplayEntries(work.entries);
    expect(
      [...internals.liveTokenMiserSubAgents.get(THREAD_ID)!.values()].map(projectSubAgent),
    ).toMatchSnapshot("live replay sub-agents");
    expect(
      [...internals.liveTokenMiserUsageLines.get(THREAD_ID)!.values()]
        .map((line) => [line.usageLineId, line.totalCostMicros, line.createdAt]),
    ).toMatchSnapshot("live replay usage lines");
  });

  it("skips the invocation read when every persisted gate tracks replays directly", async () => {
    const work = buildWorkload(1);
    const observed = work.entries.filter((entry) => entry.replayTrackingVersion === 2);
    expect(observed.length).toBeGreaterThan(0);
    vi.spyOn(store, "readThreadPricing").mockResolvedValue({
      lines: work.persistedLines,
      summaries: [],
    });
    vi.spyOn(store, "readTokenMiserGatePricingLines").mockResolvedValue(work.persistedLines);
    const readInvocations = vi.spyOn(store, "readThreadToolAccounting");
    await internals.persistTokenMiserLedgerEntries(observed);
    expect(readInvocations).not.toHaveBeenCalled();
    const overlay = await store.getThreadOverlayState({ backend: "codex", threadId: THREAD_ID });
    expect(overlay?.subAgents?.map((subAgent) => subAgent.monitorId).sort()).toEqual(
      observed.map((entry) => `system:token-miser:${entry.objectId}`).sort(),
    );
  });

  it("reads the pricing ledger and invocations a bounded number of times per thread read", async () => {
    const measured = [];
    for (const multiple of [6, 24]) {
      const work = buildWorkload(multiple);
      const counter = new ReadCounter();
      // Spies are restored per sample: re-spying returns the same spy, whose
      // calls would otherwise accumulate across samples.
      const formats = countNumberFormatting();
      const result = await readSavings(work, counter);
      const formatting = formats.calls();
      formats.restore();
      expect(result.tokenMiser?.savings?.gateCount).toBe(work.entries.length);
      measured.push({
        formatting,
        gates: work.entries.length,
        invocationReads: counter.reads.invocations,
        invocations: work.invocations.length,
        lineReads: counter.reads.pricing,
        lines: work.persistedLines.length + work.liveLines.length,
      });
    }
    for (const sample of measured) {
      // Linear budgets: one index pass per record, plus the fields each gate
      // reads from the two lines it resolves. A per-gate scan is G × P.
      expect(sample).toMatchObject({ formatting: 0 });
      expect(sample.lineReads).toBeLessThanOrEqual(
        LINE_READS_PER_LINE * sample.lines + LINE_READS_PER_GATE * sample.gates,
      );
      expect(sample.invocationReads).toBeLessThanOrEqual(
        INVOCATION_READS_PER_INVOCATION * sample.invocations,
      );
    }
    // Four times the workload costs about four times the reads; a per-gate
    // scan costs about sixteen times.
    const [small, large] = measured as [typeof measured[0], typeof measured[0]];
    expect(large.lineReads).toBeLessThanOrEqual(SCALING_LIMIT * small.lineReads);
    expect(large.invocationReads).toBeLessThanOrEqual(
      SCALING_LIMIT * small.invocationReads,
    );
  });

  it("persists and republishes gate cards with linear ledger reads", async () => {
    const measured = [];
    for (const multiple of [6, 24]) {
      const work = buildWorkload(multiple);
      const counter = new ReadCounter();
      const lines = counter.wrap("pricing", work.persistedLines);
      const invocations = counter.wrap("invocations", work.invocations);
      // Count the persist path's own ledger read, here given every line to
      // bound the indexing itself. The pricing publish after the write
      // re-reads and emits the whole ledger once, which is O(P) regardless
      // of how gates are priced.
      vi.spyOn(store, "readTokenMiserGatePricingLines").mockResolvedValueOnce(lines);
      vi.spyOn(store, "readThreadPricing")
        .mockResolvedValue({ lines: work.persistedLines, summaries: [] });
      vi.spyOn(store, "readThreadToolAccounting").mockImplementation(async (params) => ({
        ...await (SqliteOverlayStore.prototype.readThreadToolAccounting.call(store, params)),
        invocations,
      }));
      await internals.persistTokenMiserLedgerEntries(work.entries);
      const persistReads = { ...counter.reads };
      internals.liveTokenMiserUsageLines.set(
        THREAD_ID,
        new Map(counter.wrap("pricing", [...work.persistedLines, ...work.liveLines])
          .map((line) => [line.usageLineId, line])),
      );
      counter.reads.pricing = 0;
      await internals.publishLiveTokenMiserReplayEntries(work.entries);
      measured.push({
        gates: work.entries.length,
        invocations: work.invocations.length,
        lines: work.persistedLines.length + work.liveLines.length,
        liveLineReads: counter.reads.pricing,
        persistInvocationReads: persistReads.invocations,
        persistLineReads: persistReads.pricing,
      });
      vi.restoreAllMocks();
      internals.liveTokenMiserSubAgents.clear();
      internals.liveTokenMiserUsageLines.clear();
    }
    for (const sample of measured) {
      const lineBudget =
        LINE_READS_PER_LINE * sample.lines + LINE_READS_PER_GATE * sample.gates;
      expect(sample.persistLineReads).toBeLessThanOrEqual(lineBudget);
      expect(sample.liveLineReads).toBeLessThanOrEqual(lineBudget);
      expect(sample.persistInvocationReads).toBeLessThanOrEqual(
        INVOCATION_READS_PER_INVOCATION * sample.invocations,
      );
    }
    const [small, large] = measured as [typeof measured[0], typeof measured[0]];
    for (const key of ["liveLineReads", "persistInvocationReads", "persistLineReads"] as const) {
      expect(large[key]).toBeLessThanOrEqual(SCALING_LIMIT * small[key]);
    }
  });
});

// Per-record budgets. Indexing reads a few fields of every line and
// invocation once; each gate then reads the fields of the two lines it
// resolved. The per-gate scans read about 15× these budgets at 48 gates.
const LINE_READS_PER_LINE = 6;
const LINE_READS_PER_GATE = 16;
const INVOCATION_READS_PER_INVOCATION = 6;
const SCALING_LIMIT = 4.5;

class ReadCounter {
  readonly reads = { invocations: 0, pricing: 0 };

  wrap<T extends object>(kind: keyof ReadCounter["reads"], records: readonly T[]): T[] {
    const reads = this.reads;
    return records.map((record) => new Proxy(record, {
      get(target, key, receiver) {
        reads[kind] += 1;
        return Reflect.get(target, key, receiver);
      },
    }));
  }
}

/**
 * Counts locale number formatting: the gate card's character counts and the
 * helper usage summary both format through these. Savings totals need none.
 */
function countNumberFormatting(): { calls(): number; restore(): void } {
  const toLocaleString = vi.spyOn(Number.prototype, "toLocaleString");
  const NumberFormat = Intl.NumberFormat;
  let constructed = 0;
  const numberFormat = vi.spyOn(Intl, "NumberFormat").mockImplementation(function (
    this: unknown,
    ...args: ConstructorParameters<typeof Intl.NumberFormat>
  ) {
    constructed += 1;
    return new NumberFormat(...args);
  } as typeof Intl.NumberFormat);
  return {
    calls: () => toLocaleString.mock.calls.length + constructed,
    restore: () => {
      toLocaleString.mockRestore();
      numberFormat.mockRestore();
    },
  };
}

function projectSubAgent(subAgent: ThreadSubAgentSummary) {
  const {
    ownerRegistrySessionId: _ownerRegistrySessionId,
    ownerRuntimeInstanceId: _ownerRuntimeInstanceId,
    ...rest
  } = subAgent;
  return rest;
}

/**
 * `multiple` copies of eight gate variants, each pair of gates sharing a
 * parent turn. P and I grow linearly with G.
 */
function buildWorkload(multiple: number): Workload {
  const entries: TokenMiserObjectMetadata[] = [];
  const persistedLines: ThreadUsageLineRecord[] = [];
  const liveLines: ThreadUsageLineRecord[] = [];
  const invocations: ThreadToolInvocationRecord[] = [];
  let observedAt = 1_800_000_000_000;
  const gateCount = multiple * VARIANTS;

  for (let index = 0; index < gateCount; index += 1) {
    const variant = index % VARIANTS;
    const sharedTurn = `turn-${Math.floor(index / 2)}`;
    const turnId = variant === 6
      ? `orphan-turn-${index}`
      : variant === 7
        ? `stamped-turn-${index}`
        : sharedTurn;
    const objectId = `gate-${String(index).padStart(4, "0")}`;
    const monitorId = `system:token-miser:${objectId}`;
    const toolUseId = `tool-${index}`;
    const helperModel = variant === 5 ? "unknown-fixture-model" : GATE_MODEL;
    const entry: TokenMiserObjectMetadata = {
      version: 1,
      objectId,
      threadId: THREAD_ID,
      turnId,
      toolUseId,
      toolName: index % 3 === 0 ? "commandExecution" : "mcpToolCall",
      createdAt: 1_800_000_000_000 + index,
      originalCharacters: 12_000 + 250 * index,
      baselineParentTokens: 3_000 + 60 * index,
      replacementCharacters: 400 + 10 * (index % 7),
      retrievedCharacters: index % 4 === 0 ? 800 : 0,
      summary: {
        summary: "Large fixture result.",
        usefulDetails: [],
        suggestedNextStep: "Read a targeted range.",
      },
      ...(variant === 2 ? {} : {
        helperUsage: {
          helperThreadId: `helper-thread-${index}`,
          helperTurnId: `helper-turn-${index}`,
          model: helperModel,
          reasoningEffort: "medium",
          tokenUsage: {
            inputTokens: 1_500 + 10 * index,
            cachedInputTokens: 200,
            outputTokens: 80 + (index % 9),
            totalTokens: 1_580 + 10 * index + (index % 9),
          },
        },
      }),
      ...(variant === 2 || variant === 3 ? { disposition: "passed_through" as const } : { disposition: "summarized" as const }),
      ...(variant === 0 || variant === 3 || index % 5 === 0
        ? {
            replayTrackingVersion: 2 as const,
            cachedReplayCount: index % 5,
            cachedBaselineTokens: (3_000 + 60 * index) * (index % 5),
            cachedRevealedTokens: 120 * (index % 5),
          }
        : {}),
      ...(variant === 7 ? { parentModel: PARENT_MODELS[index % 2], parentServiceTier: "standard" } : {}),
    };
    entries.push(entry);

    if (variant === 0 || variant === 3) {
      persistedLines.push(gateLine({ monitorId, index, inputTokens: 1_500 + 10 * index }));
    }
    if (variant === 3) {
      // Persisted lines precede live ones; the persisted price must win.
      liveLines.push(gateLine({ monitorId, index, inputTokens: 9_000, live: true }));
    }
    if (variant === 4) {
      liveLines.push(gateLine({ monitorId, index, inputTokens: 2_200, live: true }));
    }

    // Every gate's own tool call plus later model round trips in its turn.
    for (let step = 0; step < 2 + (index % 4); step += 1) {
      observedAt += step === 1 ? 0 : 1; // A tie forces the invocationId tiebreak.
      invocations.push(invocation({
        itemId: step === 0 ? toolUseId : `${toolUseId}-follow-${step}`,
        invocationId: `invocation-${String(index).padStart(4, "0")}-${step}`,
        observedAt,
        turnId,
      }));
    }

    if (index % 2 === 0) {
      const model = PARENT_MODELS[(index / 2) % 2]!;
      const other = PARENT_MODELS[((index / 2) + 1) % 2]!;
      persistedLines.push(
        // Never a parent: another thread, a monitor line, or no model.
        parentLine({ id: `${sharedTurn}-other-thread`, model, threadId: "thread-other", turnId: sharedTurn }),
        parentLine({ id: `${sharedTurn}-monitor`, model, scope: "monitor", turnId: sharedTurn }),
        parentLine({ id: `${sharedTurn}-no-model`, turnId: sharedTurn }),
        // First match is by usage turn; a later direct turn match must lose.
        parentLine({
          id: `${sharedTurn}-usage-turn`,
          model,
          serviceTier: index % 4 === 0 ? "priority" : "standard",
          turnId: `request-${sharedTurn}`,
          usageTurnId: sharedTurn,
        }),
        parentLine({ id: `${sharedTurn}-later`, model: other, turnId: sharedTurn }),
      );
    }
  }

  // Focused helper inference is charged separately from any gate.
  persistedLines.push(
    gateLine({ monitorId: "system:token-miser-focused:focus-a", index: 9_001, inputTokens: 700 }),
    gateLine({ monitorId: "system:token-miser-focused:focus-b", index: 9_002, inputTokens: 900 }),
  );
  return { entries, invocations, liveLines, persistedLines };
}

function gateLine(params: {
  index: number;
  inputTokens: number;
  live?: boolean;
  monitorId: string;
}): ThreadUsageLineRecord {
  const outputTokens = 90;
  const cost = estimateTokenUsageCost({
    cachedInputTokens: 0,
    model: GATE_MODEL,
    outputTokens,
    uncachedInputTokens: params.inputTokens,
  })!;
  return {
    backend: "codex",
    cachedInputCostMicros: cost.cachedInputCostMicros,
    cachedInputTokens: 0,
    createdAt: 1_800_000_100_000 + params.index,
    currency: "USD",
    inputTokens: params.inputTokens,
    model: GATE_MODEL,
    outputCostMicros: cost.outputCostMicros,
    outputTokens,
    parentThreadId: THREAD_ID,
    priceStatus: "priced",
    provider: "openai",
    reasoningOutputTokens: 0,
    scope: "monitor",
    source: params.live ? "live" : "monitor",
    sourceItemId: params.monitorId,
    status: "finalized",
    threadId: `helper-thread-${params.index}`,
    totalCostMicros: cost.totalCostMicros,
    totalTokens: params.inputTokens + outputTokens,
    turnId: `helper-turn-${params.index}`,
    uncachedInputCostMicros: cost.uncachedInputCostMicros,
    uncachedInputTokens: params.inputTokens,
    usageLineId: `${params.monitorId}:${params.live ? "live" : "persisted"}`,
  };
}

function parentLine(params: {
  id: string;
  model?: string;
  scope?: ThreadUsageLineRecord["scope"];
  serviceTier?: string;
  threadId?: string;
  turnId: string;
  usageTurnId?: string;
}): ThreadUsageLineRecord {
  return {
    backend: "codex",
    cachedInputCostMicros: 0,
    cachedInputTokens: 4_000,
    createdAt: 1_800_000_000_000,
    currency: "USD",
    inputTokens: 10_000,
    ...(params.model ? { model: params.model } : {}),
    outputCostMicros: 0,
    outputTokens: 100,
    priceStatus: "unpriced",
    provider: "openai",
    reasoningOutputTokens: 0,
    scope: params.scope ?? "turn",
    serviceTier: params.serviceTier ?? "standard",
    source: "live",
    sourceItemId: "thread-token-usage",
    status: "finalized",
    threadId: params.threadId ?? THREAD_ID,
    totalCostMicros: 0,
    totalTokens: 10_100,
    turnId: params.turnId,
    ...(params.usageTurnId ? { usageTurnId: params.usageTurnId } : {}),
    uncachedInputCostMicros: 0,
    uncachedInputTokens: 6_000,
    usageLineId: `parent:${params.id}`,
  };
}

function invocation(params: {
  invocationId: string;
  itemId: string;
  observedAt: number;
  turnId: string;
}): ThreadToolInvocationRecord {
  return {
    backend: "codex",
    threadId: THREAD_ID,
    turnId: params.turnId,
    itemId: params.itemId,
    invocationId: params.invocationId,
    toolName: "commandExecution",
    category: "search",
    status: "completed",
    observedAt: params.observedAt,
    updatedAt: params.observedAt,
    outputChars: 1_000,
    outputLines: 10,
    estimatedOutputTokens: 250,
    warningLines: 0,
    errorLines: 0,
    infoLines: 0,
    debugLines: 0,
    outputTruncated: false,
    noisy: false,
  };
}
