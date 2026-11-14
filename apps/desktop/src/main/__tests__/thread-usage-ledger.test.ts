import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentEvent,
  AppServerBackendKind,
  ThreadSubAgentSummary,
  ThreadToolInvocationRecord,
  ThreadUsageLineRecord,
} from "@pwragent/shared";
import { createDesktopBackendRegistry, registryModules } from "../app-server/backend-registry-wiring";
import type { PendingLiveThreadUsageLine } from "../app-server/backend-registry-types";
import type { RegistryContext } from "../app-server/registry-context";
import { ActiveTurnKeySet, buildActiveTurnKey } from "../app-server/thread-turn-keys";
import {
  ThreadUsageLedger,
  type ThreadUsageLedgerDependencies,
  type ThreadUsageLedgerHost,
} from "../app-server/thread-usage-ledger";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import type { TokenMiserObjectMetadata } from "../token-miser/token-miser-types";
import { openInMemoryStateDb } from "./sqlite-test-utils";

/** The ledger's own state and steps, which only its tests reach. */
type LedgerInternals = {
  activeTokenMiserReplayEntries: Map<string, Map<string, TokenMiserObjectMetadata>>;
  liveThreadReplayInputCursor: Map<string, { cumulativeInputTokens: number }>;
  liveTokenMiserSubAgents: Map<string, Map<string, ThreadSubAgentSummary>>;
  pendingTokenMiserInterceptions: Map<string, TokenMiserObjectMetadata>;
  bufferLiveThreadUsageLine(pending: PendingLiveThreadUsageLine): void;
  bufferStreamedToolInvocationDelta(invocation: ThreadToolInvocationRecord): {
    current: ThreadToolInvocationRecord;
    previousOutputChars: number;
  };
  persistTokenMiserLedgerEntries(entries: readonly TokenMiserObjectMetadata[]): Promise<void>;
};

/** A ledger over a fixture context and host; nothing here touches SQLite. */
function createLedger(options: {
  stores?: Record<string, unknown>;
  host?: Partial<ThreadUsageLedgerHost>;
  closed?: boolean;
} = {}) {
  const lifecycle = { closed: options.closed ?? false };
  const context = {
    stores: { threads: {}, usage: {}, subAgents: {}, toolAccounting: {}, ...options.stores },
    providers: {},
    lifecycle,
    emit: async () => {},
  } as unknown as RegistryContext;
  const dependencies = {
    managedReviewService: { activeReviewSubAgentRecords: new Map(), reviewSubAgentRecordsByReviewTurn: new Map() },
    subAgentMonitorService: { liveCodexNativeSubAgentUsageRecords: new Map() },
  } as unknown as ThreadUsageLedgerDependencies;
  const host = {
    activeTurnKeys: new ActiveTurnKeySet(),
    captureUsageAccount: async () => undefined,
    tokenMiserStore: undefined,
    ...options.host,
  } as unknown as ThreadUsageLedgerHost;
  const ledger = new ThreadUsageLedger(context, dependencies, () => host);
  return { ledger, internals: ledger as unknown as LedgerInternals, lifecycle };
}

function usageLine(id: string, version: number): ThreadUsageLineRecord {
  return {
    backend: "codex",
    threadId: "thread-usage",
    turnId: "turn-usage",
    usageLineId: id,
    // Tells two writes of the same line apart.
    totalTokens: version,
  } as ThreadUsageLineRecord;
}

function outputDelta(invocationId: string, outputChars: number, outputLines: number): ThreadToolInvocationRecord {
  return {
    backend: "codex",
    threadId: "thread-tools",
    itemId: invocationId,
    invocationId,
    toolName: "exec_command",
    category: "build-test",
    status: "in_progress",
    observedAt: 1,
    updatedAt: 1,
    outputChars,
    outputLines,
    estimatedOutputTokens: 0,
    warningLines: 0,
    errorLines: 0,
    infoLines: 0,
    debugLines: 0,
    outputTruncated: false,
    noisy: false,
  };
}

