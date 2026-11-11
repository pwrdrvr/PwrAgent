import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PR_STATUS_WATCH_MAX_DISPATCH_ATTEMPTS } from "../pr-status/pr-status-watch";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { openInMemoryStateDb } from "./sqlite-test-utils";

/*
 * The limit a PR watch promises (`pr-status-watch.ts`):
 *
 *   A watch wakes its thread at most PR_STATUS_WATCH_MAX_DISPATCH_ATTEMPTS
 *   times. A claim spends an attempt; a release that did not submit (a busy
 *   thread, a project holding it back) gives that attempt back; a failed
 *   submission keeps it. Reading watches spends and refunds nothing.
 *
 * Model: per watch, claims granted minus attempts given back. Oracle for
 * read purity: a second database with the same writes and no reads.
 */
afterEach(() => vi.unstubAllEnvs());

const MAX = PR_STATUS_WATCH_MAX_DISPATCH_ATTEMPTS;
const PR_KEY = "github.com/example/project#1";
const HEAD = "a".repeat(40);
const WATCHES = ["watch-0", "watch-1"] as const;
const READS = ["active", "all", "allPr", "history", "claimActive"] as const;

const operation = fc.record({
  kind: fc.constantFrom("claim", "claim", "release", "release", "finish", "renew"),
  watch: fc.constantFrom(0, 1),
  ownerId: fc.constantFrom("first", "first", "second"),
  outcome: fc.constantFrom("success", "failure") as fc.Arbitrary<"success" | "failure">,
  spendAttempt: fc.boolean(),
  // Long gaps let a dispatch lease expire, so another owner can reclaim.
  advance: fc.oneof(
    { arbitrary: fc.constant(0), weight: 1 },
    { arbitrary: fc.integer({ min: 0, max: 5_000 }), weight: 1 },
    { arbitrary: fc.integer({ min: 55_000, max: 120_000 }), weight: 2 },
  ),
  reads: fc.subarray([...READS]),
});
type Operation = typeof operation extends fc.Arbitrary<infer T> ? T : never;

function step(fields: Partial<Operation> & Pick<Operation, "kind">): Operation {
  return {
    watch: 0,
    ownerId: "first",
    outcome: "failure",
    spendAttempt: false,
    advance: 0,
    reads: [],
    ...fields,
  };
}

/*
 * A release that gives back more than the one attempt it held. Two claims
 * (the second after the first lease expires), one non-spending release, then
 * claims until the limit: with a correct refund the watch stops at MAX; an
 * over-refund lets one more claim through. Random sequences reach this shape
 * only about half the time.
 */
const OVER_REFUND: Operation[] = [
  step({ kind: "claim" }),
  step({ kind: "claim", ownerId: "second", advance: 61_000 }),
  step({ kind: "release", ownerId: "second" }),
  step({ kind: "claim", advance: 61_000 }),
  step({ kind: "claim", advance: 61_000 }),
  step({ kind: "claim", advance: 61_000 }),
];

async function runWrite(store: SqliteOverlayStore, op: Operation, now: number): Promise<unknown> {
  const watchId = WATCHES[op.watch]!;
  switch (op.kind) {
    case "claim": return await store.claimThreadPrStatusWatches({ prKey: PR_KEY, headSha: HEAD,
      outcome: op.outcome, now, ownerId: op.ownerId, leaseExpiresAt: now + 60_000, maxAttempts: MAX });
    case "release": return await store.releaseThreadPrStatusWatch({ watchId, ownerId: op.ownerId, now,
      spendAttempt: op.spendAttempt, maxAttempts: MAX });
    case "finish": return await store.finishThreadPrStatusWatch({ watchId, ownerId: op.ownerId, now,
      prKey: PR_KEY, headSha: HEAD, outcome: op.outcome });
    case "renew": return await store.renewThreadPrStatusWatchLease({ watchId, ownerId: op.ownerId, now,
      leaseExpiresAt: now + 60_000 });
  }
}

async function runRead(store: SqliteOverlayStore, read: (typeof READS)[number], op: Operation): Promise<unknown> {
  const thread = { backend: "codex" as const, threadId: `thread-${op.watch}` };
  switch (read) {
    case "active": return await store.listActiveThreadPrStatusWatches(thread);
    case "all": return await store.listAllActiveThreadPrStatusWatches();
    case "allPr": return await store.listAllActivePrStatusWatches();
    case "history": return await store.listThreadPrStatusWatchHistory({ ...thread, limit: 20 });
    case "claimActive": return await store.isThreadPrStatusWatchClaimActive({ watchId: WATCHES[op.watch]!, ownerId: op.ownerId });
  }
}

describe("PR watch dispatch attempts (model, oracle: the same writes without reads)", () => {
  it("never grants more than MAX unreturned claims, and reads change nothing", async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    await fc.assert(fc.asyncProperty(fc.array(operation, { minLength: 1, maxLength: 40 }), async (operations) => {
      const readDb = openInMemoryStateDb();
      const oracleDb = openInMemoryStateDb();
      const reader = new SqliteOverlayStore(readDb);
      const oracle = new SqliteOverlayStore(oracleDb);
      let now = 1_000;
      const spent = [0, 0];
      try {
        for (const store of [reader, oracle]) {
          for (const [index, watchId] of WATCHES.entries()) {
            await store.registerThreadPrStatusWatch({ watch: {
              watchId, backend: "codex", threadId: `thread-${index}`, prKey: PR_KEY,
              prUrl: "https://github.com/example/project/pull/1", prNumber: 1, headSha: HEAD,
              notifyOn: ["success", "failure"], createdAt: now + index, failureHandledByAutoFix: false,
            }, now });
          }
        }
        for (const op of operations) {
          now += op.advance;
          const actual = await runWrite(reader, op, now);
          expect(actual, `${op.kind}: a read changed this answer`).toEqual(await runWrite(oracle, op, now));
          if (op.kind === "claim") {
            for (const claim of (actual as { claims: Array<{ watch: { watchId: string } }> }).claims) {
              spent[WATCHES.indexOf(claim.watch.watchId as (typeof WATCHES)[number])]! += 1;
            }
          }
          if (op.kind === "release" && actual !== undefined && !op.spendAttempt) spent[op.watch]! -= 1;
          for (const read of op.reads) {
            const { writes } = await measureSqliteWrites(() => runRead(reader, read, op));
            expect(writes.commits, `${read} wrote`).toBe(0);
          }
          for (const count of spent) {
            expect(count, "a watch woke its thread more than MAX times").toBeLessThanOrEqual(MAX);
            expect(count).toBeGreaterThanOrEqual(0);
          }
        }
        for (const read of READS) {
          for (const watch of [0, 1] as const) {
            const op = { ...operations[0]!, watch };
            expect(await runRead(reader, read, op), `final ${read}`).toEqual(await runRead(oracle, read, op));
          }
        }
      } finally { readDb.close(); oracleDb.close(); }
    }), { numRuns: 60, examples: [[OVER_REFUND]] });
  });
});
