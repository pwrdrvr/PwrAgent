import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import type {
  ThreadMaintenanceApplyRequest,
  ThreadMaintenanceRun,
  ThreadMaintenanceScan,
  ThreadMaintenanceScanStep,
} from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { ThreadMaintenanceDialog } from "../ThreadMaintenanceDialog";
import { buildApplyRequest, type ThreadMaintenanceSelection } from "../thread-maintenance-selection";

afterEach(() => {
  cleanup();
});

const NOW = new Date(2026, 10, 7, 11, 0).getTime();
const GB = 1024 ** 3;
const owner = (threadId: string, title: string) => [{ backend: "codex", threadId, title }];

function scanWith(overrides: Partial<ThreadMaintenanceScan["checkouts"]> = {}, removeRebuildableOutput = true): ThreadMaintenanceScan {
  return {
    scanId: "scan-1",
    startedAt: NOW,
    finishedAt: NOW + 1000,
    rules: { mode: "count", keepPerProject: 20, inactivityDays: 7, rebuildableOutputIsClean: true },
    spaceSource: "filesystem",
    threads: { checked: 0, projects: [], kept: {} },
    hibernate: {
      idleDays: 3, maxSnapshotMb: 100, removeRebuildableOutput, checked: 1, kept: {},
      items: [{ backend: "codex", threadId: "h-1", title: "Idle kiln", worktreePath: "/w/idle/kiln",
        lastActivityAt: NOW - 9 * 86_400_000, files: 0, bytes: 0 }],
    },
    checkouts: {
      items: [
        { backend: "codex", threadId: "a-1", title: "Archived ledger", worktreePath: "/w/old/ledger",
          kind: "removable", workspace: { kind: "clean" }, space: { allocatedBytes: 9 * GB } },
      ],
      kept: {},
      emptyFolders: 0,
      buildOutputs: [
        { kind: "cargo", checkoutPath: "/w/live/kiln", outputPath: "/w/live/kiln/target/debug",
          manifestPath: "/w/live/kiln/Cargo.toml", space: { allocatedBytes: 4 * GB }, threads: owner("t-kiln", "Port the renderer to Rust") },
        { kind: "cargo", checkoutPath: "/repos/grok", outputPath: "/repos/grok/target/debug",
          manifestPath: "/repos/grok/Cargo.toml", space: { allocatedBytes: 31 * GB }, threads: owner("t-grok", "Speed up the indexer") },
        // Inside the archived checkout the default selection removes.
        { kind: "cargo", checkoutPath: "/w/old/ledger", outputPath: "/w/old/ledger/target/debug",
          manifestPath: "/w/old/ledger/Cargo.toml", space: { allocatedBytes: 7 * GB }, threads: owner("a-1", "Archived ledger") },
        // No thread identified: never offered.
        { kind: "cargo", checkoutPath: "/w/stray/forge", outputPath: "/w/stray/forge/target/release",
          manifestPath: "/w/stray/forge/Cargo.toml", space: { allocatedBytes: 60 * GB } },
      ],
      ...overrides,
    },
    expired: { enabled: false, retentionDays: 0 },
    failures: [],
  };
}

