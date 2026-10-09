import { afterEach, expect, it, vi } from "vitest";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { openInMemoryStateDb } from "./sqlite-test-utils";
import budgets from "./fixtures/navigation-listing-budgets.json";

afterEach(() => vi.restoreAllMocks());

it.each([10, 120, 1_000])("bounds PR candidate eligibility reads for %i history-heavy threads", async (count) => {
  const db = openInMemoryStateDb();
  const store = new SqliteOverlayStore(db);
  const threads = Array.from({ length: count }, (_, index) => ({ backend: "codex" as const,
    threadId: `fixture-${index}`, prKeys: ["fixture-pr"] }));
  db.raw.transaction(() => {
    for (const thread of threads) db.raw.prepare("INSERT INTO threads(thread_id, payload) VALUES (?, ?)").run(
      `codex:${thread.threadId}`, JSON.stringify({ ...thread, prAutoDispatchEnabled: true,
        immutableUsageActivities: [{ text: "contrived history ".repeat(2_000) }],
      }),
    );
  })();
  const prepare = db.raw.prepare.bind(db.raw);
  let reads = 0;
  let payloadBytes = 0;
  const plans: string[] = [];
  vi.spyOn(db.raw, "prepare").mockImplementation((sql) => {
    const statement = prepare(sql);
    if (!sql.trimStart().startsWith("SELECT")) return statement;
    for (const method of ["get", "all"] as const) {
      const execute = statement[method].bind(statement);
      vi.spyOn(statement, method).mockImplementation((...args: unknown[]) => {
        reads++;
        const result = execute(...args);
        for (const row of (Array.isArray(result) ? result : [result]) as Array<{ payload?: string } | undefined>) {
          payloadBytes += Buffer.byteLength(row?.payload ?? "");
        }
        plans.push(...(prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{ detail: string }>).map((row) => row.detail));
        return result;
      });
    }
    return statement;
  });
  const parse = vi.spyOn(JSON, "parse");
  try {
    await store.syncThreadPrAutoDispatchCandidatesBatch({ threads, now: 1 });
    await store.syncThreadPrAutoDispatchCandidatesBatch({ threads, now: 2 });
    expect({ readsPerBatch: reads / Math.ceil(count / 500), payloadBytes, fullOverlayParses: parse.mock.calls.length })
      .toEqual(budgets["pr-candidate-bootstrap-and-unchanged"]);
    expect(plans.some((plan) => /SEARCH threads USING INDEX/.test(plan))).toBe(true);
    expect(plans.some((plan) => /SEARCH candidates USING/.test(plan)), JSON.stringify([...new Set(plans)])).toBe(true);
    expect(plans.some((plan) => /SCAN (threads|candidates)/.test(plan))).toBe(false);
  } finally { db.close(); }
});

it("retains strict boolean eligibility, provider identity, missing-row cleanup and membership removal", async () => {
  const db = openInMemoryStateDb();
  const store = new SqliteOverlayStore(db);
  try {
    for (const [backend, enabled] of [["codex", true], ["acp:fixture", 1]] as const) {
      db.raw.prepare("INSERT INTO threads(thread_id, payload) VALUES (?, ?)").run(
        `${encodeURIComponent(backend)}:same`, JSON.stringify({ backend, threadId: "same", prAutoDispatchEnabled: enabled }),
      );
    }
    const threads = [{ backend: "codex" as const, threadId: "same", prKeys: ["keep", "remove"] },
      { backend: "acp:fixture" as const, threadId: "same", prKeys: ["keep"] }];
    await store.syncThreadPrAutoDispatchCandidatesBatch({ threads, now: 1 });
    const memberships = () => db.raw.prepare("SELECT backend, pr_key, eligible_since FROM pr_auto_dispatch_candidates ORDER BY pr_key").all();
    expect(memberships()).toEqual([{ backend: "codex", pr_key: "keep", eligible_since: 1 }, { backend: "codex", pr_key: "remove", eligible_since: 1 }]);
    await store.syncThreadPrAutoDispatchCandidatesBatch({ threads: [{ ...threads[0]!, prKeys: ["keep"] }, threads[1]!], now: 2 });
    expect(memberships()).toEqual([{ backend: "codex", pr_key: "keep", eligible_since: 1 }]);
    db.raw.prepare("DELETE FROM threads WHERE thread_id = ?").run("codex:same");
    await store.syncThreadPrAutoDispatchCandidatesBatch({ threads, now: 3 });
    expect(memberships()).toEqual([]);
  } finally { db.close(); }
});

it("revalidates eligibility inside the write transaction after preflight", async () => {
  const db = openInMemoryStateDb();
  const store = new SqliteOverlayStore(db);
  try {
    await store.setThreadPrAutoDispatchEnabled({ backend: "codex", threadId: "fixture", enabled: true });
    const original = db.raw.transaction.bind(db.raw);
    vi.spyOn(db.raw, "transaction").mockImplementation(((callback: (...args: unknown[]) => unknown) => {
      db.raw.prepare("UPDATE threads SET payload = json_set(payload, '$.prAutoDispatchEnabled', json('false')) WHERE thread_id = ?")
        .run("codex:fixture");
      return original(callback);
    }) as typeof db.raw.transaction);
    await store.syncThreadPrAutoDispatchCandidatesBatch({ threads: [{ backend: "codex", threadId: "fixture", prKeys: ["pr"] }], now: 1 });
    expect(db.raw.prepare("SELECT * FROM pr_auto_dispatch_candidates").all()).toEqual([]);
  } finally { db.close(); }
});
