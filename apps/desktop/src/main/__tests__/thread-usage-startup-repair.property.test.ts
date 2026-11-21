import { afterEach, expect, it, vi } from "vitest";
import { USAGE_TURN_REPAIR_PEER_QUIET_MS } from "../app-server/backend-registry-runtime-helpers";
import { ThreadUsageLedger, type ThreadUsageLedgerHost } from "../app-server/thread-usage-ledger";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import type { StateDb } from "../state/state-db";
import { registryContextStandIn } from "./helpers/registry-context-stand-in";
import { openInMemoryStateDb } from "./sqlite-test-utils";

const START = Date.UTC(2026, 10, 1);
const BATCH_LIMIT = 2_000;

type Turn = {
  id: string;
  thread: string;
  observed: number;
  start: number | null;
  updated: number;
  completed?: number;
};

function seed(db: StateDb, turns: Turn[]): void {
  const insertTurn = db.raw.prepare(
    `INSERT INTO thread_usage_turns (
       usage_turn_id, provider, backend, thread_id, turn_id, started_at, observed_at, updated_at, completed_at
     ) VALUES (?, 'openai', 'codex', ?, ?, ?, ?, ?, ?)`,
  );
  const insertLine = db.raw.prepare(
    `INSERT INTO thread_usage_lines (
       usage_line_id, usage_turn_id, provider, backend, thread_id, turn_id, source, scope, status,
       created_at, updated_at, input_tokens, cached_input_tokens, uncached_input_tokens, output_tokens,
       reasoning_output_tokens, total_tokens, price_status, currency, uncached_input_cost_micros,
       cached_input_cost_micros, output_cost_micros, total_cost_micros
     ) VALUES (?, ?, 'openai', 'codex', ?, ?, 'live', 'turn', 'pending',
       ?, ?, 1, 0, 1, 1, 0, 2, 'priced', 'USD', 0, 0, 0, 0)`,
  );
  db.raw.transaction(() => {
    for (const turn of turns) {
      insertTurn.run(turn.id, turn.thread, turn.id, turn.start, turn.observed, turn.updated, turn.completed ?? null);
      insertLine.run(turn.id, turn.id, turn.thread, turn.id, turn.observed, turn.updated);
    }
  })();
}

function startupLedger(store: SqliteOverlayStore, startedAt: number, runtimes: string[] | undefined) {
  return new ThreadUsageLedger(
    registryContextStandIn({ overlayStore: store }),
    {} as ConstructorParameters<typeof ThreadUsageLedger>[1],
    () => ({
      registrySessionStartedAt: startedAt,
      runtimeInstanceId: "local",
      liveProfileRuntimeInstanceIds: () => runtimes,
    }) as ThreadUsageLedgerHost,
  );
}

function completions(db: StateDb) {
  return db.raw.prepare(
    `SELECT turn_id, completed_at, completed_at_inferred FROM thread_usage_turns ORDER BY turn_id`,
  ).all();
}

