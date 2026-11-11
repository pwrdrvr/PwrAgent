import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { ThreadMaintenanceArchivedCheckout, ThreadMaintenanceScan, ThreadMaintenanceWorkspace } from "@pwragent/shared";
import { buildApplyRequest, defaultSelection } from "../thread-maintenance-selection";

const NOW = new Date(2026, 10, 11, 9, 0).getTime();

function scanWith(items: ThreadMaintenanceArchivedCheckout[]): ThreadMaintenanceScan {
  return {
    scanId: "scan-1", startedAt: NOW, finishedAt: NOW,
    rules: { mode: "count", keepPerProject: 20, inactivityDays: 7, rebuildableOutputIsClean: true },
    threads: { checked: 0, kept: {}, projects: [] },
    checkouts: { items, kept: {}, emptyFolders: 0 },
    expired: { enabled: false, retentionDays: 0 },
    failures: [],
  } as unknown as ThreadMaintenanceScan;
}

const workspace: fc.Arbitrary<ThreadMaintenanceWorkspace> = fc.constantFrom<ThreadMaintenanceWorkspace>(
  { kind: "clean" },
  { kind: "changes", files: 2, bytes: 40 },
  { kind: "overLimit", files: 3, bytes: 900, limitBytes: 100, largest: [{ path: "fixture.bin", bytes: 800 }] },
);

const checkout = fc.record({ kind: fc.constantFrom("removable" as const, "repositoryGone" as const), workspace });

describe("archived checkouts over the snapshot limit", () => {
  // Rule: an over-limit archived checkout needs the operator's decision, so
  // it never starts selected. Choosing it sends snapshotAll; nothing else does.
  it("never preselects one, and sends snapshotAll exactly for a chosen one", () => {
    fc.assert(fc.property(fc.array(checkout, { maxLength: 6 }), (rows) => {
      const items: ThreadMaintenanceArchivedCheckout[] = rows.map((row, index) => ({
        backend: "codex", threadId: `t${index}`, title: `Archived work ${index}`, worktreePath: `/fixture/worktrees/${index}/app`,
        kind: row.kind, workspace: row.workspace,
      }));
      const scan = scanWith(items);
      const overLimit = (item: ThreadMaintenanceArchivedCheckout) => item.kind === "removable" && item.workspace?.kind === "overLimit";

      expect([...defaultSelection(scan).checkouts].sort()).toEqual(items
        .filter((item) => item.kind === "removable" && !overLimit(item)).map((item) => item.worktreePath).sort());

      const everything = { ...defaultSelection(scan), checkouts: new Set(items.map((item) => item.worktreePath)) };
      const request = buildApplyRequest(scan, everything, "checkouts");
      expect(request.removeCheckouts).toEqual(items.filter((item) => item.kind === "removable").map((item) => ({
        backend: "codex", threadId: (item as { threadId: string }).threadId, worktreePath: item.worktreePath,
        ...(overLimit(item) ? { snapshotAll: true } : {}),
      })));
    }), { examples: [[[{ kind: "removable", workspace: { kind: "overLimit", files: 3, bytes: 900, limitBytes: 100, largest: [] } }]]] });
  });
});
