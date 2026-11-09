import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import type { ThreadMaintenanceScan, ThreadMaintenanceScanStep } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { ThreadMaintenanceDialog } from "../ThreadMaintenanceDialog";
import { keptGuidance } from "../thread-maintenance-kept";
import { buildApplyRequest, buildOutputCoveredBy, type ThreadMaintenanceSelection } from "../thread-maintenance-selection";

// The rule: ignored files are never a reason to keep a checkout. A removed
// checkout saves tracked and non-ignored changes and deletes every ignored
// file. An older scan's rebuildableOutputIsClean or removeRebuildableOutput
// set to false changes none of that.

afterEach(() => {
  cleanup();
});

const NOW = new Date(2026, 10, 7, 11, 0).getTime();
const DAY = 86_400_000;
const GB = 1024 ** 3;

/** Any claim that an ignored file keeps a checkout, or that only known
 * output may go. */
const KEEPS_FOR_IGNORED = [
  // "Ignored files no longer keep a checkout" states the rule, not a keep.
  /ignored files?\b(?! no longer)[^.]*\bkeeps?\b/i,
  /keeps? (any|the) checkout[^.]*ignored/i,
  /other ignored files/i,
  /count dependencies and build output as clean/i,
  /remove rebuildable output/i,
  /dependencies and build output (count as clean|are removed)/i,
];

function scan(rebuildableOutputIsClean: boolean, removeRebuildableOutput: boolean): ThreadMaintenanceScan {
  return {
    scanId: "scan-1", startedAt: NOW, finishedAt: NOW,
    rules: { mode: "count", keepPerProject: 20, inactivityDays: 7, rebuildableOutputIsClean },
    spaceSource: "filesystem",
    threads: {
      checked: 1, kept: {},
      projects: [{ key: "/src/harbor-web", label: "harbor-web", path: "/src/harbor-web", kept: {}, idle: [
        { backend: "codex", threadId: "t-1", title: "Rebuild checkout flow", lastActivityAt: NOW - 26 * DAY, subThreads: 0,
          worktreePath: "/w/k3/harbor-web", workspace: { kind: "clean" } },
      ] }],
    },
    hibernate: {
      idleDays: 7, maxSnapshotMb: 100, removeRebuildableOutput, checked: 1, notIdleYet: 0, kept: {},
      items: [{ backend: "codex", threadId: "h-1", title: "Port the renderer to Rust", worktreePath: "/w/a1/kiln",
        lastActivityAt: NOW - 20 * DAY, files: 0, bytes: 0, space: { allocatedBytes: 12 * GB } }],
    },
    checkouts: { items: [], kept: {}, emptyFolders: 0 },
    expired: { enabled: false, retentionDays: 0 },
    failures: [],
  };
}

function api(fixture: ThreadMaintenanceScan) {
  return {
    scanThreadMaintenance: vi.fn(async (_request: { rules: ThreadMaintenanceScan["rules"] }) => fixture),
    getThreadMaintenanceRun: vi.fn(async () => null),
    onThreadMaintenanceRunChanged: vi.fn(() => () => {}),
  } as unknown as DesktopApi;
}

function expectNoIgnoredKeep(text: string) {
  for (const claim of KEEPS_FOR_IGNORED) expect(text).not.toMatch(claim);
}

