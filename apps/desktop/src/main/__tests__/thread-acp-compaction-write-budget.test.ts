import { expect, it, vi } from "vitest";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import { createDesktopBackendRegistry, registryModules } from "../app-server/backend-registry-wiring";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createTempStateDb, openFreshStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

const backend = "acp:antigravity";
const modelContextWindow = 1_048_576;
const threadId = "garden";
const identity = { backend, threadId } as const;

function owner(store: SqliteOverlayStore) {
  return createDesktopBackendRegistry({
    overlayStore: store,
    codexClient: {
      close: async () => {}, getInitializeResult: async () => ({ methods: [] }),
      listThreads: async () => [], onNotification: () => () => {}, onPendingRequest: () => () => {},
      readConfiguredMcpServerNames: async () => [], listModels: async () => [],
    } as never,
    archiveCleanupCheckpointStore: null,
    isBootstrapMode: () => false,
    resolveTokenMiserEnabled: () => false,
  });
}

type ContextSample = [used: number, source?: "compaction" | "session"];

it.each([
  { name: "steered-and-confirmed", steered: true, shrink: true, preflush: false },
  { name: "idle-and-no-shrink", steered: false, shrink: false, preflush: true },
  { name: "idle-and-confirmed-after-restart", steered: false, shrink: true, preflush: false },
])("keeps pricing and commit count stable for ACP compaction $name", async ({ name, steered, shrink, preflush }) => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const fixture = createTempStateDb("acp-usage-compaction-");
  let state = openFreshStateDb(fixture.dbPath);
  let store = new SqliteOverlayStore(state);
  let registry = owner(store);
  let sequence = 0;
  const emit = (notification: AgentEvent["notification"]) => registry.publishLocalEvent({ backend, notification });
  const report = (turnId: string, [usedTokens, source]: ContextSample) => emit({
    method: "thread/contextWindow/updated", params: { threadId, turnId, usedTokens, modelContextWindow, source },
  });
  function terminal(turnId: string, compacted: boolean, completedAt: number): AgentEvent["notification"] {
    return { method: "turn/completed", params: {
      threadId, turnId, completedAcpCompactionRequest: compacted ? true : undefined,
      turn: { id: turnId, status: "completed", completedAt, output: [] },
    } };
  }
  async function finish(turnId: string, compacted: boolean, occupancy: number, samples: ContextSample[]) {
    const startedAt = Date.now() - 1_000 + ++sequence;
    await emit({ method: "turn/started", params: { threadId, turnId, turn: { id: turnId, startedAt } } });
    const { writes: streaming } = await measureSqliteWrites(async () => {
      for (const sample of samples) await report(turnId, sample);
      // The last ordinary sample can be repeated without adding a write.
      for (let duplicate = 0; duplicate < 16; duplicate += 1) {
        const sample = samples.at(-1);
        if (sample) await report(turnId, sample);
      }
    });
    expect(streaming.commits).toBe(0);
    await emit({ method: "thread/tokenUsage/updated", params: {
      threadId, turnId, model: "gemini-4-neon",
      tokenUsage: { last_token_usage: { input_tokens: occupancy - 10,
        cached_input_tokens: 0, output_tokens: 10, total_tokens: occupancy } },
    } });
    if (preflush) await registryModules(registry).threadUsageLedger.flushLiveThreadUsageLines();
    const end = terminal(turnId, compacted, startedAt + 1);
    await emit(end);
    return end;
  }

  try {
    const baseline = await measureSqliteWrites(async () => {
      await finish("control-1", false, 470_149, []);
      await finish("control-2", false, 482_001, []);
      await finish("control-3", false, 43_500, []);
    });
    const { writes: firstWrites, result: compactEnd } = await measureSqliteWrites(async () => {
      await finish("turn-1", false, 470_149, [[470_149], [466_000]]);
      return await finish("turn-2", true, 482_001, [
        ...(steered ? [[478_856]] as ContextSample[] : []), [482_001, "compaction"],
      ]);
    });
    expect(await store.listThreadCompactions(identity)).toEqual([]);
    if (!steered && shrink) {
      // Reload the durable candidate into a completely fresh owner.
      await registry.close();
      state.close();
      state = openFreshStateDb(fixture.dbPath);
      store = new SqliteOverlayStore(state);
      registry = owner(store);
    }
    const { writes: nextWrites, result: nextEnd } = await measureSqliteWrites(() =>
      finish("turn-3", false, 43_500, [
        [482_001, "session"], [shrink ? 42_926 : 470_000], [44_000], [43_500],
      ]));
    const writes = {
      commits: firstWrites.commits + nextWrites.commits,
      statements: firstWrites.statements + nextWrites.statements,
      rowsChanged: firstWrites.rowsChanged + nextWrites.rowsChanged,
      walBytes: firstWrites.walBytes + nextWrites.walBytes,
    };
    const pricing = await store.readThreadPricing(identity);
    const rows = Object.fromEntries(pricing.lines.map((line) => [line.turnId, line]));
    for (const index of [1, 2, 3]) {
      const observed = rows[`turn-${index}`];
      const control = rows[`control-${index}`];
      expect(observed?.totalTokens).toBe(control?.totalTokens);
      expect(observed?.totalCostMicros).toBe(control?.totalCostMicros);
      expect(observed?.totalTokens).toBe([470_149, 482_001, 43_500][index - 1]);
    }
    expect(rows["turn-1"]).toMatchObject({ peakContextTokens: 470_149, finalContextTokens: 466_000, modelContextWindow });
    if (steered) {
      expect(rows["turn-2"]).toMatchObject({ peakContextTokens: 478_856, finalContextTokens: 478_856, modelContextWindow });
    } else {
      expect(rows["turn-2"]?.finalContextTokens).toBeUndefined();
    }
    expect(rows["turn-3"]).toMatchObject({
      peakContextTokens: shrink ? 44_000 : 470_000, finalContextTokens: 43_500, modelContextWindow,
    });
    const markers = await store.listThreadCompactions(identity);
    expect(markers.map((marker) => marker.turnId)).toEqual(shrink ? ["turn-2"] : []);
    // Re-emission after completion must neither re-arm nor duplicate a marker.
    const { writes: duplicates } = await measureSqliteWrites(async () => {
      await emit(compactEnd);
      await emit(nextEnd);
    });
    expect(duplicates.commits).toBe(0);
    expect(await store.listThreadCompactions(identity)).toEqual(markers);
    expect(writes.commits).toBe(baseline.writes.commits);
    expectSqliteWriteBudget({
      scenario: `acp-compaction-usage-${name}`,
      note: `Three ACP turns including one compaction. Control: ${baseline.writes.commits} commits and ${baseline.writes.walBytes} WAL bytes. Streamed context, cached-fill replays, and duplicate fills make zero commits.`,
      writes,
    });
  } finally {
    await registry.close();
    state.close();
    removeTempStateDbDir(fixture.tempDir);
    vi.unstubAllEnvs();
  }
});
