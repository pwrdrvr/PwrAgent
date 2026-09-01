import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AgentEvent,
  NavigationSnapshot,
  ThreadSubAgentSummary,
  ThreadToolInvocationRecord,
  ThreadUsageLineRecord,
} from "@pwragent/shared";
import type { TokenMiserObjectMetadata } from "../token-miser/token-miser-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { TokenMiserStore } from "../token-miser/token-miser-store";

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

  it("prices a deterministic pass-through without inventing a Luna charge", async () => {
    const persist = (
      registry as unknown as {
        persistTokenMiserLedgerEntries(
          metadata: readonly TokenMiserObjectMetadata[],
        ): Promise<void>;
      }
    ).persistTokenMiserLedgerEntries.bind(registry);
    const { helperUsage: _helperUsage, ...policyEntry } = metadata(
      "gate-1",
      "unused-helper",
    );
    await persist([{
      ...policyEntry,
      disposition: "passed_through",
      replacementCharacters: 24_000,
      parentModel: "gpt-5.6-sol",
    }]);

    const overlay = await store.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-parent",
    });
    expect(overlay?.subAgents?.[0]).toMatchObject({
      task: "Pass through commandExecution output by policy",
      lastMessage:
        "Passed 24,000 characters from commandExecution through unchanged by deterministic policy.",
      tokenMiserAccounting: {
        gateModel: "policy",
        gateTotalTokens: 0,
        gateCostMicros: 0,
        revealedParentTokens: 6_000,
        savingsMicros: 0,
      },
    });
    const pricing = await store.readThreadPricing({
      backend: "codex",
      threadId: "thread-parent",
    });
    expect(pricing.lines.filter((line) => line.scope === "monitor"))
      .toHaveLength(0);
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

  it("persists authoritative live gate usage once before parent completion", async () => {
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
        status: "pending",
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
    const internals = registry as unknown as {
      publishLiveTokenMiserLedgerEntry(
        entry: TokenMiserObjectMetadata,
      ): Promise<void>;
      writePendingLiveThreadUsageLines(): Promise<void>;
    };
    const publish = internals.publishLiveTokenMiserLedgerEntry.bind(registry);
    const baseLiveEntry = metadata("gate-live", "helper-live");
    const liveEntry = {
      ...baseLiveEntry,
      helperUsage: {
        ...baseLiveEntry.helperUsage,
        tokenUsage: {
          cachedInputTokens: 500,
          inputTokens: 2_000,
          outputTokens: 100,
          reasoningOutputTokens: 25,
          totalTokens: 2_100,
        },
      },
    } satisfies TokenMiserObjectMetadata;

    await publish(liveEntry);

    expect(upsertSubAgents).not.toHaveBeenCalled();
    expect(upsertUsageLines).not.toHaveBeenCalled();
    await internals.writePendingLiveThreadUsageLines();
    expect(upsertUsageLines).toHaveBeenCalledTimes(1);
    const livePricing = await store.readThreadPricing({
      backend: "codex",
      threadId: "thread-parent",
    });
    expect(
      livePricing.lines.filter((line) =>
        line.sourceItemId === "system:token-miser:gate-live"
      ),
    ).toEqual([
      expect.objectContaining({
        cachedInputTokens: 500,
        inputTokens: 2_000,
        outputTokens: 100,
        parentThreadId: "thread-parent",
        reasoningOutputTokens: 25,
        status: "finalized",
        threadId: "helper-live",
        totalTokens: 2_100,
        uncachedInputTokens: 1_500,
      }),
    ]);
    expect(livePricing.summaries).toEqual([
      expect.objectContaining({
        threadId: "thread-parent",
        usageLineCount: 2,
      }),
    ]);
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
            savingsMicros: 11_090,
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
      ...liveEntry,
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
            savingsMicros: 9_090,
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

    const persist = (
      registry as unknown as {
        persistTokenMiserLedgerEntries(
          metadata: readonly TokenMiserObjectMetadata[],
        ): Promise<void>;
      }
    ).persistTokenMiserLedgerEntries.bind(registry);
    await persist([retrieved]);
    await persist([retrieved]);

    expect(upsertUsageLines).toHaveBeenCalledTimes(1);
    const completedPricing = await store.readThreadPricing({
      backend: "codex",
      threadId: "thread-parent",
    });
    expect(
      completedPricing.lines.filter((line) =>
        line.sourceItemId === "system:token-miser:gate-live"
      ),
    ).toHaveLength(1);
  });

  it("republishes live gate-card savings when cached replays accrue", async () => {
    const objectId = "11111111-1111-4111-8111-111111111111";
    const tokenMiserStore = new TokenMiserStore(
      path.join(directory, "token-miser-objects"),
    );
    const entry = await tokenMiserStore.store({
      baselineCharacters: 24_000,
      helperUsage: metadata("gate-live", "helper-live").helperUsage,
      objectId,
      output: "x".repeat(24_000),
      parentCumulativeInputTokens: 1_000,
      parentModel: "gpt-5.6-terra",
      parentServiceTier: "standard",
      replacementCharacters: 900,
      summary: {
        summary: "The command returned a large result.",
        usefulDetails: [],
      },
      threadId: "thread-parent",
      toolName: "commandExecution",
      toolUseId: "tool-live",
      turnId: "turn-parent",
    });
    const internals = registry as unknown as {
      publishLiveTokenMiserLedgerEntry(
        metadata: TokenMiserObjectMetadata,
      ): Promise<void>;
      rememberActiveTokenMiserReplayEntry(
        metadata: TokenMiserObjectMetadata,
      ): void;
      tokenMiserStore?: TokenMiserStore;
    };
    internals.tokenMiserStore = tokenMiserStore;
    internals.rememberActiveTokenMiserReplayEntry(entry);

    const events: AgentEvent[] = [];
    registry.onEvent((event) => {
      events.push(event);
    });
    const readAccounting = (event: AgentEvent | undefined) => {
      const params = event?.notification.params as
        | { subAgents?: ThreadSubAgentSummary[] }
        | undefined;
      return params?.subAgents?.[0]?.tokenMiserAccounting;
    };
    await internals.publishLiveTokenMiserLedgerEntry(entry);
    const initialAccounting = readAccounting(events.find(
      (event) => event.notification.method === "thread/subAgents/updated",
    ));
    expect(initialAccounting?.cachedReplayCount).toBe(0);
    events.length = 0;

    for (const inputTokens of [2_000, 3_000, 4_000]) {
      await registry.publishLocalEvent({
        backend: "codex",
        notification: {
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "thread-parent",
            turnId: "turn-parent",
            tokenUsage: {
              last: {
                inputTokens,
                cachedInputTokens: inputTokens - 100,
                outputTokens: 0,
                reasoningOutputTokens: 0,
                totalTokens: inputTokens,
              },
              total: {
                inputTokens,
                cachedInputTokens: inputTokens - 100,
                outputTokens: 0,
                reasoningOutputTokens: 0,
                totalTokens: inputTokens,
              },
            },
          },
        },
      });
    }

    const replayEvents = events.filter(
      (event) => event.notification.method === "thread/subAgents/updated",
    );
    const replayAccounting = readAccounting(replayEvents.at(-1));
    expect(replayAccounting?.cachedReplayCount).toBe(1);
    expect(replayAccounting?.savingsMicros)
      .toBeGreaterThan(initialAccounting?.savingsMicros ?? 0);
  });

  it("stops cached replay counting at a ContextCompaction item boundary", async () => {
    const { objectId, tokenMiserStore } = await startLiveReplayGate();

    await registry.publishLocalEvent(parentUsageEvent(2_000));
    await registry.publishLocalEvent(parentUsageEvent(3_000));
    await registry.publishLocalEvent(parentUsageEvent(4_000));
    expect(await tokenMiserStore.readMetadata(objectId)).toMatchObject({
      cachedReplayCount: 1,
      parentRequestsObservedAfterGate: 3,
    });

    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "item/completed",
        params: {
          item: {
            id: "compact-item-1",
            type: "ContextCompaction",
          },
          threadId: "thread-parent",
          turnId: "turn-parent",
        },
      },
    });

    await registry.publishLocalEvent(parentUsageEvent(5_000));
    await registry.publishLocalEvent(parentUsageEvent(6_000));

    expect(await tokenMiserStore.readMetadata(objectId)).toMatchObject({
      cachedReplayCount: 1,
      parentRequestsObservedAfterGate: 3,
    });
    expect(
      (await tokenMiserStore.readMetadata(objectId))?.replayTrackingStoppedAt,
    ).toEqual(expect.any(Number));
    expect(await store.listThreadCompactions({
      backend: "codex",
      threadId: "thread-parent",
    })).toEqual([
      expect.objectContaining({
        itemId: "compact-item-1",
        threadId: "thread-parent",
        turnId: "turn-parent",
      }),
    ]);
  });

  it("stops cached replay counting when a ContextCompaction item starts", async () => {
    const { objectId, tokenMiserStore } = await startLiveReplayGate();

    await registry.publishLocalEvent(parentUsageEvent(2_000));
    await registry.publishLocalEvent(parentUsageEvent(3_000));
    await registry.publishLocalEvent(parentUsageEvent(4_000));

    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "item/started",
        params: {
          item: {
            id: "compact-item-started",
            type: "contextCompaction",
          },
          threadId: "thread-parent",
          turnId: "turn-parent",
        },
      },
    });
    await registry.publishLocalEvent(parentUsageEvent(5_000));

    expect(await tokenMiserStore.readMetadata(objectId)).toMatchObject({
      cachedReplayCount: 1,
      parentRequestsObservedAfterGate: 3,
    });
  });

  it("does not treat a non-compaction item as a replay boundary", async () => {
    const { objectId, tokenMiserStore } = await startLiveReplayGate();

    await registry.publishLocalEvent(parentUsageEvent(2_000));
    await registry.publishLocalEvent(parentUsageEvent(3_000));
    await registry.publishLocalEvent(parentUsageEvent(4_000));
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "item/completed",
        params: {
          item: {
            id: "command-1",
            type: "CommandExecution",
          },
          threadId: "thread-parent",
          turnId: "turn-parent",
        },
      },
    });
    await registry.publishLocalEvent(parentUsageEvent(5_000));

    expect(await tokenMiserStore.readMetadata(objectId)).toMatchObject({
      cachedReplayCount: 2,
      parentRequestsObservedAfterGate: 4,
    });
    expect(await store.listThreadCompactions({
      backend: "codex",
      threadId: "thread-parent",
    })).toEqual([]);
  });

  it("records one marker when ContextCompaction and thread/compacted share an item id", async () => {
    const { objectId, tokenMiserStore } = await startLiveReplayGate();

    await registry.publishLocalEvent(parentUsageEvent(2_000));
    await registry.publishLocalEvent(parentUsageEvent(3_000));
    await registry.publishLocalEvent(parentUsageEvent(4_000));
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "item/completed",
        params: {
          item: {
            id: "compact-item-shared",
            type: "ContextCompaction",
          },
          threadId: "thread-parent",
          turnId: "turn-parent",
        },
      },
    });
    await registry.publishLocalEvent({
      backend: "codex",
      notification: {
        method: "thread/compacted",
        params: {
          itemId: "compact-item-shared",
          threadId: "thread-parent",
        },
      },
    });
    await registry.publishLocalEvent(parentUsageEvent(5_000));

    expect(await tokenMiserStore.readMetadata(objectId)).toMatchObject({
      cachedReplayCount: 1,
    });
    expect(await store.listThreadCompactions({
      backend: "codex",
      threadId: "thread-parent",
    })).toHaveLength(1);
  });

  async function startLiveReplayGate(): Promise<{
    objectId: string;
    tokenMiserStore: TokenMiserStore;
  }> {
    const objectId = "22222222-2222-4222-8222-222222222222";
    const tokenMiserStore = new TokenMiserStore(
      path.join(directory, "token-miser-objects"),
    );
    const entry = await tokenMiserStore.store({
      baselineCharacters: 24_000,
      helperUsage: metadata("gate-live", "helper-live").helperUsage,
      objectId,
      output: "x".repeat(24_000),
      parentCumulativeInputTokens: 1_000,
      parentModel: "gpt-5.6-terra",
      parentServiceTier: "standard",
      replacementCharacters: 900,
      summary: {
        summary: "The command returned a large result.",
        usefulDetails: [],
      },
      threadId: "thread-parent",
      toolName: "commandExecution",
      toolUseId: "tool-live",
      turnId: "turn-parent",
    });
    const internals = registry as unknown as {
      rememberActiveTokenMiserReplayEntry(
        metadata: TokenMiserObjectMetadata,
      ): void;
      tokenMiserStore?: TokenMiserStore;
    };
    internals.tokenMiserStore = tokenMiserStore;
    internals.rememberActiveTokenMiserReplayEntry(entry);
    return { objectId, tokenMiserStore };
  }
});

function parentUsageEvent(inputTokens: number): AgentEvent {
  return {
    backend: "codex",
    notification: {
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-parent",
        turnId: "turn-parent",
        tokenUsage: {
          last: {
            cachedInputTokens: inputTokens - 100,
            inputTokens,
            outputTokens: 0,
            reasoningOutputTokens: 0,
            totalTokens: inputTokens,
          },
          total: {
            cachedInputTokens: inputTokens - 100,
            inputTokens,
            outputTokens: 0,
            reasoningOutputTokens: 0,
            totalTokens: inputTokens,
          },
        },
      },
    },
  };
}

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
