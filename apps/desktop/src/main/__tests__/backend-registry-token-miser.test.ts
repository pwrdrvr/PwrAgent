import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AgentEvent,
  NavigationSnapshot,
  ThreadToolInvocationRecord,
  ThreadUsageLineRecord,
} from "@pwragent/shared";
import type { TokenMiserObjectMetadata } from "../token-miser/token-miser-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";

describe("DesktopBackendRegistry Token Miser ledger", () => {
  let directory: string;
  let registry: DesktopBackendRegistry;
  let stateDb: StateDb;
  let store: SqliteOverlayStore;

  beforeEach(() => {
    directory = mkdtempSync(path.join(os.tmpdir(), "pwragent-token-miser-ledger-"));
    stateDb = StateDb.open(path.join(directory, "state.db"));
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
  });

  afterEach(async () => {
    await registry.close();
    stateDb.close();
    rmSync(directory, { force: true, recursive: true });
  });

  it("batches gate cards and Luna usage into the parent ledgers", async () => {
    await store.upsertThreadUsageLine({
      line: {
        backend: "codex",
        cachedInputCostMicros: 0,
        cachedInputTokens: 0,
        createdAt: 1_800_000_000_000,
        currency: "USD",
        inputTokens: 10_000,
        model: "gpt-5.6-terra",
        outputCostMicros: 0,
        outputTokens: 100,
        priceStatus: "unpriced",
        provider: "openai",
        reasoningOutputTokens: 0,
        scope: "turn",
        serviceTier: "standard",
        source: "live",
        sourceItemId: "thread-token-usage",
        status: "finalized",
        threadId: "thread-parent",
        totalCostMicros: 0,
        totalTokens: 10_100,
        turnId: "turn-parent",
        uncachedInputCostMicros: 0,
        uncachedInputTokens: 10_000,
        usageLineId: "parent-turn-usage",
      },
    });
    await Promise.all([
      store.upsertThreadToolInvocation({
        invocation: toolInvocation("tool-1", 1),
      }),
      store.upsertThreadToolInvocation({
        invocation: toolInvocation("tool-2", 2),
      }),
      store.upsertThreadToolInvocation({
        invocation: toolInvocation("tool-3", 3),
      }),
      store.upsertThreadToolInvocation({
        invocation: toolInvocation("tool-4", 4),
      }),
    ]);
    const upsertSubAgents = vi.spyOn(store, "upsertThreadSubAgents");
    const upsertUsageLines = vi.spyOn(store, "upsertThreadUsageLines");
    const persist = (
      registry as unknown as {
        persistTokenMiserLedgerEntries(
          metadata: readonly TokenMiserObjectMetadata[],
        ): Promise<void>;
      }
    ).persistTokenMiserLedgerEntries.bind(registry);

    await persist([metadata("gate-1", "helper-1"), metadata("gate-2", "helper-2")]);

    expect(upsertSubAgents).toHaveBeenCalledTimes(1);
    expect(upsertUsageLines).toHaveBeenCalledTimes(1);
    const overlay = await store.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-parent",
    });
    expect(overlay?.subAgents).toHaveLength(2);
    expect(overlay?.subAgents?.[0]).toMatchObject({
      agentName: "Token Miser",
      monitorId: "system:token-miser:gate-2",
      monitorThreadId: "helper-2",
      preferredModel: "gpt-5.6-luna",
      preferredReasoningEffort: "medium",
      status: "success",
      tokenMiserAccounting: {
        baselineParentCostMicros: 12_000,
        baselineParentTokens: 6_000,
        cachedReplayCount: 1,
        cachedBaselineTokens: 6_000,
        gateCostMicros: 520,
        gateModel: "gpt-5.6-luna",
        gateTotalTokens: 2_100,
        originalModel: "gpt-5.6-terra",
        revealedParentCostMicros: 450,
        revealedParentTokens: 225,
        cachedRevealedTokens: 225,
      },
    });
    const accounting = overlay?.subAgents?.[0]?.tokenMiserAccounting;
    expect(accounting?.cachedBaselineCostMicros).toBeGreaterThan(0);
    expect(accounting?.cachedRevealedCostMicros).toBeGreaterThan(0);
    expect(accounting?.savingsMicros).toBe(
      accounting!.baselineParentCostMicros
      + accounting!.cachedBaselineCostMicros!
      - accounting!.gateCostMicros
      - accounting!.revealedParentCostMicros
      - accounting!.cachedRevealedCostMicros!,
    );
    expect(accounting?.savingsMicros).toBeGreaterThan(11_030);
    const pricing = await store.readThreadPricing({
      backend: "codex",
      threadId: "thread-parent",
    });
    const gateLines = pricing.lines.filter((line) => line.scope === "monitor");
    expect(gateLines).toHaveLength(2);
    expect(gateLines[0]).toMatchObject({
      model: "gpt-5.6-luna",
      parentThreadId: "thread-parent",
      scope: "monitor",
      sourceItemId: "system:token-miser:gate-2",
      totalTokens: 2_100,
    });

    await persist([metadata("gate-1", "helper-1"), metadata("gate-2", "helper-2")]);
    expect(upsertSubAgents).toHaveBeenCalledTimes(1);
    expect(upsertUsageLines).toHaveBeenCalledTimes(1);
  });

  it("labels a deliberate pass-through as an evaluation with no claimed token savings", async () => {
    const persist = (
      registry as unknown as {
        persistTokenMiserLedgerEntries(
          metadata: readonly TokenMiserObjectMetadata[],
        ): Promise<void>;
      }
    ).persistTokenMiserLedgerEntries.bind(registry);
    await persist([{
      ...metadata("gate-1", "helper-1"),
      disposition: "passed_through",
      replacementCharacters: 24_000,
      parentModel: "gpt-5.6-sol",
    }]);

    const overlay = await store.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-parent",
    });
    expect(overlay?.subAgents?.[0]).toMatchObject({
      task: "Evaluate commandExecution output",
      lastMessage:
        "Passed 24,000 characters from commandExecution through unchanged after evaluation.",
      completionSource: {
        reason: "system_token_miser_pass_through",
      },
      tokenMiserAccounting: {
        disposition: "passed_through",
        baselineParentTokens: 6_000,
        revealedParentTokens: 6_000,
      },
    });
    expect(
      overlay?.subAgents?.[0]?.tokenMiserAccounting?.savingsMicros,
    ).toBeLessThan(0);
  });

  // A native review runs on the parent thread with no usage line of its own,
  // and its hook fires under an inner turn id that no line will ever carry.
  // The model stamped at creation is the only rate source such a gate has.
  // Reconcile used to compare only the accounting, so a gate whose numbers had
  // not moved was never rewritten — and a field the rail newly renders never
  // reached it. After a restart every existing gate stayed un-nested.
  it("rewrites a persisted gate when its rendered projection changes", async () => {
    const persist = (
      registry as unknown as {
        persistTokenMiserLedgerEntries(
          metadata: readonly TokenMiserObjectMetadata[],
        ): Promise<void>;
      }
    ).persistTokenMiserLedgerEntries.bind(registry);

    // A gate persisted by an older build: same accounting, no parentTurnId.
    await store.upsertThreadSubAgents({
      backend: "codex",
      threadId: "thread-parent",
      subAgents: [{
        agentName: "Token Miser",
        backend: "codex",
        createdAt: 1_800_000_000_001,
        monitorId: "system:token-miser:gate-1",
        status: "success",
        task: "Gate commandExecution output",
        updatedAt: 1_800_000_000_001,
      }],
    });
    const upsertSubAgents = vi.spyOn(store, "upsertThreadSubAgents");

    await persist([metadata("gate-1", "helper-1")]);

    expect(upsertSubAgents).toHaveBeenCalledTimes(1);
    const overlay = await store.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-parent",
    });
    expect(overlay?.subAgents?.[0]?.parentTurnId).toBe("turn-parent");

    // And once the projection matches, a second reconcile is a no-op.
    await persist([metadata("gate-1", "helper-1")]);
    expect(upsertSubAgents).toHaveBeenCalledTimes(1);
  });

  it("prices a gate from its stamped parent model when no parent line exists", async () => {
    const persist = (
      registry as unknown as {
        persistTokenMiserLedgerEntries(
          metadata: readonly TokenMiserObjectMetadata[],
        ): Promise<void>;
      }
    ).persistTokenMiserLedgerEntries.bind(registry);

    await persist([{
      ...metadata("gate-1", "helper-1"),
      parentModel: "gpt-5.6-sol",
      parentServiceTier: "standard",
      replayTrackingVersion: 2,
      turnId: "review-inner-turn-with-no-usage-line",
    }]);

    const overlay = await store.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-parent",
    });
    const accounting = overlay?.subAgents?.[0]?.tokenMiserAccounting;
    expect(accounting).toBeDefined();
    expect(accounting?.originalModel).toBe("gpt-5.6-sol");
    expect(accounting?.originalServiceTier).toBe("standard");
    // No replays were observed, so this is baseline once − revealed once −
    // summarizer: honest, small, and non-zero.
    expect(accounting?.cachedReplayCount).toBe(0);
    expect(accounting?.baselineParentCostMicros).toBeGreaterThan(0);
  });

  it("publishes live gate cards and pricing without writing the terminal ledger", async () => {
    await store.upsertThreadUsageLine({
      line: {
        backend: "codex",
        cachedInputCostMicros: 0,
        cachedInputTokens: 0,
        createdAt: 1_800_000_000_000,
        currency: "USD",
        inputTokens: 10_000,
        model: "gpt-5.6-terra",
        outputCostMicros: 0,
        outputTokens: 100,
        priceStatus: "unpriced",
        provider: "openai",
        reasoningOutputTokens: 0,
        scope: "turn",
        source: "live",
        sourceItemId: "thread-token-usage",
        status: "finalized",
        threadId: "thread-parent",
        totalCostMicros: 0,
        totalTokens: 10_100,
        turnId: "turn-parent",
        uncachedInputCostMicros: 0,
        uncachedInputTokens: 10_000,
        usageLineId: "parent-turn-usage",
      },
    });
    const upsertSubAgents = vi.spyOn(store, "upsertThreadSubAgents");
    const upsertUsageLines = vi.spyOn(store, "upsertThreadUsageLines");
    const events: AgentEvent[] = [];
    registry.onEvent((event) => {
      events.push(event);
    });
    const publish = (
      registry as unknown as {
        publishLiveTokenMiserLedgerEntry(
          entry: TokenMiserObjectMetadata,
        ): Promise<void>;
      }
    ).publishLiveTokenMiserLedgerEntry.bind(registry);

    await publish(metadata("gate-live", "helper-live"));

    expect(upsertSubAgents).not.toHaveBeenCalled();
    expect(upsertUsageLines).not.toHaveBeenCalled();
    const storedOverlay = await store.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-parent",
    });
    expect(storedOverlay?.subAgents ?? []).toEqual([]);
    const subAgentEvent = events.find(
      (event) => event.notification.method === "thread/subAgents/updated",
    );
    expect(subAgentEvent?.notification.params).toMatchObject({
      threadId: "thread-parent",
      subAgents: [
        {
          agentName: "Token Miser",
          monitorId: "system:token-miser:gate-live",
          tokenMiserAccounting: {
            savingsMicros: 11_030,
          },
        },
      ],
    });
    const pricingEvent = events.find(
      (event) => event.notification.method === "thread/pricing/updated",
    );
    expect(pricingEvent?.notification.params).toMatchObject({
      threadId: "thread-parent",
      pricing: {
        lines: expect.arrayContaining([
          expect.objectContaining({
            sourceItemId: "system:token-miser:gate-live",
          }),
        ]),
      },
    });
    const snapshot = registry.withLiveTokenMiserNavigationSnapshot({
      backend: "all",
      directories: [],
      fetchedAt: 1,
      inboxThreadKeys: [],
      launchpadDefaults: {
        backend: "codex",
        executionMode: "default",
      },
      threads: [
        {
          id: "thread-parent",
          inbox: { inInbox: false },
          linkedDirectories: [],
          source: "codex",
          summary: "Parent",
          title: "Parent",
          titleSource: "explicit",
          updatedAt: 1,
        },
      ],
      unchanged: false,
    } satisfies NavigationSnapshot);
    expect(snapshot.threads[0]?.subAgents?.[0]?.monitorId).toBe(
      "system:token-miser:gate-live",
    );

    const retrieved = {
      ...metadata("gate-live", "helper-live"),
      retrievedCharacters: 4_000,
    };
    await publish(retrieved);
    const updatedSubAgentEvents = events.filter(
      (event) => event.notification.method === "thread/subAgents/updated",
    );
    expect(updatedSubAgentEvents.at(-1)?.notification.params).toMatchObject({
      subAgents: [
        {
          tokenMiserAccounting: {
            revealedParentTokens: 1_225,
            savingsMicros: 9_030,
          },
        },
      ],
    });
    const updatedPricingEvents = events.filter(
      (event) => event.notification.method === "thread/pricing/updated",
    );
    const updatedPricingParams = updatedPricingEvents.at(-1)?.notification.params;
    expect(updatedPricingParams).toMatchObject({
      pricing: {
        lines: expect.any(Array),
      },
    });
    const updatedPricing = updatedPricingParams as {
      pricing: { lines: ThreadUsageLineRecord[] };
    };
    expect(
      updatedPricing.pricing.lines.filter((line) =>
        line.sourceItemId === "system:token-miser:gate-live"
      ),
    ).toHaveLength(1);
  });
});

