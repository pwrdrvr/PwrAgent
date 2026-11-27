import path from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { PricingRunningTotals } from "@pwragent/shared/thread-pricing-display";
import { estimateTokenUsageCost, type ThreadUsageLineRecord } from "@pwragent/shared/token-usage-pricing";
import { createDesktopBackendRegistry, registryModules } from "../app-server/backend-registry-wiring";
import { readThreadForPeer } from "../federation/federation-owner-thread-reads";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { SqliteTokenMiserStorage } from "../storage/token-miser-storage-sqlite";
import { estimateTokenCount, type TokenMiserObjectMetadata } from "../token-miser/token-miser-types";
import { countPricingRows } from "./scaling-audit-pricing-rows";
import { record } from "./scaling-audit-results";
import { openInMemoryStateDb } from "./sqlite-test-utils";
import { TestTokenMiserStore } from "./token-miser-test-store";

type Mode = "ordinary" | "codex-empty" | "stored-monitor" | "metadata-only" | "live-gates";
const populated: Mode[] = ["stored-monitor", "metadata-only", "live-gates"];
const controls: Mode[] = ["ordinary", "codex-empty"];
const matrix = [
  [24, 8, 2], [96, 8, 2], [24, 32, 2], [24, 8, 8], [96, 32, 8],
].flatMap(([history, gates, limit]) => populated.map(mode => ({ history, gates, limit, mode })));
for (const [history, limit] of [[24, 2], [96, 8]]) {
  for (const mode of controls) matrix.push({ history, gates: 0, limit, mode });
}

const threadId = "pricing-fixture";
const epoch = 1_800_000_000_000;
const model = "gpt-5.6-terra";
const tokens = { inputTokens: 1000, cachedInputTokens: 100, outputTokens: 20, totalTokens: 1020 };

function turnLine(backend: ThreadUsageLineRecord["backend"], index: number): ThreadUsageLineRecord {
  return {
    backend, threadId, turnId: "turn-" + index, usageLineId: "parent-" + index, createdAt: epoch + index,
    model, scope: "turn", source: "live", sourceItemId: "thread-token-usage", status: "finalized",
    priceStatus: "priced", provider: "openai", currency: "USD", ...tokens, uncachedInputTokens: 900,
    reasoningOutputTokens: 0, cachedInputCostMicros: 1, uncachedInputCostMicros: 5, outputCostMicros: 2, totalCostMicros: 8,
  };
}

function gate(index: number, history: number): TokenMiserObjectMetadata {
  return {
    version: 1, objectId: "gate-" + index, threadId, turnId: "turn-" + (history - 1 - index % 4),
    toolUseId: "tool-" + index, toolName: "commandExecution", createdAt: epoch + history + index,
    disposition: "summarized", originalCharacters: 12000, replacementCharacters: 400,
    baselineParentTokens: 3000, retrievedCharacters: 0, parentModel: model, replayTrackingVersion: 2,
    summary: { summary: "Generated output summary.", usefulDetails: [], suggestedNextStep: "" },
    helperUsage: { helperThreadId: "helper-" + index, helperTurnId: "helper-turn-" + index,
      model: "gpt-5.6-luna", tokenUsage: tokens },
  };
}

type ReplayFixture = "original" | "active" | "stopped";
const scenarios = matrix.map(row => ({ ...row, activityOnly: false, replay: "original" as ReplayFixture }));
for (const row of matrix) {
  if ((row.history === 24 && row.gates <= 8 && row.limit === 2) || (row.history === 96 && row.limit === 8)) {
    scenarios.push({ ...row, activityOnly: true, replay: "original" });
  }
}

// The original fixture's display IDs cannot update a stored object. Exercise
// actual replay-counter mutations and compacted history with valid IDs too.
for (const row of matrix.filter(row => row.mode === "live-gates" && row.limit === 2)) {
  for (const replay of ["active", "stopped"] as const) scenarios.push({ ...row, activityOnly: true, replay });
}
for (const replay of ["active", "stopped"] as const) {
  for (const [history, gates, limit] of [[48, 16, 4], [96, 32, 8]]) {
    scenarios.push({ history, gates, limit, mode: "live-gates", activityOnly: true, replay });
  }
}

