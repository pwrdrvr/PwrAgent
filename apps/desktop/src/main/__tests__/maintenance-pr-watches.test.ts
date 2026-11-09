import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { PrSummary, ThreadPullRequestWatchSummary } from "@pwragent/shared";
import { protectiveMaintenanceWatches } from "../app-server/maintenance-pr-watches";

const identity = fc.record({
  provider: fc.constantFrom("github.com", "gitlab.example"), org: fc.constantFrom("team", "other"),
  repo: fc.constantFrom("project", "another"), number: fc.integer({ min: 1, max: 3 }),
});
const observations = fc.array(fc.record({
  identity, lifecycleState: fc.constantFrom("open", "merged", "closed", undefined), fetchedAt: fc.integer({ min: 0, max: 100 }),
}), { maxLength: 30 });

describe("maintenance watches, with saved observations as the oracle", () => {
  it("keeps exactly the watches whose latest matching observation is not terminal", () => {
    fc.assert(fc.property(fc.array(identity, { maxLength: 12 }), observations, fc.boolean(), (identities, saved, terminalWatch) => {
      const watches: ThreadPullRequestWatchSummary[] = identities.map((value, index) => ({
        backend: "codex", threadId: "thread", watchId: String(index),
        prKey: `${value.provider}/${value.org}/${value.repo}#${value.number}`, prUrl: "https://forge.example/pull/1", prNumber: value.number,
        headSha: "head", createdAt: 1, notifyOn: terminalWatch ? ["merged", "closed"] : ["success", "failure"],
        kind: terminalWatch ? "terminal" : "checks", failureHandledByAutoFix: false,
      }));
      // Independently order observations newest first, with the last input
      // winning a tie. Match every namespace component, not the PR number.
      const newest = saved.map((row, index) => ({ ...row, index }))
        .sort((left, right) => right.fetchedAt - left.fetchedAt || right.index - left.index);
      const expected = watches.filter((_watch, index) => {
        const value = identities[index]!;
        const found = newest.find((row) => Object.entries(value).every(([key, part]) => row.identity[key as keyof typeof value] === part));
        return found?.lifecycleState !== "merged" && found?.lifecycleState !== "closed";
      });
      const actual = protectiveMaintenanceWatches(watches, saved.map((row) => ({
        pr: { ...row.identity, lifecycleState: row.lifecycleState, state: "passing", headSha: "unrelated-head" } as PrSummary,
        fetchedAt: row.fetchedAt,
      })));
      expect(actual).toEqual(expected);
      for (const watch of actual) expect(watches).toContain(watch);
    }), { numRuns: 1000 });
  });
});
