import path from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { AppServerThreadSummary, LinkedDirectorySummary } from "@pwragent/shared";
import { CheckoutPathOwners, eventLoopPacer, type CheckoutOwnerCandidate } from "../app-server/checkout-path-owners";

/**
 * Oracle test. `sharedByScan` is the shared-checkout rule as hibernation
 * applied it before the index: scan every candidate, skip the asking
 * thread's own backend and id, skip archived and tombstoned threads, and
 * compare each linked or extra directory with `path.resolve` on both sides.
 * A finished PwrAgent monitor worker ran in its parent's checkout and no
 * longer uses it, so it shares nothing either.
 * The index must give the same answer for every list, candidate and path.
 */
function sharedByScan(
  candidate: Pick<CheckoutOwnerCandidate, "thread">,
  worktreePath: string,
  candidates: readonly CheckoutOwnerCandidate[],
): boolean {
  return candidates.filter(({ thread, overlay, finishedMonitorWorker }) =>
    !(thread.source === candidate.thread.source && thread.id === candidate.thread.id)
    && thread.archivedAt === undefined && overlay?.archiveTombstonedAt === undefined && !finishedMonitorWorker
    && [...thread.linkedDirectories, ...overlay?.extraLinkedDirectories ?? []]
      .some((directory) => path.resolve(directory.worktreePath ?? directory.path) === path.resolve(worktreePath))).length > 0;
}

// Spellings of a few checkouts that normalize together or apart: a trailing
// slash, `.` and `..` segments, case (distinct on POSIX `path.resolve`), and
// a relative path that resolves against the working directory.
const PATHS = [
  "/w/a/repo", "/w/a/repo/", "/w/a/./repo", "/w/b/../a/repo", "/w/A/repo",
  "/w/b/repo", "/w/b/repo/.", "/w/c", "w/a/repo", path.resolve("w/a/repo"),
];
// `acp:kimi` contains the separator a joined identity key would use.
const SOURCES = ["codex", "claude", "acp:kimi"] as const;
const IDS = ["t1", "t2", "kimi:t1"];

const directory = fc.record({
  path: fc.constantFrom(...PATHS),
  worktreePath: fc.option(fc.constantFrom(...PATHS), { nil: undefined }),
});
const owner = fc.record({
  source: fc.constantFrom(...SOURCES),
  id: fc.constantFrom(...IDS),
  archived: fc.constantFrom("no", "no", "provider", "tombstone", "retention"),
  linked: fc.array(directory, { maxLength: 3 }),
  extra: fc.option(fc.array(directory, { maxLength: 2 }), { nil: undefined }),
  finishedWorker: fc.boolean(),
});

function build(row: typeof owner extends fc.Arbitrary<infer T> ? T : never): CheckoutOwnerCandidate {
  const linked = (items: typeof row.linked): LinkedDirectorySummary[] => items.map((item, index) => ({
    id: `d${index}`, label: "repo", kind: item.worktreePath ? "worktree" : "local", path: item.path,
    ...(item.worktreePath ? { worktreePath: item.worktreePath } : {}),
  }));
  return {
    ...(row.finishedWorker ? { finishedMonitorWorker: true } : {}),
    thread: {
      id: row.id, source: row.source as AppServerThreadSummary["source"], linkedDirectories: linked(row.linked),
      ...(row.archived === "provider" ? { archivedAt: 1 } : {}),
    },
    overlay: {
      ...(row.extra ? { extraLinkedDirectories: linked(row.extra) } : {}),
      ...(row.archived === "tombstone" ? { archiveTombstonedAt: 1 } : {}),
      // Retention alone never removed an owner from the shared rule.
      ...(row.archived === "retention" ? { archiveRetentionStartedAt: 1 } : {}),
    } as CheckoutOwnerCandidate["overlay"],
  };
}