it.each(scenarios)("reads $mode history=$history gates=$gates limit=$limit activityOnly=$activityOnly replay=$replay", async ({
  history, gates, limit, mode, activityOnly, replay,
}) => {
  const backend = mode === "ordinary" || mode === "stored-monitor" ? "acp:antigravity" : "codex";
  const stateDb = openInMemoryStateDb();
  const usage = countPricingRows(stateDb);
  const store = new SqliteOverlayStore(stateDb);
  const miser = new TestTokenMiserStore(path.join(process.env.PWRAGENT_HOME!, "objects"));
  const metadata = countPricingRows(miser.stateDb);
  const storage = new SqliteTokenMiserStorage(miser.stateDb);
  const registry = createDesktopBackendRegistry({
    codexClient: {
      close: async () => {}, getInitializeResult: async () => ({ methods: [] }),
      listThreads: async () => [], onNotification: () => () => {}, onPendingRequest: () => () => {},
    } as never,
    overlayStore: store, tokenMiserStore: miser,
    runtimeInstanceId: "fixture-owner", resolveLiveProfileRuntimeInstanceIds: () => [],
  });
  onTestFinished(async () => {
    try { await registry.close(); } finally { vi.restoreAllMocks(); stateDb.close(); }
  });
  const ledger = registryModules(registry).threadUsageLedger as unknown as {
    persistTokenMiserLedgerEntries(entries: TokenMiserObjectMetadata[]): Promise<unknown>;
    publishLiveTokenMiserReplayEntries(entries: TokenMiserObjectMetadata[]): Promise<void>;
  };
  vi.spyOn(Date, "now").mockReturnValue(epoch + history + gates + 100);
  for (let i = 0; i < history; i++) await store.upsertThreadUsageLine({ line: turnLine(backend, i) });
  const entries = Array.from({ length: gates }, (_, i) => ({
    ...gate(i, history),
    ...(replay !== "original" ? {
      objectId: "00000000-0000-4000-8000-" + String(i).padStart(12, "0"),
      parentRequestsObservedAfterGate: 2,
      ...(replay === "stopped" ? { replayTrackingStoppedAt: epoch + history + gates } : {}),
    } : {}),
  }));
  const saveCard = (entry: TokenMiserObjectMetadata) => store.upsertThreadSubAgent({ backend, threadId, subAgent: {
    backend, monitorId: "system:token-miser:" + entry.objectId, parentTurnId: entry.turnId,
    monitorTurnId: entry.helperUsage!.helperTurnId, task: "Gate", status: "success", createdAt: epoch, updatedAt: epoch,
  } });
  for (const [i, entry] of entries.entries()) {
    if (mode === "stored-monitor") {
      await saveCard(entry);
      await store.upsertThreadUsageLine({ line: {
        ...turnLine(backend, i), usageLineId: "stored-" + i, scope: "monitor", source: "monitor",
        sourceItemId: "system:token-miser:" + entry.objectId, turnId: entry.helperUsage!.helperTurnId!,
      } });
    } else {
      storage.writeMetadata(entry);
    }
  }
  if (mode === "live-gates") {
    await ledger.persistTokenMiserLedgerEntries(entries);
    await ledger.publishLiveTokenMiserReplayEntries(entries);
  }

  let publishedRows = 0;
  registry.onEvent(({ notification }) => {
    if (notification.method === "thread/pricing/updated") {
      const pricing = notification.params.pricing as { lines: ThreadUsageLineRecord[] };
      publishedRows += pricing.lines.length;
    }
  });
  const folds = vi.spyOn(PricingRunningTotals.prototype, "add");
  const counts = () => ({ usageRows: usage.usageRows, cardRows: usage.cardRows,
    metadataRows: metadata.metadataRows, payloadQueries: metadata.payloadQueries, metadataKeys: metadata.metadataKeys, publishedRows, folds: folds.mock.calls.length });
  async function measure<T>(phase: string, read: () => Promise<T>) {
    const before = counts();
    const result = await read();
    const after = counts();
    for (const key of Object.keys(after) as (keyof typeof after)[]) after[key] -= before[key];
    record({ kind: "token-miser", history, gates, limit, mode: replay === "original" ? mode : mode + "-" + replay, phase, ...after });
    if (phase === "transcript-accounting") {
      expect(after.usageRows).toBeLessThanOrEqual(1);
      expect(after.cardRows + after.metadataRows + after.folds + after.publishedRows).toBe(0);
    }
    if (phase === "unrelated-turn-before-pricing") {
      expect(after.usageRows).toBeLessThanOrEqual(2);
      expect(after.cardRows + after.metadataRows + after.folds).toBe(0);
    }
    if (phase === "same-thread-turn-before-pricing") {
      expect(after.usageRows).toBeLessThanOrEqual(history + 2 * gates + 2);
      expect(after.metadataRows).toBeLessThanOrEqual(replay === "active" ? 2 * gates : gates);
      expect(after.publishedRows).toBe(1);
    }
    if (phase === "unchanged-owner" || phase === "unchanged-peer" || phase === "redelivered") {
      expect(after.folds).toBeLessThanOrEqual(history + gates + 1);
      expect(after.metadataRows).toBeLessThanOrEqual(gates);
    }
    expect(after.publishedRows).toBeLessThanOrEqual(1);
    return result;
  }
  async function publishTurn(threadId: string, turnId: string) {
    const operation = (name: string, event: Parameters<typeof registry.publishLocalEvent>[0]) =>
      activityOnly ? measure((threadId === "unrelated" ? "unrelated-" : "seeded-") + name, () => registry.publishLocalEvent(event))
        : registry.publishLocalEvent(event);
    await operation("start", { backend, notification: { method: "turn/started",
      params: { threadId, turnId, turn: { id: turnId, status: "inProgress" } } } });
    await operation("usage", { backend, notification: { method: "thread/tokenUsage/updated",
      params: { threadId, turnId, model, tokenUsage: { last: tokens, total: tokens } } } });
    await operation("completion", { backend, notification: { method: "turn/completed",
      params: { threadId, turnId, turn: { id: turnId, status: "completed", output: [] } } } });
  }
  if (activityOnly) {
    // Neither viewer opens Pricing. The first turn belongs to a different
    // thread in the same seeded owner, the second to the thread with history.
    await measure("unrelated-turn-before-pricing", () => publishTurn("unrelated", "first"));
    await measure("same-thread-turn-before-pricing", () => publishTurn(threadId, "first"));
    if (replay !== "original") {
      await miser.flushAll();
      const stored = await miser.listMetadata(threadId);
      const active = replay === "active";
      expect(stored).toHaveLength(gates);
      for (const entry of stored) {
        expect(entry.cachedReplayCount ?? 0).toBe(active ? 1 : 0);
        expect(entry.cachedBaselineTokens ?? 0).toBe(active ? entry.baselineParentTokens : 0);
        expect(entry.parentRequestsObservedAfterGate).toBe(active ? 3 : 2);
      }
      const pricing = (await registry.readThread({ backend, threadId, includeTurns: false, viewOnly: true,
        display: { resource: "pricing", limit, deferPricingGates: true },
      })).display!.pricingPage!;
      expect(pricing.totalRows).toBe(history + 1);
      expect(pricing.tokenMiserSummary?.decisionCount).toBe(gates);
      const ledger = await store.readThreadPricing({ backend, threadId });
      const helpers = ledger.lines.filter(line => line.scope === "monitor");
      expect(helpers).toHaveLength(gates);
      const gateCostMicros = helpers.reduce((sum, row) => sum + row.totalCostMicros, 0);
      // Every fixture gate replaces the same 3,000-token payload. An active
      // gate saves a second, cached copy on this request; a stopped one does not.
      const parentCost = (uncachedInputTokens: number) => gates * estimateTokenUsageCost({
        model, at: epoch, outputTokens: 0, uncachedInputTokens, cachedInputTokens: active ? uncachedInputTokens : 0,
      })!.totalCostMicros;
      const withoutGateCostMicros = parentCost(3000);
      const revealedCostMicros = parentCost(estimateTokenCount(400));
      expect(pricing.tokenMiserSummary?.terms).toEqual({
        gateCostMicros, withoutGateCostMicros, revealedCostMicros,
        savingsMicros: withoutGateCostMicros - gateCostMicros - revealedCostMicros,
      });
      expect(pricing.observedCostMicros).toBe(ledger.summaries.reduce((sum, row) => sum + row.totalCostMicros, 0));
    }
    return;
  }
  const request = { backend, threadId, includeTurns: false, viewOnly: true,
    display: { resource: "pricing", limit, deferPricingGates: true } } as const;
  const firstTurn = { id: "turn-0", status: "completed" as const, completedAt: epoch };
  const accounting = await measure("transcript-accounting", () => registry.readThread({
    ...request, display: { resource: "accounting", turns: [firstTurn] },
  }));
  expect(accounting.replay.entries.map(entry => entry.turn?.id)).toContain(firstTurn.id);
  const readPage = async (peer: boolean) => {
    const result = peer ? await readThreadForPeer(registry, request) : await registry.readThread(request);
    const page = result.display!.pricingPage!;
    expect(page.rows).toHaveLength(limit);
    if (mode === "live-gates" || mode === "metadata-only") expect(page.tokenMiserSummary?.decisionCount).toBe(gates);
    return page;
  };
  const cold = await measure("cold", () => readPage(false));
  expect(cold.totalRows).toBe(history);
  expect(await measure("unchanged-owner", () => readPage(false))).toEqual(cold);

  const turnId = "appended";
  await measure("turn-lifecycle", () => publishTurn(threadId, turnId));
  const appended = await measure("appended", () => readPage(false));
  expect(appended.totalRows).toBe(history + 1);
  expect(appended.rows[0].line.turnId).toBe(turnId);
  expect(await measure("unchanged-peer", () => readPage(true))).toEqual(appended);
  if (mode === "live-gates") {
    await ledger.publishLiveTokenMiserReplayEntries(entries);
    expect(await measure("redelivered", () => readPage(true))).toEqual(appended);
  }
  if (mode === "live-gates" || mode === "stored-monitor") {
    const moved = { ...entries[0]!, turnId };
    if (mode === "live-gates") {
      storage.writeMetadata(moved);
      await ledger.publishLiveTokenMiserReplayEntries([moved]);
    } else {
      await saveCard(moved);
    }
    const reassigned = await measure("reassigned", () => readPage(false));
    expect(reassigned.rows[0].gateSummary?.gateCount).toBe(1);
  }
});
