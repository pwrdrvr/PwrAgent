import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ThreadDependency } from "@pwragent/shared";
import { assertMergeNotHeld, blockingMergeDependencies, resolveMergePullRequest } from "../app-server/thread-dependency-merge-hold";

// Oracle: a merge is held exactly when an active (waiting or ready) wait with
// holdMerge belongs to the merging thread, or to a thread that has the same
// pull request attached. A PR is its forge, repository and number; URL case
// does not make it another PR. Delivered, cancelled, dismissed and
// dispatching waits, and waits without holdMerge, hold nothing.

type Pr = { forge: "github" | "gitlab"; org: string; repo: string; number: number };
const pr = fc.record({
  forge: fc.constantFrom<Pr["forge"]>("github", "gitlab"),
  org: fc.constantFrom("example", "acme"),
  repo: fc.constantFrom("app", "tools"),
  number: fc.integer({ min: 1, max: 3 }),
});
const casing = fc.boolean();
const url = (value: Pr, upper: boolean): string => {
  const path = `${value.org}/${value.repo}`;
  const shown = upper ? path.toUpperCase() : path;
  return value.forge === "github"
    ? `https://github.com/${shown}/pull/${value.number}`
    : `https://gitlab.com/${shown}/-/merge_requests/${value.number}`;
};
const samePr = (a: Pr, b: Pr) => a.forge === b.forge && a.org === b.org && a.repo === b.repo && a.number === b.number;

const threads = ["a", "b", "c"] as const;
const wait = fc.record({
  threadId: fc.constantFrom(...threads),
  status: fc.constantFrom<ThreadDependency["status"]>("waiting", "ready", "dispatching", "delivered", "cancelled", "dismissed"),
  holdMerge: fc.boolean(),
});
const world = fc.record({
  waits: fc.array(wait, { maxLength: 6 }),
  // Each thread's attached PRs, with the URL casing they were stored in.
  attached: fc.record({ a: fc.array(fc.tuple(pr, casing), { maxLength: 2 }), b: fc.array(fc.tuple(pr, casing), { maxLength: 2 }), c: fc.array(fc.tuple(pr, casing), { maxLength: 2 }) }),
  merging: fc.constantFrom(...threads),
  mergingPr: fc.option(fc.tuple(pr, casing), { nil: undefined }),
});

describe("Continue After merge holds", () => {
  it("hold a merge exactly when an active holding wait shares the thread or the PR", () => {
    fc.assert(fc.property(world, ({ waits, attached, merging, mergingPr }) => {
      const dependencies = waits.map((item, index): ThreadDependency => ({
        id: `wait-${index}`, backend: "codex", threadId: item.threadId, status: item.status, holdMerge: item.holdMerge,
        mode: "all", onFailure: "notify", deliver: "operator", createdAt: 1, updatedAt: 1, evidence: [],
        conditions: [{ backend: "codex", threadId: "", when: "marked_done", subject: "Validation" }],
      }));
      const target = { backend: "codex", threadId: merging, ...(mergingPr ? { pullRequest: url(...mergingPr) } : {}) };
      const read = (thread: { threadId: string }) => attached[thread.threadId as typeof threads[number]].map(([value, upper]) => url(value, upper));
      const expected = dependencies.filter((item, index) => {
        const active = waits[index]!.status === "waiting" || waits[index]!.status === "ready";
        const sharesPr = mergingPr !== undefined && attached[item.threadId as typeof threads[number]].some(([value]) => samePr(value, mergingPr[0]));
        return item.holdMerge && active && (item.threadId === merging || sharesPr);
      }).map((item) => item.id);
      expect(blockingMergeDependencies(dependencies, target, read).map((item) => item.id)).toEqual(expected);
      if (expected.length) expect(() => assertMergeNotHeld(dependencies, target, read)).toThrow("Merge held");
      else expect(() => assertMergeNotHeld(dependencies, target, read)).not.toThrow();
    }));
  });

  // Oracle: a bare number names the thread's one attached PR with that
  // number, so a card that names it holds exactly as its URL would. With no
  // such PR, or that number in two repositories, the number stays as given.
  it("resolves a PR number through the thread's attached PRs", () => {
    fc.assert(fc.property(fc.array(fc.tuple(pr, casing), { maxLength: 3 }), pr, fc.boolean(),
      (attached, named, hash) => {
        const urls = attached.map(([value, upper]) => url(value, upper));
        const given = `${hash ? "#" : ""}${named.number}`;
        const same = attached.filter(([value]) => value.number === named.number);
        const distinct = same.filter(([value], index) => same.findIndex(([other]) => samePr(other, value)) === index);
        const resolved = resolveMergePullRequest(given, urls);
        if (distinct.length === 1) {
          expect(urls.filter((_, index) => samePr(attached[index]![0], distinct[0]![0]))).toContain(resolved);
        } else {
          expect(resolved).toBe(given);
        }
        expect(resolveMergePullRequest(url(named, false), urls)).toBe(url(named, false));
      }));
  });
});