describe("ignored files never keep a checkout", () => {
  // Oracle: every review says ignored files are deleted, and none says they
  // keep anything, whatever an older scan's compatibility fields hold.
  for (const [clean, remove] of [[true, true], [true, false], [false, true], [false, false]] as const) {
    it(`says so in each review when the scan sends rebuildableOutputIsClean ${clean}, removeRebuildableOutput ${remove}`, async () => {
      for (const tab of ["Idle threads", "Idle checkouts"]) {
        render(<ThreadMaintenanceDialog desktopApi={api(scan(clean, remove))} onClose={vi.fn()} />);
        const dialog = screen.getByRole("dialog", { name: "Thread maintenance" });
        fireEvent.click(within(dialog).getByRole("radio", { name: tab }));
        expectNoIgnoredKeep(dialog.textContent ?? "");
        fireEvent.click(within(dialog).getByRole("button", { name: "Scan" }));
        const strip = await within(dialog).findByText(/ignored files are deleted, not saved/);
        expect(strip).toBeInTheDocument();
        expectNoIgnoredKeep(dialog.textContent ?? "");
        cleanup();
      }
    });
  }

  it("offers no ignored-file switch in the plan and always scans with ignored files counted as removable", async () => {
    const desktopApi = api(scan(true, true));
    render(<ThreadMaintenanceDialog desktopApi={desktopApi} onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "Thread maintenance" });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Archive idle threads" }));
    expect(within(dialog).queryByRole("checkbox", { name: /dependencies|build output|ignored/i })).toBeNull();
    // Each removing step says what is saved and what is deleted.
    for (const step of ["Archive idle threads", "Hibernate idle checkouts"]) {
      expect(within(dialog).getByRole("region", { name: step }))
        .toHaveTextContent("Tracked and non-ignored changes are saved to a snapshot first. Ignored files are deleted and are not in the snapshot.");
    }
    fireEvent.click(within(dialog).getByRole("button", { name: "Scan" }));
    await within(dialog).findByText(/ignored files are deleted, not saved/);
    const [request] = vi.mocked(desktopApi.scanThreadMaintenance!).mock.calls[0]!;
    expect(request?.rules?.rebuildableOutputIsClean).toBe(true);
  });

  it("gives no guidance, for any reason an owner may send, that ignored files keep a checkout", () => {
    const reasons = ["Other ignored files", "Ignored files only", "Recently active", "Watching a PR", "Uncommitted changes",
      "Changes over the snapshot limit", "Stashed changes", "Submodule changes", "Git operation in progress", "Locked worktree",
      "Shared with another thread", "Used by an active thread", "Kept awake"];
    const steps: ThreadMaintenanceScanStep[] = ["threads", "hibernate", "checkouts"];
    fc.assert(fc.property(fc.constantFrom(...reasons), fc.constantFrom(...steps), fc.boolean(), (reason, step, checkoutsStep) => {
      expectNoIgnoredKeep(keptGuidance(reason, { step, idleDays: 7, inactivityDays: 30, checkoutsStep }) ?? "");
    }));
    // A legacy reason says the rule changed rather than how to satisfy it.
    expect(keptGuidance("Ignored files only", { step: "hibernate" })).toContain("Ignored files no longer keep a checkout");
  });
});

describe("build output inside a hibernated checkout, as a model", () => {
  // Hibernation deletes every ignored file, so output inside a chosen idle
  // checkout goes with it, even when an older scan sent
  // removeRebuildableOutput false.
  it("is covered by its hibernated checkout and never sent on its own", () => {
    const roots = ["/w/a", "/w/b", "/w/c"];
    fc.assert(fc.property(fc.boolean(), fc.subarray(roots), fc.subarray(roots), (remove, idleChosen, outputChosen) => {
      const fixture = scan(true, remove);
      fixture.hibernate!.items = roots.map((root, index) => ({ backend: "codex", threadId: `h-${index}`, title: root,
        worktreePath: root, lastActivityAt: NOW - 20 * DAY, files: 0, bytes: 0 }));
      fixture.checkouts.buildOutputs = roots.map((root) => ({ kind: "cargo", checkoutPath: root,
        outputPath: `${root}/target/debug`, manifestPath: `${root}/Cargo.toml`,
        threads: [{ backend: "codex", threadId: `o-${root}`, title: "Known thread" }] }));
      const selection: ThreadMaintenanceSelection = {
        threads: new Set(), overLimit: new Map(), checkouts: new Set(), emptyFolders: false,
        hibernate: new Set(idleChosen.map((root) => `codex:h-${roots.indexOf(root)}`)),
        buildOutputs: new Set(outputChosen.map((root) => `${root}/target/debug`)),
      };
      for (const root of roots) {
        expect(buildOutputCoveredBy(fixture, selection, "combined", { outputPath: `${root}/target/debug` }))
          .toBe(idleChosen.includes(root) ? root : undefined);
      }
      const sent = (buildApplyRequest(fixture, selection, "combined").removeBuildOutputs ?? []).map((item) => item.outputPath);
      expect(sent.sort()).toEqual(outputChosen.filter((root) => !idleChosen.includes(root)).map((root) => `${root}/target/debug`).sort());
    }), { numRuns: 200 });
  });
});
