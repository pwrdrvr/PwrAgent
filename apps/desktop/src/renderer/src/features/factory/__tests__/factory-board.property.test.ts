import fc from "fast-check";
import { expect, it } from "vitest";
import type { FactoryBranchProjection, FactoryEvidenceSnapshot, FactoryProjectProjection } from "@pwragent/shared/factory-projection";
import { factoryRows } from "../factory-board";

it("keeps one stable outcome through verified publication regardless of inventory order and size", () => {
  fc.assert(fc.property(
    fc.uniqueArray(fc.integer({ min: 1, max: 150 }), { minLength: 0, maxLength: 25 }),
    fc.integer({ min: 1, max: 150 }),
    (inventory, published) => {
      const pr = (number: number) => ({
        number, title: `Synthetic pull request ${number}`, url: `https://github.com/northwind-labs/Aster/pull/${number}`,
        lifecycle: "open" as const, draft: false, firstParty: true,
      });
      const projection: FactoryProjectProjection = {
        projectKey: "directory:/example/aster", repository: { host: "github.com", owner: "northwind-labs", name: "Aster", id: "pinned" },
        authority: { source: "local_owner_github", observedAt: 1 }, inventory: "observed",
        truncated: false, pullRequests: inventory.map(pr),
      };
      const branch: FactoryBranchProjection = {
        outcomeId: "linear:10000000-0000-4000-a000-000000000042", issue: { provider: "linear", source: "local_operator", id: "10000000-0000-4000-a000-000000000042" },
        workItem: { provider: "linear", id: "10000000-0000-4000-a000-000000000042" },
        authority: { source: "local_owner_git", runtimeInstanceId: "fixture", observedAt: 1, profile: "default" },
        branch: "aster/fix", baseRef: "refs/heads/main", stage: "branch", publication: "unobserved", receipts: [],
      };
      const linked: FactoryEvidenceSnapshot = {
        pullRequest: pr(published), revisionState: "current", ci: "pending", review: "absent", reviewCoverage: "complete", candidate: { kind: "none" },
        receipts: [], digest: "fixture",
      };
      const initial = factoryRows(projection, { key: branch.outcomeId, branch }, new Map());
      const rows = factoryRows(projection, { key: branch.outcomeId, branch, linked }, new Map());
      expect(rows.find((row) => row.pr?.number === published)?.key).toBe(initial[0]?.key);
      expect(rows).toHaveLength(1 + inventory.filter((number) => number !== published).length);
      expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
    },
  ), { numRuns: 100 });
});
