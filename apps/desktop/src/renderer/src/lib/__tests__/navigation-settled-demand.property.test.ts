import fc from "fast-check";
import { expect, it } from "vitest";
import type { NavigationDirectoryRow } from "@pwragent/shared/contracts/navigation";
import { buildNavigationWindowDemand } from "../navigation-window-demand";

/**
 * The sidebar asks the owner for a project's Settled section only when the
 * project has settled roots and the section is open, and Unpinned then asks
 * for the rest. The Settled fold never decides Unpinned, and a project with
 * nothing settled asks exactly what it asked before Settle existed.
 */

const KEYS = ["directory:a", "directory:b", "directory:c"];
const fold = fc.option(fc.boolean(), { nil: undefined });

const directoryRow = (key: string) => fc.record({
  directoryThreadsCollapsed: fold,
  settledCollapsed: fold,
  settledRootCount: fc.option(fc.integer({ min: 0, max: 3 }), { nil: undefined }),
}).map((spec): NavigationDirectoryRow => ({
  key, kind: "directory", label: key, launchpadPresent: true,
  counts: { total: 10, active: 0, unread: 0, review: 0 }, pinnedRootCount: 1, unpinnedRootCount: 9,
  ...(spec.directoryThreadsCollapsed !== undefined ? { directoryThreadsCollapsed: spec.directoryThreadsCollapsed } : {}),
  ...(spec.settledCollapsed !== undefined ? { settledCollapsed: spec.settledCollapsed } : {}),
  ...(spec.settledRootCount !== undefined ? { settledRootCount: spec.settledRootCount } : {}),
}));

const folds = fc.dictionary(fc.constantFrom(...KEYS), fc.boolean());
const scenario = fc.record({
  directories: fc.tuple(...KEYS.map(directoryRow)),
  expandedByKey: folds,
  unpinnedExpandedByKey: folds,
  settledExpandedByKey: fc.option(folds, { nil: undefined }),
});

type Scenario = typeof scenario extends fc.Arbitrary<infer T> ? T : never;

const demandOf = (input: Scenario, directories: readonly NavigationDirectoryRow[]) =>
  buildNavigationWindowDemand({
    browseMode: "directories", attentionView: { id: "window", promoteOnTurnEnd: true },
    directories, expandedByKey: input.expandedByKey, unpinnedExpandedByKey: input.unpinnedExpandedByKey,
    ...(input.settledExpandedByKey ? { settledExpandedByKey: input.settledExpandedByKey } : {}),
  });

it("asks for Settled only when a project has settled roots and the section is open", () => {
  fc.assert(fc.property(scenario, (input) => {
    const demand = demandOf(input, input.directories);
    for (const directory of input.directories) {
      const expanded = input.expandedByKey[directory.key] ?? false;
      const hasSettled = (directory.settledRootCount ?? 0) > 0;
      // Folded unless chosen open, here first, then on the owner.
      const settledOpen = input.settledExpandedByKey?.[directory.key] ?? directory.settledCollapsed === false;
      const unpinnedOpen = input.unpinnedExpandedByKey[directory.key] ?? !directory.directoryThreadsCollapsed;
      const settled = demand.get(`directory-settled:${directory.key}`);
      expect(Boolean(settled)).toBe(expanded && hasSettled && settledOpen);
      if (settled) expect(settled.query).toEqual({ kind: "directory", directoryKey: directory.key, roots: "unpinned", settled: "only" });
      const unpinned = demand.get(`directory:${directory.key}`);
      expect(Boolean(unpinned)).toBe(expanded && unpinnedOpen);
      if (unpinned) {
        expect(unpinned.query).toEqual({ kind: "directory", directoryKey: directory.key, roots: "unpinned",
          ...(hasSettled ? { settled: "exclude" } : {}) });
      }
    }
  }));
});

it("asks exactly what it asked before Settle for projects with nothing settled (upgrade oracle)", () => {
  fc.assert(fc.property(scenario, (input) => {
    const unsettled = input.directories.map((directory) =>
      (directory.settledRootCount ?? 0) > 0 ? { ...directory, settledRootCount: 0 } : directory);
    // Before Settle, a row carried no Settled fields and the window had no Settled folds.
    const before = unsettled.map(({ settledCollapsed: _fold, settledRootCount: _count, ...rest }) => rest);
    const demand = demandOf(input, unsettled);
    expect(demand).toEqual(demandOf({ ...input, settledExpandedByKey: undefined }, before));
    expect([...demand.keys()].some((key) => key.startsWith("directory-settled:"))).toBe(false);
  }));
});
