import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildPullRequestStatusKey, type PrSummary } from "@pwragent/shared/contracts/navigation";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { openInMemoryStateDb } from "./sqlite-test-utils";

let stateDb: StateDb;
let store: SqliteOverlayStore;

beforeEach(() => {
  stateDb = openInMemoryStateDb();
  store = new SqliteOverlayStore(stateDb);
});

afterEach(() => {
  stateDb.close();
});

const thread = { backend: "codex" as const, threadId: "thread-auto-fix-off" };

function pr(number: number, title: string): PrSummary {
  return {
    provider: "github.com",
    number,
    org: "pwrdrvr",
    repo: "t3code",
    title,
    state: "passing",
    url: `https://github.com/pwrdrvr/t3code/pull/${number}`,
  };
}

type Op =
  | { kind: "lookup"; numbers: number[]; title: string; staleOff: number[] }
  | { kind: "attach"; number: number }
  | { kind: "detach"; number: number }
  | { kind: "switch"; number: number; off: boolean };

const number = fc.integer({ min: 1, max: 4 });
const op: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    kind: fc.constant("lookup" as const),
    numbers: fc.uniqueArray(number, { maxLength: 4 }),
    title: fc.constantFrom("Fix flaky CI", "Rebase onto main"),
    // Rows a lookup read before its fetch can carry a switch since undone.
    staleOff: fc.uniqueArray(number, { maxLength: 4 }),
  }),
  fc.record({ kind: fc.constant("attach" as const), number }),
  fc.record({ kind: fc.constant("detach" as const), number }),
  fc.record({ kind: fc.constant("switch" as const), number, off: fc.boolean() }),
);

describe("per-PR Auto-fix off on a thread's attachment list", () => {
  it("keeps the operator's switch through every lookup, attach and detach, and nothing else sets it", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(op, { maxLength: 24 }), async (ops) => {
        stateDb.close();
        stateDb = openInMemoryStateDb();
        store = new SqliteOverlayStore(stateDb);
        // Model: which PRs the thread holds, and which of those are off. A
        // switch only lands on a held PR; a PR leaving the list forgets it.
        const held = new Set<number>();
        const off = new Set<number>();
        let fetchedAt = 1_000;
        for (const step of ops) {
          if (step.kind === "lookup") {
            fetchedAt += 1;
            await store.setThreadPullRequests({
              ...thread,
              prs: step.numbers.map((n) => step.staleOff.includes(n)
                ? { ...pr(n, step.title), autoFixOff: true as const }
                : pr(n, step.title)),
              fetchedAt,
            });
            const stored = new Set(((await store.getThreadOverlayState(thread))?.prs ?? []).map((row) => row.number));
            for (const n of [...held]) if (!stored.has(n)) held.delete(n);
            for (const n of stored) held.add(n);
          } else if (step.kind === "attach") {
            await store.addThreadPullRequestReference({ ...thread, pr: pr(step.number, "Attached") });
            held.add(step.number);
          } else if (step.kind === "detach") {
            await store.detachThreadPullRequest({ ...thread, pr: pr(step.number, "Attached") });
            held.delete(step.number);
          } else {
            const key = buildPullRequestStatusKey(pr(step.number, ""));
            await store.setThreadPullRequestAutoFixOff({
              ...thread,
              matchesPrKey: (stored) => stored === key,
              off: step.off,
            });
            if (held.has(step.number) && step.off) off.add(step.number);
            if (!step.off) off.delete(step.number);
          }
          for (const n of [...off]) if (!held.has(n)) off.delete(n);
          const rows = (await store.getThreadOverlayState(thread))?.prs ?? [];
          expect(
            rows.filter((row) => row.autoFixOff === true).map((row) => row.number).sort(),
          ).toEqual([...off].sort());
        }
      }),
      { numRuns: 150 },
    );
  });

  it("keeps a PR switched back on when a lookup that read it earlier writes its rows", async () => {
    await store.setThreadPullRequests({ ...thread, prs: [pr(2, "Fix flaky CI")], fetchedAt: 1 });
    const key = buildPullRequestStatusKey(pr(2, ""));
    await store.setThreadPullRequestAutoFixOff({ ...thread, matchesPrKey: (stored) => stored === key, off: true });
    await store.setThreadPullRequestAutoFixOff({ ...thread, matchesPrKey: (stored) => stored === key, off: false });
    // The lookup merged rows it read while the PR was still switched off.
    await store.setThreadPullRequests({
      ...thread,
      prs: [{ ...pr(2, "Fix flaky CI"), autoFixOff: true }],
      fetchedAt: 2,
    });
    expect((await store.getThreadOverlayState(thread))?.prs?.[0]?.autoFixOff).toBeUndefined();
  });

  it("reports no change for a PR the thread does not hold", async () => {
    await store.setThreadPullRequests({ ...thread, prs: [pr(1, "Fix flaky CI")], fetchedAt: 1 });
    const result = await store.setThreadPullRequestAutoFixOff({
      ...thread,
      matchesPrKey: (stored) => stored === buildPullRequestStatusKey(pr(2, "")),
      off: true,
    });
    expect(result.changed).toBe(false);
    expect(result.state?.prs?.[0]?.autoFixOff).toBeUndefined();
  });
});