function expectedCompletions(turns: Turn[], cutoff: number) {
  const selected = new Set(turns
    .filter((turn) => turn.completed === undefined && turn.updated < cutoff)
    .sort((a, b) => a.observed - b.observed || (a.id < b.id ? -1 : 1))
    .slice(0, BATCH_LIMIT));
  const stamps = new Map<number, number>();
  for (const turn of turns) {
    stamps.set(turn.updated, (stamps.get(turn.updated) ?? 0) + 1);
  }
  return [...turns].sort((a, b) => a.id < b.id ? -1 : 1).map((turn) => {
    let completed = turn.completed ?? null;
    if (selected.has(turn)) {
      const start = turn.start ?? turn.observed;
      const lastUse = stamps.get(turn.updated)! >= 64 ? turn.observed : turn.updated;
      completed = turns.reduce((end, other) => {
        const next = other.start ?? other.observed;
        return other.thread === turn.thread && next > start ? Math.min(end, next) : end;
      }, Math.max(start, lastUse));
    }
    return {
      turn_id: turn.id,
      completed_at: completed,
      completed_at_inferred: selected.has(turn) ? 1 : null,
    };
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

it.each([false, true])("bounds next-start work at the startup batch cap (ANALYZE: %s)", async (analyze) => {
  const db = openInMemoryStateDb();
  try {
    const turns = Array.from({ length: 4_000 }, (_, index): Turn => ({
      id: `turn-${String(index).padStart(4, "0")}`,
      thread: "backlog",
      observed: START + Math.floor(index / 3) * 10 + 3,
      start: index % 3 === 2 ? null : START + Math.floor(index / 3) * 10,
      updated: index < 64 ? START + 30_000 : START + 40_000 + index,
      ...(index % 100 === 0 ? { completed: START + 25_000 } : {}),
    })).reverse();
    seed(db, turns);
    if (analyze) db.raw.exec("ANALYZE");
    const store = new SqliteOverlayStore(db);
    const repair = vi.spyOn(store, "repairUnfinishedThreadUsageTurns");
    const cutoff = START + 60_000;
    let startReads = 0;
    db.raw.function("count_repair_start", (start: number) => {
      startReads += 1;
      return start;
    });
    const prepare = db.raw.prepare.bind(db.raw);
    // Count effective-start evaluations on a copy of the candidate SELECT.
    // The store executes the original statement for the output oracle below.
    const start = "COALESCE(next.started_at, next.observed_at)";
    vi.spyOn(db.raw, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      if (sql.includes(start)) {
        const probe = prepare(sql.replaceAll(start, `count_repair_start(${start})`));
        const all = statement.all.bind(statement);
        vi.spyOn(statement, "all").mockImplementation((...args) => {
          probe.all(...args);
          return all(...args);
        });
      }
      return statement;
    });

    await startupLedger(store, cutoff, ["local"]).repairUnfinishedThreadUsageTurnsAtStartup();

    expect(repair).toHaveBeenCalledExactlyOnceWith({ lastWriteBefore: cutoff, limit: BATCH_LIMIT });
    expect(await repair.mock.results[0]!.value).toEqual({
      repaired: BATCH_LIMIT, remaining: true, datedByFirstWrite: 63,
    });
    expect(completions(db)).toEqual(expectedCompletions(turns, cutoff));
    // Read a candidate thread's start times in a bounded number of passes,
    // independent of the number of eligible turns selected from that thread.
    expect(startReads).toBeGreaterThanOrEqual(turns.length);
    expect(startReads).toBeLessThanOrEqual(4 * turns.length);
  } finally {
    db.close();
  }
});

it.each([
  { name: "unavailable runtime list", runtimes: undefined, sessionStart: START + 100, cutoff: -Infinity },
  { name: "sole runtime", runtimes: ["local"], sessionStart: START + 100, cutoff: START + 100 },
  { name: "peer quiet period", runtimes: ["local", "peer"], sessionStart: START + 100, cutoff: START },
  { name: "session start before the quiet cutoff", runtimes: ["local", "peer"], sessionStart: START - 2, cutoff: START - 2 },
])("honors the startup cutoff with $name", async ({ runtimes, sessionStart, cutoff }) => {
  const db = openInMemoryStateDb();
  try {
    const now = START + USAGE_TURN_REPAIR_PEER_QUIET_MS;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const turns = [-3, -2, -1, 0, 1, 100, 101].map((delta): Turn => ({
      id: `turn-${delta}`, thread: "quiet", observed: START + delta * 2 - 10,
      start: null, updated: START + delta,
    }));
    seed(db, turns);
    const store = new SqliteOverlayStore(db);
    await startupLedger(store, sessionStart, runtimes).repairUnfinishedThreadUsageTurnsAtStartup();
    expect(completions(db)).toEqual(expectedCompletions(turns, cutoff));

    if (runtimes?.includes("peer")) {
      const completedAt = START + 111;
      const first = turns[0]!;
      expect(await store.completeThreadUsageTurn({
        backend: "codex", threadId: first.thread, turnId: first.id, completedAt,
      })).toBe(true);
      expect(completions(db)).toEqual(expectedCompletions([{ ...first, completed: completedAt }, ...turns.slice(1)], cutoff));
    }
  } finally {
    db.close();
  }
});