function metadata(
  objectId: string,
  helperThreadId: string,
): TokenMiserObjectMetadata {
  const ordinal = objectId === "gate-1" ? 1 : 2;
  return {
    version: 1,
    objectId,
    threadId: "thread-parent",
    turnId: "turn-parent",
    toolUseId: `tool-${ordinal}`,
    toolName: "commandExecution",
    createdAt: 1_800_000_000_000 + ordinal,
    originalCharacters: 24_000,
    baselineParentTokens: 6_000,
    replacementCharacters: 900,
    retrievedCharacters: 0,
    summary: {
      summary: "The command returned a large result.",
      usefulDetails: [],
      suggestedNextStep: "Read a targeted line range.",
    },
    helperUsage: {
      helperThreadId,
      helperTurnId: `helper-turn-${ordinal}`,
      model: "gpt-5.6-luna",
      reasoningEffort: "medium",
      tokenUsage: {
        inputTokens: 2_000,
        outputTokens: 100,
        totalTokens: 2_100,
      },
    },
  };
}

function toolInvocation(
  itemId: string,
  ordinal: number,
): ThreadToolInvocationRecord {
  return {
    backend: "codex",
    threadId: "thread-parent",
    turnId: "turn-parent",
    itemId,
    invocationId: `invocation-${ordinal}`,
    toolName: "commandExecution",
    category: "search",
    status: "completed",
    observedAt: 1_800_000_000_000 + ordinal,
    updatedAt: 1_800_000_000_000 + ordinal,
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