describe("CheckoutPathOwners", () => {
  it("answers exactly as the full scan did, for every list, candidate and path", () => {
    fc.assert(fc.property(
      fc.array(owner, { maxLength: 12 }),
      owner,
      fc.boolean(),
      fc.constantFrom(...PATHS),
      (rows, outsider, fromList, worktreePath) => {
        const candidates = rows.map(build);
        const owners = new CheckoutPathOwners(candidates);
        // The asking thread is usually in the list, but need not be.
        const asking = fromList && candidates.length ? candidates[0]! : build(outsider);
        expect(owners.sharedWithAnotherThread(asking, worktreePath))
          .toBe(sharedByScan(asking, worktreePath, candidates));
        // Asking again, or about another thread, reuses the same index.
        for (const other of candidates) {
          expect(owners.sharedWithAnotherThread(other, worktreePath)).toBe(sharedByScan(other, worktreePath, candidates));
        }
      },
    ), { numRuns: 3000 });
  });

  it("normalizes each listed directory once per index, however many threads ask", () => {
    const candidates = Array.from({ length: 50 }, (_, index) => build({
      source: "codex", id: `t${index}`, archived: "no",
      linked: [{ path: `/w/${index}`, worktreePath: `/w/${index}/repo` }], extra: [{ path: `/w/${index}/x`, worktreePath: undefined }],
      finishedWorker: false,
    }));
    const owners = new CheckoutPathOwners(candidates);
    let resolved = 0;
    const resolve = path.resolve;
    path.resolve = ((...segments: string[]) => { resolved += 1; return resolve(...segments); }) as typeof path.resolve;
    try {
      for (const candidate of candidates) owners.sharedWithAnotherThread(candidate, candidate.thread.linkedDirectories[0]!.worktreePath!);
    } finally {
      path.resolve = resolve;
    }
    // 100 listed directories, then one normalization per question.
    expect(resolved).toBe(100 + candidates.length);
  });

  it("builds no index when nobody asks", () => {
    const resolve = path.resolve;
    let resolved = 0;
    path.resolve = ((...segments: string[]) => { resolved += 1; return resolve(...segments); }) as typeof path.resolve;
    try {
      new CheckoutPathOwners([build({ source: "codex", id: "t1", archived: "no", linked: [{ path: "/w/a", worktreePath: undefined }], extra: undefined, finishedWorker: false })]);
    } finally {
      path.resolve = resolve;
    }
    expect(resolved).toBe(0);
  });
});

describe("eventLoopPacer", () => {
  it("lets a macrotask run once every `every` calls, and only then", async () => {
    let ticks = 0;
    let running = true;
    const tick = () => { ticks += 1; if (running) setImmediate(tick); };
    setImmediate(tick);
    try {
      const pace = eventLoopPacer(10);
      const seen: number[] = [];
      for (let call = 0; call < 100; call++) {
        await pace();
        seen.push(ticks);
      }
      // A tick lands only at calls 10, 20, … 100.
      expect(new Set(seen).size).toBe(11);
      expect(seen.slice(0, 9).every((value) => value === seen[0])).toBe(true);
    } finally {
      running = false;
    }
  });

  it("holds every concurrent worker at a pending yield", async () => {
    let ticks = 0;
    let running = true;
    const tick = () => { ticks += 1; if (running) setImmediate(tick); };
    setImmediate(tick);
    try {
      const pace = eventLoopPacer(16);
      const seen: number[] = [];
      let next = 0;
      // Eight workers draining one queue, as Thread Maintenance's scan does.
      await Promise.all(Array.from({ length: 8 }, async () => {
        while (next < 800) {
          next += 1;
          await pace();
          seen.push(ticks);
        }
      }));
      // One macrotask per 16 calls across all workers, not per worker.
      expect(new Set(seen).size).toBeGreaterThanOrEqual(800 / 16 - 8);
      // No stretch between turns runs past 16 calls plus the workers that
      // were already waiting on the yield.
      let longest = 0;
      for (let start = 0; start < seen.length;) {
        let end = start;
        while (end < seen.length && seen[end] === seen[start]) end += 1;
        longest = Math.max(longest, end - start);
        start = end;
      }
      expect(longest).toBeLessThanOrEqual(16 + 8);
    } finally {
      running = false;
    }
  });
});