function gate(params: {
  objectId: string;
  threadId: string;
  createdAt: number;
  replayTrackingVersion?: number;
  replayTrackingStoppedAt?: number;
}): TokenMiserObjectMetadata {
  return {
    objectId: params.objectId,
    threadId: params.threadId,
    createdAt: params.createdAt,
    ...(params.replayTrackingVersion === undefined ? {} : { replayTrackingVersion: params.replayTrackingVersion }),
    ...(params.replayTrackingStoppedAt === undefined ? {} : { replayTrackingStoppedAt: params.replayTrackingStoppedAt }),
  } as TokenMiserObjectMetadata;
}

function turnEvent(
  method: "turn/started" | "turn/completed" | "turn/failed" | "turn/cancelled",
  threadId: string,
  turnId: string,
): AgentEvent {
  return {
    backend: "codex",
    notification: { method, params: { threadId, turnId, turn: { id: turnId, status: "completed" } } },
  } as AgentEvent;
}

function createRegistry() {
  const db = openInMemoryStateDb();
  const registry = createDesktopBackendRegistry({
    codexClient: {
      close: async () => {}, getInitializeResult: async () => ({ methods: [] }),
      listThreads: async () => [], onNotification: () => () => {},
      onPendingRequest: () => () => {},
    } as never,
    overlayStore: new SqliteOverlayStore(db),
  });
  return { registry, db };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ThreadUsageLedger", () => {
  it("reads neither its host nor its stores until it is used", async () => {
    let bound = false;
    const completed: unknown[] = [];
    const context = {
      get stores() {
        if (!bound) throw new Error("store read while constructing");
        return { usage: { completeThreadUsageTurns: async (params: unknown) => { completed.push(params); } } };
      },
      lifecycle: { closed: false },
    } as unknown as RegistryContext;
    const host = () => {
      if (!bound) throw new Error("host read while constructing");
      const activeTurnKeys = new ActiveTurnKeySet();
      activeTurnKeys.add(buildActiveTurnKey("codex", "thread-a", "turn-a"));
      return { activeTurnKeys } as unknown as ThreadUsageLedgerHost;
    };
    const ledger = new ThreadUsageLedger(context, {} as ThreadUsageLedgerDependencies, host);
    bound = true;
    await ledger.completeRunningThreadUsageTurnsAtShutdown();
    expect(completed).toEqual([expect.objectContaining({
      turns: [{ backend: "codex", threadId: "thread-a", turnId: "turn-a" }],
    })]);
  });

  /**
   * The live usage flush window keeps the highest observation of each line,
   * keeping the earlier one on a tie; a flush takes the whole window and
   * writes it as one batch while new observations open the next window; a
   * failed batch goes back into that window, each line only if the window
   * holds no higher observation of it.
   */
  it("holds each usage line's highest observation and writes the window as one batch", async () => {
    vi.useFakeTimers();
    const observation = fc.record({ id: fc.integer({ min: 0, max: 3 }), sequence: fc.integer({ min: 0, max: 4 }) });
    const command = fc.oneof(
      fc.record({ kind: fc.constant("buffer" as const), observation }),
      fc.record({ kind: fc.constant("flush" as const), fail: fc.boolean(), duringWrite: fc.array(observation, { maxLength: 3 }) }),
    );
    await fc.assert(fc.asyncProperty(fc.array(command, { maxLength: 40 }), async (commands) => {
      type Held = { sequence: number; version: number };
      const batches: ThreadUsageLineRecord[][] = [];
      let window = new Map<string, Held>();
      let version = 0;
      let writing: { fail: boolean; duringWrite: Array<{ id: number; sequence: number }> } | undefined;
      const observe = (step: { id: number; sequence: number }) => {
        version += 1;
        const id = `line-${step.id}`;
        internals.bufferLiveThreadUsageLine({ backend: "codex", line: usageLine(id, version), observationSequence: step.sequence });
        const held = window.get(id);
        if (!held || step.sequence > held.sequence) window.set(id, { sequence: step.sequence, version });
      };
      const { ledger, internals } = createLedger({ stores: { usage: {
        upsertThreadUsageLines: async ({ lines }: { lines: ThreadUsageLineRecord[] }) => {
          // Usage keeps streaming while the batch is in flight.
          for (const step of writing!.duringWrite) observe(step);
          if (writing!.fail) throw new Error("fixture write failure");
          batches.push(lines);
        },
      } } });
      vi.spyOn(ledger, "emitThreadPricingUpdated").mockResolvedValue();
      for (const step of commands) {
        if (step.kind === "buffer") {
          observe(step.observation);
        } else {
          writing = step;
          const taken = window;
          window = new Map();
          const before = batches.length;
          await ledger.flushLiveThreadUsageLines();
          if (taken.size === 0) {
            window = taken;
            expect(batches).toHaveLength(before);
          } else if (step.fail) {
            expect(batches).toHaveLength(before);
            for (const [id, failed] of taken) {
              const newer = window.get(id);
              if (!newer || failed.sequence > newer.sequence) window.set(id, failed);
            }
          } else {
            expect(batches).toHaveLength(before + 1);
            const written = new Map(batches.at(-1)!.map((line) => [line.usageLineId, line.totalTokens]));
            expect(written).toEqual(new Map([...taken].map(([id, held]) => [id, held.version])));
          }
        }
        const pending = new Map([...ledger.pendingLiveThreadUsageLineRecords].map(([id, entry]) =>
          [id, { sequence: entry.observationSequence, version: entry.line.totalTokens }]));
        expect(pending).toEqual(window);
      }
    }), { numRuns: 300 });
  });

  /**
   * Streamed command output coalesces per invocation: a flush writes each
   * invocation once, and across flushes, some failing, the written output
   * adds up to exactly what streamed. A failed write goes back into the
   * window ahead of anything that streamed since.
   */
  it("writes every streamed output delta exactly once, one write per invocation per flush", async () => {
    vi.useFakeTimers();
    const command = fc.oneof(
      fc.record({ kind: fc.constant("stream" as const), id: fc.integer({ min: 0, max: 2 }), chars: fc.integer({ min: 1, max: 50 }), lines: fc.integer({ min: 0, max: 3 }) }),
      fc.record({
        kind: fc.constant("flush" as const),
        failing: fc.subarray(["call-0", "call-1", "call-2"]),
        duringWrite: fc.array(fc.record({ id: fc.integer({ min: 0, max: 2 }), chars: fc.integer({ min: 1, max: 50 }), lines: fc.integer({ min: 0, max: 3 }) }), { maxLength: 3 }),
      }),
    );
    await fc.assert(fc.asyncProperty(fc.array(command, { maxLength: 40 }), async (commands) => {
      const written = new Map<string, { chars: number; lines: number }>();
      const streamed = new Map<string, { chars: number; lines: number }>();
      let failing = new Set<string>();
      let duringWrite: Array<{ id: number; chars: number; lines: number }> = [];
      let flushWrites: string[] = [];
      const stream = (step: { id: number; chars: number; lines: number }) => {
        const id = `call-${step.id}`;
        const total = streamed.get(id) ?? { chars: 0, lines: 0 };
        const { current, previousOutputChars } = internals.bufferStreamedToolInvocationDelta(outputDelta(id, step.chars, step.lines));
        expect(previousOutputChars).toBe(total.chars);
        streamed.set(id, { chars: total.chars + step.chars, lines: total.lines + step.lines });
        expect(current.outputChars).toBe(total.chars + step.chars);
      };
      const { ledger, internals } = createLedger({ stores: { toolAccounting: {
        upsertThreadToolInvocation: async ({ invocation }: { invocation: ThreadToolInvocationRecord }) => {
          flushWrites.push(invocation.invocationId);
          // Output keeps streaming while the window is being written.
          for (const step of duringWrite.splice(0)) stream(step);
          if (failing.has(invocation.invocationId)) throw new Error("fixture write failure");
          const total = written.get(invocation.invocationId) ?? { chars: 0, lines: 0 };
          written.set(invocation.invocationId, {
            chars: total.chars + invocation.outputChars,
            lines: total.lines + invocation.outputLines,
          });
        },
      } } });
      for (const step of commands) {
        if (step.kind === "stream") {
          stream(step);
        } else {
          failing = new Set(step.failing);
          duringWrite = [...step.duringWrite];
          flushWrites = [];
          await ledger.flushStreamedToolInvocationDeltas();
          expect(new Set(flushWrites).size).toBe(flushWrites.length);
        }
      }
      failing = new Set();
      duringWrite = [];
      await ledger.flushStreamedToolInvocationDeltas();
      expect(written).toEqual(streamed);
    }), { numRuns: 300 });
  });

  /** Closing ends every running turn the registry knows, in one store write. */
  it("completes exactly the parseable running turns at shutdown, in one write", async () => {
    vi.useFakeTimers({ now: 42_000 });
    const name = fc.stringMatching(/^[a-z0-9]{1,6}$/);
    const turn = fc.record({ backend: fc.constantFrom<AppServerBackendKind>("codex", "claude"), threadId: name, turnId: name });
    const malformed = fc.constantFrom("garbage", "codex:no-turn-separator", "grok:thread:turn", ":thread:turn");
    await fc.assert(fc.asyncProperty(
      fc.uniqueArray(turn, { selector: (entry) => buildActiveTurnKey(entry.backend, entry.threadId, entry.turnId), maxLength: 6 }),
      fc.uniqueArray(malformed, { maxLength: 3 }),
      fc.boolean(),
      async (turns, garbage, failing) => {
        const activeTurnKeys = new ActiveTurnKeySet();
        for (const entry of turns) activeTurnKeys.add(buildActiveTurnKey(entry.backend, entry.threadId, entry.turnId));
        for (const key of garbage) activeTurnKeys.add(key);
        const writes: Array<{ completedAt: number; turns: unknown[] }> = [];
        const { ledger } = createLedger({
          host: { activeTurnKeys },
          stores: { usage: { completeThreadUsageTurns: async (params: { completedAt: number; turns: unknown[] }) => {
            writes.push(params);
            if (failing) throw new Error("fixture write failure");
          } } },
        });
        await expect(ledger.completeRunningThreadUsageTurnsAtShutdown()).resolves.toBeUndefined();
        if (turns.length === 0) {
          expect(writes).toEqual([]);
        } else {
          expect(writes).toHaveLength(1);
          expect(writes[0]!.completedAt).toBe(42_000);
          expect(writes[0]!.turns).toEqual(expect.arrayContaining(turns));
          expect(writes[0]!.turns).toHaveLength(turns.length);
        }
      },
    ), { numRuns: 300 });
  });

  /**
   * Reconciling the Token Miser ledger at startup stops each tracking gate
   * whose thread compacted after the gate was created, at that compaction,
   * then tracks exactly the gates still open and persists what the store now
   * holds.
   */
  it("stops gates compacted while closed and tracks exactly the gates still open", async () => {
    const threads = ["thread-0", "thread-1", "thread-2"];
    const gateInput = fc.record({
      threadId: fc.constantFrom(...threads),
      createdAt: fc.integer({ min: 0, max: 20 }),
      replayTrackingVersion: fc.constantFrom(1, 2),
      stoppedAt: fc.option(fc.integer({ min: 0, max: 20 }), { nil: undefined }),
      refusesStop: fc.boolean(),
    });
    const compactionTimes = fc.array(fc.integer({ min: 0, max: 20 }), { maxLength: 3 })
      .map((times) => [...times].sort((left, right) => left - right));
    await fc.assert(fc.asyncProperty(
      fc.array(gateInput, { maxLength: 8 }),
      fc.tuple(compactionTimes, compactionTimes, compactionTimes),
      async (inputs, compactions) => {
        const entries = inputs.map((input, index) => gate({
          objectId: `gate-${index}`,
          threadId: input.threadId,
          createdAt: input.createdAt,
          replayTrackingVersion: input.replayTrackingVersion,
          replayTrackingStoppedAt: input.stoppedAt,
        }));
        const refuses = new Set(inputs.flatMap((input, index) => input.refusesStop ? [`gate-${index}`] : []));
        const stops: Array<{ objectId: string; stoppedAt: number }> = [];
        const tokenMiserStore = {
          prune: async () => {},
          listMetadata: async () => entries.map((entry) => ({ ...entry })),
          stopReplayTracking: async (params: { objectId: string; stoppedAt: number }) => {
            stops.push(params);
            if (refuses.has(params.objectId)) return false;
            const entry = entries.find((candidate) => candidate.objectId === params.objectId)!;
            entry.replayTrackingStoppedAt = params.stoppedAt;
            return true;
          },
        };
        const { ledger, internals } = createLedger({
          host: { tokenMiserStore: tokenMiserStore as never },
          stores: { usage: {
            listThreadCompactions: async ({ threadId }: { threadId: string }) =>
              compactions[threads.indexOf(threadId)]!.map((observedAt) => ({ observedAt })),
          } },
        });
        const persisted: TokenMiserObjectMetadata[][] = [];
        vi.spyOn(internals, "persistTokenMiserLedgerEntries").mockImplementation(async (metadata) => {
          persisted.push([...metadata]);
        });

        // The oracle, from the inputs alone.
        const latest = (threadId: string) => compactions[threads.indexOf(threadId)]!.at(-1);
        const expectedStops = inputs.flatMap((input, index) => {
          const compactedAt = latest(input.threadId);
          return input.replayTrackingVersion === 2 && input.stoppedAt === undefined
            && compactedAt !== undefined && compactedAt > input.createdAt
            ? [{ objectId: `gate-${index}`, stoppedAt: compactedAt }]
            : [];
        });
        const stopped = new Set(expectedStops.flatMap((stop) => refuses.has(stop.objectId) ? [] : [stop.objectId]));
        const expectedOpen = new Map<string, Set<string>>();
        inputs.forEach((input, index) => {
          const objectId = `gate-${index}`;
          if (input.replayTrackingVersion !== 2 || input.stoppedAt !== undefined || stopped.has(objectId)) return;
          expectedOpen.set(input.threadId, (expectedOpen.get(input.threadId) ?? new Set()).add(objectId));
        });

        await ledger.initializeTokenMiserLedger();
        expect(stops).toEqual(expectedStops);
        const open = new Map([...internals.activeTokenMiserReplayEntries].map(([threadId, active]) =>
          [threadId, new Set(active.keys())]));
        expect(open).toEqual(expectedOpen);
        expect(persisted).toEqual([entries]);
      },
    ), { numRuns: 300 });
  });

  /**
   * A thread's last ended turn is remembered until its next turn starts.
   */
  it("remembers each thread's last ended turn until its next turn starts", async () => {
    const step = fc.record({
      method: fc.constantFrom("turn/started", "turn/completed", "turn/failed", "turn/cancelled") as fc.Arbitrary<
        "turn/started" | "turn/completed" | "turn/failed" | "turn/cancelled"
      >,
      thread: fc.constantFrom("thread-a", "thread-b"),
      turn: fc.constantFrom("turn-1", "turn-2", "turn-3"),
    });
    await fc.assert(fc.asyncProperty(fc.array(step, { maxLength: 30 }), async (steps) => {
      const { ledger } = createLedger();
      const model = new Map<string, string>();
      for (const entry of steps) {
        ledger.trackRecentThreadUsageTurn(turnEvent(entry.method, entry.thread, entry.turn));
        const key = `codex:${entry.thread}`;
        if (entry.method === "turn/started") model.delete(key);
        else model.set(key, entry.turn);
        expect(new Map([...ledger.recentlyCompletedThreadUsageTurnRecords].map(([thread, turn]) => [thread, turn.turnId])))
          .toEqual(model);
      }
    }), { numRuns: 300 });
  });

  it("replaces a pending live usage line for the hub, and the next flush writes the replacement", async () => {
    vi.useFakeTimers();
    const batches: ThreadUsageLineRecord[][] = [];
    const { ledger, internals } = createLedger({ stores: { usage: {
      upsertThreadUsageLines: async ({ lines }: { lines: ThreadUsageLineRecord[] }) => { batches.push(lines); },
    } } });
    vi.spyOn(ledger, "emitThreadPricingUpdated").mockResolvedValue();
    internals.bufferLiveThreadUsageLine({ backend: "codex", line: usageLine("line-terminal", 1), observationSequence: 3 });
    const pending = ledger.pendingLiveThreadUsageLineRecords.get("line-terminal")!;
    ledger.setPendingLiveThreadUsageLine("line-terminal", { ...pending, line: { ...pending.line, completedAt: 9_000 } });
    expect(ledger.pendingLiveThreadUsageLineRecords.get("line-terminal")?.line.completedAt).toBe(9_000);
    await ledger.flushLiveThreadUsageLines();
    expect(batches).toEqual([[expect.objectContaining({ usageLineId: "line-terminal", completedAt: 9_000 })]]);
  });

  it("holds a reported gate's metadata by object id until its usage is recorded", () => {
    const { ledger, internals } = createLedger();
    const first = gate({ objectId: "gate-1", threadId: "thread-a", createdAt: 1 });
    ledger.rememberPendingTokenMiserInterception(first);
    ledger.rememberPendingTokenMiserInterception({ ...first, createdAt: 2 });
    ledger.rememberPendingTokenMiserInterception(gate({ objectId: "gate-2", threadId: "thread-a", createdAt: 3 }));
    expect([...internals.pendingTokenMiserInterceptions.entries()]).toEqual([
      ["gate-1", expect.objectContaining({ createdAt: 2 })],
      ["gate-2", expect.objectContaining({ createdAt: 3 })],
    ]);
  });

  it("shows its live replay cursor and live gate cards as they change", () => {
    const { ledger, internals } = createLedger();
    expect(ledger.liveThreadReplayInputCursorRecords.size).toBe(0);
    internals.liveThreadReplayInputCursor.set("codex:thread-a", { cumulativeInputTokens: 1_234 });
    expect(ledger.liveThreadReplayInputCursorRecords.get("codex:thread-a")?.cumulativeInputTokens).toBe(1_234);
    const card = { monitorId: "system:token-miser:gate", task: "Gate", status: "success", createdAt: 1, updatedAt: 1 } as ThreadSubAgentSummary;
    internals.liveTokenMiserSubAgents.set("thread-a", new Map([[card.monitorId, card]]));
    expect(ledger.liveTokenMiserSubAgentRecords.get("thread-a")?.get(card.monitorId)).toBe(card);
    expect(ledger.listLiveTokenMiserSubAgents("thread-a")).toEqual([card]);
  });

  it("exposes the reconciliation in flight, which settles only once the ledger is restored", async () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const tokenMiserStore = {
      prune: async () => {},
      listMetadata: async () => { await released; return []; },
      stopReplayTracking: async () => false,
    };
    const { ledger, internals } = createLedger({ host: { tokenMiserStore: tokenMiserStore as never } });
    vi.spyOn(internals, "persistTokenMiserLedgerEntries").mockResolvedValue();
    await expect(ledger.currentTokenMiserLedgerReconciliation).resolves.toBeUndefined();
    const reconciliation = ledger.initializeTokenMiserLedger();
    expect(ledger.currentTokenMiserLedgerReconciliation).toBe(reconciliation);
    let settled = false;
    void ledger.currentTokenMiserLedgerReconciliation.then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    release();
    await reconciliation;
    expect(settled).toBe(true);
  });

  it("is the ledger the registry's facades and hub read", async () => {
    const { registry, db } = createRegistry();
    try {
      const ledger = registryModules(registry).threadUsageLedger;
      const card = { monitorId: "system:token-miser:gate", task: "Gate", status: "success", createdAt: 1, updatedAt: 1 } as ThreadSubAgentSummary;
      (ledger as unknown as LedgerInternals).liveTokenMiserSubAgents.set("thread-a", new Map([[card.monitorId, card]]));
      expect(registry.listLiveTokenMiserSubAgents("thread-a")).toEqual([card]);
      expect(registry.mergeLiveTokenMiserSubAgents("thread-a", [])).toEqual([card]);
      expect(registry.readLiveSubAgentRevisionSource("thread-a")).toEqual([[card], []]);
      const flush = vi.spyOn(ledger, "flushLiveThreadUsageLines");
      await registry.publishLocalEvent(turnEvent("turn/completed", "thread-a", "turn-1"));
      expect(flush).toHaveBeenCalled();
      expect(ledger.recentlyCompletedThreadUsageTurnRecords.get("codex:thread-a")?.turnId).toBe("turn-1");
    } finally {
      await registry.close();
      db.close();
    }
  });
});
