import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import type { ThreadMaintenanceScan, ThreadMaintenanceSpace } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { ThreadMaintenanceDialog } from "../ThreadMaintenanceDialog";
import { buildApplyRequest, defaultSelection, hibernateItems, rebuildableOutputLabels } from "../thread-maintenance-selection";

afterEach(() => {
  cleanup();
});

const NOW = new Date(2026, 10, 7, 11, 0).getTime();
const DAY = 86_400_000;
const GB = 1024 ** 3;

type Output = NonNullable<ThreadMaintenanceSpace["rebuildableOutput"]>;

function scan(idleOutput?: Output, keptOutput?: Output): ThreadMaintenanceScan {
  return {
    scanId: "scan-1", startedAt: NOW, finishedAt: NOW,
    rules: { mode: "count", keepPerProject: 20, inactivityDays: 7, rebuildableOutputIsClean: true },
    spaceSource: "filesystem",
    threads: { checked: 0, projects: [], kept: {} },
    checkouts: { items: [], kept: {}, emptyFolders: 0 },
    hibernate: {
      idleDays: 7, maxSnapshotMb: 100, removeRebuildableOutput: false, checked: 3, notIdleYet: 0,
      kept: { "Recently active": 1 },
      items: [
        { backend: "codex", threadId: "h-kiln", title: "Port the renderer to Rust", worktreePath: "/w/a1/kiln",
          lastActivityAt: NOW - 20 * DAY, files: 0, bytes: 0,
          space: { allocatedBytes: 12 * GB, ...(idleOutput ? { rebuildableOutput: idleOutput } : {}) } },
        { backend: "codex", threadId: "h-docs", title: "Tidy the README", worktreePath: "/w/a2/harbor-docs",
          lastActivityAt: NOW - 30 * DAY, files: 0, bytes: 0, space: { allocatedBytes: GB } },
      ],
      coverage: {
        roots: [{ path: "/w", owner: "pwragent", checkouts: 3 }],
        keptCheckouts: [{ path: "/w/b1/grok-build", reason: "Recently active", allocatedBytes: 20 * GB,
          threads: [{ backend: "codex", threadId: "t-grok", title: "Speed up the indexer", lastActivityAt: NOW - DAY }],
          ...(keptOutput ? { rebuildableOutput: keptOutput } : {}) }],
      },
    },
    expired: { enabled: false, retentionDays: 0 },
    failures: [],
  };
}

const outputArb: fc.Arbitrary<Output> = fc.array(fc.record({
  kind: fc.constant("cargo" as const),
  allocatedBytes: fc.option(fc.nat({ max: 2 ** 40 }), { nil: undefined }),
  lowerBound: fc.option(fc.boolean(), { nil: undefined }),
}), { maxLength: 4 });

describe("build output classification, as a property", () => {
  it("never changes what a step offers, selects or sends", () => {
    const plain = scan();
    const modes = ["combined", "hibernate", "checkouts"] as const;
    fc.assert(fc.property(outputArb, outputArb, fc.constantFrom(...modes), fc.subarray(["codex:h-kiln", "codex:h-docs"]),
      (idleOutput, keptOutput, mode, chosen) => {
        const classified = scan(idleOutput, keptOutput);
        expect(hibernateItems(classified).map((item) => item.threadId)).toEqual(hibernateItems(plain).map((item) => item.threadId));
        expect(defaultSelection(classified)).toEqual(defaultSelection(plain));
        const selection = { ...defaultSelection(plain), hibernate: new Set(chosen) };
        expect(buildApplyRequest(classified, selection, mode)).toEqual(buildApplyRequest(plain, selection, mode));
      }), { numRuns: 200 });
  });

  it("labels each detected type once, summing what was measured", () => {
    fc.assert(fc.property(outputArb, (output) => {
      const labels = rebuildableOutputLabels(output);
      if (!output.length) {
        expect(labels).toEqual([]);
        return;
      }
      expect(labels).toHaveLength(1);
      const measured = output.filter((item) => item.allocatedBytes !== undefined);
      expect(labels[0]!.startsWith("Cargo output")).toBe(true);
      if (!measured.length) expect(labels[0]).toBe("Cargo output");
      else {
        // A missing or lower-bound figure makes the sum a lower bound.
        const lower = measured.length < output.length || measured.some((item) => item.lowerBound);
        expect(labels[0]!.includes("≥ ")).toBe(lower);
      }
    }));
  });
});

async function openHibernate(fixture: ThreadMaintenanceScan) {
  const desktopApi = {
    scanThreadMaintenance: vi.fn(async () => fixture),
    getThreadMaintenanceRun: vi.fn(async () => null),
    onThreadMaintenanceRunChanged: vi.fn(() => () => {}),
  } as unknown as DesktopApi;
  render(<ThreadMaintenanceDialog desktopApi={desktopApi} onClose={vi.fn()} onOpenThread={vi.fn()} />);
  const dialog = screen.getByRole("dialog", { name: "Thread maintenance" });
  fireEvent.click(within(dialog).getByRole("radio", { name: "Idle checkouts" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "Scan" }));
  const candidates = await within(dialog).findByRole("region", { name: "Can hibernate" });
  return { dialog, candidates, kept: within(dialog).getByRole("region", { name: "Kept checkouts" }) };
}

describe("build output classification in the review", () => {
  it("names Cargo output beside an owned checkout without changing its row", async () => {
    const { candidates, kept } = await openHibernate(scan([{ kind: "cargo", allocatedBytes: 9 * GB }],
      [{ kind: "cargo", allocatedBytes: 14 * GB }]));
    const rows = within(candidates).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("Cargo output · 9.0 GB");
    expect(rows[1]).not.toHaveTextContent("Cargo output");
    // Still the same two selectable rows.
    expect(within(candidates).getAllByRole("checkbox")).toHaveLength(2);
    const keptRow = within(kept).getByRole("listitem");
    expect(keptRow).toHaveTextContent("Cargo output · 14 GB");
    // A kept checkout stays kept: nothing in it can be selected.
    expect(within(kept).queryByRole("checkbox")).toBeNull();
  });

  it("names nothing when the owner sent no classification", async () => {
    const { dialog } = await openHibernate(scan());
    expect(dialog).not.toHaveTextContent("Cargo output ·");
  });
});