describe("build output requests, as a model", () => {
  const roots = ["/w/a", "/w/b", "/w/c"];
  const output = fc.record({
    root: fc.constantFrom(...roots, "/repos/x"),
    sub: fc.constantFrom("target/debug", "target/aarch64-apple-darwin/release", "crates/core/target/debug", ""),
    // Absent, empty, or a known thread.
    threads: fc.constantFrom(undefined, [], owner("t-x", "Known thread")),
  }).map(({ root, sub, threads }) => ({
    kind: "cargo" as const, checkoutPath: root, outputPath: sub ? `${root}/${sub}` : root, manifestPath: `${root}/Cargo.toml`,
    ...(threads ? { threads } : {}),
  }));
  const stepsArb = fc.subarray<ThreadMaintenanceScanStep>(["threads", "hibernate", "checkouts"], { minLength: 1 });

  it("sends each chosen owned output once, never an ownerless one or one inside a checkout the request removes, and only in a checkouts run", () => {
    fc.assert(fc.property(
      fc.array(output, { maxLength: 8 }), fc.boolean(), stepsArb,
      fc.subarray(roots), fc.subarray(roots), fc.func(fc.boolean()),
      (outputs, rebuildable, steps, archivedChosen, idleChosen, pick) => {
        const scan = scanWith({
          items: roots.map((root, index) => ({ backend: "codex", threadId: `a-${index}`, worktreePath: root,
            kind: "removable" as const, workspace: { kind: "clean" as const } })),
          buildOutputs: outputs,
        }, rebuildable);
        scan.hibernate!.items = roots.map((root, index) => ({ backend: "claude", threadId: `h-${index}`, title: root,
          worktreePath: root, lastActivityAt: NOW, files: 0, bytes: 0 }));
        const chosen = new Set(outputs.filter((item) => pick(item.outputPath)).map((item) => item.outputPath));
        const selection: ThreadMaintenanceSelection = {
          threads: new Set(), overLimit: new Map(), emptyFolders: false,
          checkouts: new Set(archivedChosen),
          hibernate: new Set(idleChosen.map((root) => `claude:h-${roots.indexOf(root)}`)),
          buildOutputs: chosen,
        };
        const request = buildApplyRequest(scan, selection, steps);
        // Oracle, written out longhand.
        const inside = (path: string, root: string) => path === root || path.startsWith(`${root}/`);
        const removed = [
          ...(steps.includes("checkouts") ? archivedChosen : []),
          // Hibernation deletes every ignored file, whatever an older scan's field says.
          ...(steps.includes("hibernate") ? idleChosen : []),
        ];
        const owned = new Set(outputs.filter((item) => (item.threads?.length ?? 0) > 0).map((item) => item.outputPath));
        const expected = steps.includes("checkouts")
          ? [...chosen].filter((path) => owned.has(path) && !removed.some((root) => inside(path, root)))
          : [];
        const sent = (request.removeBuildOutputs ?? []).map((item) => item.outputPath);
        expect(sent.sort()).toEqual([...new Set(expected)].sort());
        if (!sent.length) expect(request).not.toHaveProperty("removeBuildOutputs");
        // Build outputs never change the rest of the request.
        const without = buildApplyRequest({ ...scan, checkouts: { ...scan.checkouts, buildOutputs: undefined } }, selection, steps);
        const { removeBuildOutputs: _ignored, ...rest } = request;
        expect(rest).toEqual(without);
      },
    ), { numRuns: 500 });
  });
});

function api(scan: ThreadMaintenanceScan) {
  return {
    scanThreadMaintenance: vi.fn(async () => scan),
    applyThreadMaintenance: vi.fn(async (request: ThreadMaintenanceApplyRequest): Promise<ThreadMaintenanceRun> => ({
      runId: "run-1", revision: 1, scanId: request.scanId, running: true, startedAt: NOW, steps: [], problems: [],
    })),
    getThreadMaintenanceRun: vi.fn(async () => null),
    stopThreadMaintenance: vi.fn(async () => {}),
    onThreadMaintenanceRunChanged: vi.fn(() => () => {}),
  } as unknown as DesktopApi;
}

async function openCheckouts(scan: ThreadMaintenanceScan, onOpenThread = vi.fn()) {
  const desktopApi = api(scan);
  render(<ThreadMaintenanceDialog desktopApi={desktopApi} onClose={vi.fn()} onOpenThread={onOpenThread} />);
  const dialog = screen.getByRole("dialog", { name: "Thread maintenance" });
  fireEvent.click(within(dialog).getByRole("radio", { name: "Archived checkouts" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "Scan" }));
  const section = await within(dialog).findByRole("region", { name: "Build output" });
  return { desktopApi, dialog, section, onOpenThread };
}

