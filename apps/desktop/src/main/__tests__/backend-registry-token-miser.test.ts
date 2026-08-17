import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
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
        gateCostMicros: 520,
        gateModel: "gpt-5.6-luna",
        gateTotalTokens: 2_100,
        originalModel: "gpt-5.6-terra",
        revealedParentCostMicros: 450,
        revealedParentTokens: 225,
        savingsMicros: 11_030,
      },
    });
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