describe("ThreadMaintenanceDialog build output", () => {
  it("reviews build output apart from checkouts, largest first, none chosen until the operator picks", async () => {
    const { desktopApi, dialog, section } = await openCheckouts(scanWith());
    expect(section).toHaveTextContent("Build output · 3");
    expect(section).toHaveTextContent("Detected type: Cargo.");
    expect(section).toHaveTextContent("Deletes the compiled files in each selected Cargo profile folder");
    expect(section).toHaveTextContent("the next build of that profile compiles again");
    // Never claims more than one profile folder.
    expect(section).not.toHaveTextContent(/target folder|target directory|cargo clean/i);
    const rows = within(section).getAllByRole("listitem");
    // Each row leads with the thread that uses it; the checkout path follows.
    expect(rows.map((row) => row.querySelector(".thread-maintenance__row-title")?.textContent))
      .toEqual(["Speed up the indexer", "Archived ledger", "Port the renderer to Rust"]);
    expect(rows.map((row) => row.querySelector(".thread-maintenance__path")?.textContent))
      .toEqual(["/repos/grok", "/w/old/ledger", "/w/live/kiln"]);
    expect(rows[0]).toHaveTextContent("Cargo · target/debug");
    expect(within(section).getByRole("checkbox", { name: "Clean /repos/grok/target/debug" })).not.toBeChecked();
    // The archived checkout is selected by default, so its output goes with it.
    const covered = within(section).getByRole("checkbox", { name: "Clean /w/old/ledger/target/debug" });
    expect(covered).toBeChecked();
    expect(within(section).getByText("Removed with its checkout")).toBeInTheDocument();
    const footnote = () => dialog.querySelector(".thread-maintenance__footnote")?.textContent;
    expect(footnote()).toBe("1 selected · 9.0 GB on disk");

    fireEvent.click(within(section).getByRole("checkbox", { name: "Select every build output" }));
    // Two offered outputs plus the one checkout; the covered output is counted once, with its checkout.
    expect(footnote()).toBe("3 selected · 2 build outputs · 44 GB on disk");
    expect(within(section).getByText(/Selected: 35 GB on disk\./)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Remove 3 and finish" }));
    await waitFor(() => expect(desktopApi.applyThreadMaintenance).toHaveBeenCalledOnce());
    const request = vi.mocked(desktopApi.applyThreadMaintenance!).mock.calls[0]![0];
    expect(request.removeCheckouts.map((item) => item.worktreePath)).toEqual(["/w/old/ledger"]);
    expect(request.removeBuildOutputs).toEqual([{ outputPath: "/w/live/kiln/target/debug" }, { outputPath: "/repos/grok/target/debug" }]);
  });

  it.each(["single", "skip earlier", "keep earlier"])("review regression: Skip checkouts clears every checkout action (%s)", async (mode) => {
    await fc.assert(fc.asyncProperty(fc.subarray(["/repos/grok/target/debug", "/w/live/kiln/target/debug"], { minLength: 1 }), async (picked) => {
      const scan = scanWith({ emptyFolders: 2 });
      const desktopApi = api(scan);
      const onClose = vi.fn();
      try {
        render(<ThreadMaintenanceDialog desktopApi={desktopApi} onClose={onClose} />);
        const dialog = screen.getByRole("dialog", { name: "Thread maintenance" });
        if (mode === "single") fireEvent.click(within(dialog).getByRole("radio", { name: "Archived checkouts" }));
        fireEvent.click(within(dialog).getByRole("button", { name: "Scan" }));
        if (mode !== "single") {
          fireEvent.click(await within(dialog).findByRole("button", {
            name: mode === "keep earlier" ? "Hibernate 1 and continue" : "Skip idle checkouts",
          }));
        }
        const section = await within(dialog).findByRole("region", { name: "Build output" });
        for (const outputPath of picked) fireEvent.click(within(section).getByRole("checkbox", { name: `Clean ${outputPath}` }));
        fireEvent.click(within(dialog).getByRole("button", { name: "Skip checkouts" }));
        if (mode === "keep earlier") {
          await waitFor(() => expect(desktopApi.applyThreadMaintenance).toHaveBeenCalledOnce());
          expect(vi.mocked(desktopApi.applyThreadMaintenance!).mock.calls[0]![0]).toMatchObject({
            archive: [], removeCheckouts: [], trashCheckouts: [], removeEmptyFolders: false,
            hibernate: [{ backend: "codex", threadId: "h-1" }],
          });
          expect(vi.mocked(desktopApi.applyThreadMaintenance!).mock.calls[0]![0]).not.toHaveProperty("removeBuildOutputs");
          expect(onClose).not.toHaveBeenCalled();
        } else {
          await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
          expect(desktopApi.applyThreadMaintenance).not.toHaveBeenCalled();
        }
      } finally { cleanup(); }
    }), { numRuns: 4 });
  });

  it("offers an output on its own again when its checkout is no longer removed", async () => {
    const { desktopApi, dialog, section } = await openCheckouts(scanWith());
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Remove /w/old/ledger" }));
    const freed = within(section).getByRole("checkbox", { name: "Clean /w/old/ledger/target/debug" });
    expect(freed).not.toBeChecked();
    fireEvent.click(freed);
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove 1 and finish" }));
    await waitFor(() => expect(desktopApi.applyThreadMaintenance).toHaveBeenCalledOnce());
    const request = vi.mocked(desktopApi.applyThreadMaintenance!).mock.calls[0]![0];
    expect(request.removeCheckouts).toEqual([]);
    expect(request.removeBuildOutputs).toEqual([{ outputPath: "/w/old/ledger/target/debug" }]);
  });

  it("shows no build output section for an owner that sends none", async () => {
    const scan = scanWith({ buildOutputs: undefined });
    const desktopApi = api(scan);
    render(<ThreadMaintenanceDialog desktopApi={desktopApi} onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "Thread maintenance" });
    fireEvent.click(within(dialog).getByRole("radio", { name: "Archived checkouts" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Scan" }));
    await within(dialog).findByRole("button", { name: "Remove 1 and finish" });
    expect(within(dialog).queryByRole("region", { name: "Build output" })).toBeNull();
  });

  it("never offers output whose thread the scan did not identify, even from a restored selection", async () => {
    const { desktopApi, dialog, section } = await openCheckouts(scanWith());
    expect(section).not.toHaveTextContent("/w/stray/forge");
    expect(within(section).queryByRole("checkbox", { name: "Clean /w/stray/forge/target/release" })).toBeNull();
    expect(section).toHaveTextContent("1 more is not offered: thread not identified in this scan.");
    fireEvent.click(within(section).getByRole("checkbox", { name: "Select every build output" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove 3 and finish" }));
    await waitFor(() => expect(desktopApi.applyThreadMaintenance).toHaveBeenCalledOnce());
    const request = vi.mocked(desktopApi.applyThreadMaintenance!).mock.calls[0]![0];
    expect(request.removeBuildOutputs?.map((item) => item.outputPath)).not.toContain("/w/stray/forge/target/release");

    // A selection that still names it sends nothing for it.
    const scan = scanWith();
    const restored: ThreadMaintenanceSelection = {
      threads: new Set(), overLimit: new Map(), checkouts: new Set(), emptyFolders: false, hibernate: new Set(),
      buildOutputs: new Set(["/w/stray/forge/target/release"]),
    };
    expect(buildApplyRequest(scan, restored, "checkouts")).not.toHaveProperty("removeBuildOutputs");
  });

  it("opens the thread that uses an output", async () => {
    const { section, onOpenThread } = await openCheckouts(scanWith());
    fireEvent.click(within(section).getByRole("button", { name: "Open thread Speed up the indexer" }));
    expect(onOpenThread).toHaveBeenCalledWith({ backend: "codex", threadId: "t-grok" });
  });
});
