import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ThreadMaintenanceApplyRequest,
  ThreadMaintenanceRun,
  ThreadMaintenanceScan,
} from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { pressEscape, tabEscapes } from "../../../test/tab-walk";
import { ThreadMaintenanceDialog } from "../ThreadMaintenanceDialog";
import { buildApplyRequest, defaultSelection } from "../thread-maintenance-selection";

afterEach(() => {
  cleanup();
});

const NOW = new Date(2026, 10, 4, 11, 0).getTime();
/** Main's revision counter: each fixture snapshot is newer than the last. */
let revision = 0;
const REV = () => ++revision;
const DAY = 86_400_000;

function fixtureScan(): ThreadMaintenanceScan {
  return {
    scanId: "scan-1",
    startedAt: NOW,
    finishedAt: NOW + 41_000,
    rules: { mode: "count", keepPerProject: 20, inactivityDays: 7, rebuildableOutputIsClean: true },
    spaceSource: "none",
    threads: {
      checked: 12,
      kept: { "Within the per-project limit": 6, "Pinned thread": 2 },
      projects: [
        {
          key: "/src/harbor-web",
          label: "harbor-web",
          path: "/src/harbor-web",
          kept: { "Within the per-project limit": 6, "Pinned thread": 2 },
          idle: [
            {
              backend: "codex", threadId: "t-clean", title: "Rebuild checkout flow", branch: "feat/checkout",
              worktreePath: "/home/.pwragent/worktrees/k3m9/harbor-web", lastActivityAt: NOW - 26 * DAY, subThreads: 0,
              workspace: { kind: "clean", rebuildableOutput: ["node_modules"] },
            },
            {
              backend: "codex", threadId: "t-changes", title: "Fix tooltip flicker",
              lastActivityAt: NOW - 19 * DAY, subThreads: 1,
              workspace: { kind: "changes", files: 3, bytes: 2_400_000 },
            },
          ],
        },
        {
          key: "/src/ledger-api",
          label: "ledger-api",
          path: "/src/ledger-api",
          kept: {},
          idle: [
            {
              backend: "claude", threadId: "t-big", title: "Load test harness",
              lastActivityAt: NOW - 33 * DAY, subThreads: 0,
              workspace: {
                kind: "overLimit", files: 43, bytes: 1_900_000_000, limitBytes: 100 * 1024 * 1024,
                largest: [{ path: "fixtures/replay.ndjson", bytes: 1_700_000_000 }],
              },
            },
          ],
        },
      ],
    },
    checkouts: {
      items: [
        { backend: "codex", threadId: "a-1", title: "Stream progress", worktreePath: "/home/.pwragent/worktrees/q8d2/kiln-cli",
          kind: "removable", workspace: { kind: "clean" } },
        { backend: "codex", threadId: "a-2", worktreePath: "/home/.codex/worktrees/r4t7/kiln-sandbox",
          kind: "repositoryGone", missingRepositoryPath: "/private/tmp/kiln-sandbox" },
      ],
      kept: { "Used by an active thread": 3 },
      emptyFolders: 2,
    },
    expired: { enabled: false, retentionDays: 0 },
    failures: [],
  };
}

function fixtureApi(overrides: Partial<DesktopApi> = {}) {
  const runListeners = new Set<(run: ThreadMaintenanceRun) => void>();
  const scan = fixtureScan();
  const api = {
    scanThreadMaintenance: vi.fn(async () => scan),
    applyThreadMaintenance: vi.fn(async (request: ThreadMaintenanceApplyRequest): Promise<ThreadMaintenanceRun> => ({
      runId: "run-1", revision: REV(), scanId: request.scanId, running: true, startedAt: NOW, steps: [], problems: [],
      current: { step: "threads", processed: 0, total: request.archive.length },
    })),
    getThreadMaintenanceRun: vi.fn(async () => null),
    stopThreadMaintenance: vi.fn(async () => {}),
    onThreadMaintenanceRunChanged: vi.fn((callback: (run: ThreadMaintenanceRun) => void) => {
      runListeners.add(callback);
      return () => { runListeners.delete(callback); };
    }),
    ...overrides,
  } as unknown as DesktopApi;
  const emit = (run: ThreadMaintenanceRun) => { act(() => { for (const listener of runListeners) listener(run); }); };
  return { api, emit, scan };
}

async function openReview(api: DesktopApi, onOpenThread?: (thread: { backend: string; threadId: string }) => void) {
  const onClose = vi.fn();
  render(<ThreadMaintenanceDialog desktopApi={api} onClose={onClose} onOpenThread={onOpenThread} />);
  const dialog = screen.getByRole("dialog", { name: "Thread maintenance" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Scan" }));
  await screen.findByText("3 idle threads");
  return { dialog, onClose };
}

describe("ThreadMaintenanceDialog", () => {
  it("opens on the plan and changes nothing until Scan", () => {
    const { api } = fixtureApi();
    render(<ThreadMaintenanceDialog desktopApi={api} onClose={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Archive idle threads" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Remove archived checkouts" })).toBeInTheDocument();
    expect(screen.getByText("Never removed")).toBeInTheDocument();
    expect(api.scanThreadMaintenance).not.toHaveBeenCalled();
    expect(api.applyThreadMaintenance).not.toHaveBeenCalled();
  });

  it("scans with the plan's rules and reviews idle threads by project", async () => {
    const { api } = fixtureApi();
    const { dialog } = await openReview(api);
    expect(api.scanThreadMaintenance).toHaveBeenCalledWith({
      rules: { mode: "count", keepPerProject: 20, inactivityDays: 7, rebuildableOutputIsClean: true },
    });
    expect(within(dialog).getByRole("region", { name: "harbor-web" })).toBeInTheDocument();
    expect(within(dialog).getByText(/removes node_modules/)).toBeInTheDocument();
    expect(within(dialog).getByText("2 selected")).toBeInTheDocument();
    // No disk accounting provider: no size column.
    expect(dialog.querySelector(".thread-maintenance__size")).toBeNull();
  });

  it("selects everything except a thread over the snapshot limit", async () => {
    const { api } = fixtureApi();
    const { dialog } = await openReview(api);
    expect(within(dialog).getByRole("checkbox", { name: "Archive Rebuild checkout flow" })).toBeChecked();
    expect(within(dialog).getByRole("checkbox", { name: "Archive Fix tooltip flicker" })).toBeChecked();
    expect(within(dialog).getByRole("checkbox", { name: "Archive Load test harness" })).not.toBeChecked();
    expect(within(dialog).getByRole("radio", { name: "Keep thread" })).toHaveAttribute("aria-checked", "true");

    const selectAll = within(dialog).getByRole("checkbox", { name: "Select every idle thread that needs no decision" });
    fireEvent.click(selectAll);
    expect(within(dialog).getByText("0 selected")).toBeInTheDocument();
    fireEvent.click(selectAll);
    expect(within(dialog).getByRole("checkbox", { name: "Archive Load test harness" })).not.toBeChecked();
  });

  it("sends the over-limit choice and both steps' selections in one apply", async () => {
    const { api } = fixtureApi();
    const { dialog } = await openReview(api);
    fireEvent.click(within(dialog).getByRole("radio", { name: /Snapshot all/ }));
    expect(within(dialog).getByRole("checkbox", { name: "Archive Load test harness" })).toBeChecked();
    fireEvent.click(within(dialog).getByRole("button", { name: "Archive 3 and continue" }));

    // Step 2: the orphaned checkout starts unchecked.
    expect(await within(dialog).findByRole("checkbox", { name: "Remove /home/.pwragent/worktrees/q8d2/kiln-cli" })).toBeChecked();
    expect(within(dialog).getByRole("checkbox", { name: "Move /home/.codex/worktrees/r4t7/kiln-sandbox to the Trash" })).not.toBeChecked();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove 1 and finish" }));

    await waitFor(() => expect(api.applyThreadMaintenance).toHaveBeenCalledOnce());
    expect(api.applyThreadMaintenance).toHaveBeenCalledWith({
      scanId: "scan-1",
      archive: [
        { backend: "codex", threadId: "t-clean" },
        { backend: "codex", threadId: "t-changes" },
        { backend: "claude", threadId: "t-big", overLimit: "snapshotAll" },
      ],
      removeCheckouts: [{ backend: "codex", threadId: "a-1", worktreePath: "/home/.pwragent/worktrees/q8d2/kiln-cli" }],
      trashCheckouts: [],
      removeUnreferenced: [],
      removeEmptyFolders: true,
    });
  });

  it("can be closed while a run keeps going, and Stop reads main's run back", async () => {
    const finished: ThreadMaintenanceRun = { runId: "run-1", revision: 0, scanId: "scan-1", running: false,
      startedAt: NOW, finishedAt: NOW + 1_000, steps: [{ step: "threads", ran: true, done: 2, kept: 0, failed: 0 }], problems: [] };
    const { api, emit } = fixtureApi({
      getThreadMaintenanceRun: vi.fn(async () => ({ ...finished, revision: 10_000 })),
    } as Partial<DesktopApi>);
    const { dialog, onClose } = await openReview(api);
    fireEvent.click(within(dialog).getByRole("button", { name: "Archive 2 and continue" }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "Remove 1 and finish" }));
    await within(dialog).findByRole("button", { name: "Stop after this item" });
    emit({ runId: "run-1", revision: REV(), scanId: "scan-1", running: true, startedAt: NOW, steps: [], problems: [],
      current: { step: "threads", processed: 1, total: 2, object: "Fix tooltip flicker" } });

    const close = within(dialog).getByRole("button", { name: "Close thread maintenance" });
    expect(close).toBeEnabled();
    pressEscape();
    expect(onClose).toHaveBeenCalledOnce();

    // The run's last event never arrived; Stop reads the finished run back.
    fireEvent.click(within(dialog).getByRole("button", { name: "Stop after this item" }));
    expect(api.stopThreadMaintenance).toHaveBeenCalledOnce();
    expect(await within(dialog).findByText("Maintenance finished")).toBeInTheDocument();
  });

  it("finishes when a run with nothing to do ends before its apply reply arrives", async () => {
    let emitRun: (run: ThreadMaintenanceRun) => void = () => {};
    const { api, emit } = fixtureApi({
      // Main publishes the finished run as an event, then the apply reply
      // carries the first, still-running snapshot.
      applyThreadMaintenance: vi.fn(async (request: ThreadMaintenanceApplyRequest): Promise<ThreadMaintenanceRun> => {
        const started = { runId: "run-1", revision: REV(), scanId: request.scanId, running: true, startedAt: NOW,
          steps: [], problems: [] };
        emitRun({ ...started, revision: REV(), running: false, finishedAt: NOW + 5,
          steps: [{ step: "checkouts", ran: true, done: 0, kept: 0, failed: 0 }] });
        return started;
      }),
    } as Partial<DesktopApi>);
    emitRun = emit;
    const { dialog } = await openReview(api);
    fireEvent.click(within(dialog).getByRole("button", { name: "Archive 2 and continue" }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "Remove 1 and finish" }));
    expect(await within(dialog).findByText("Maintenance finished")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Stop after this item" })).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("closes on a click outside the dialog", () => {
    const { api } = fixtureApi();
    const onClose = vi.fn();
    render(<ThreadMaintenanceDialog desktopApi={api} onClose={onClose} />);
    const dialog = screen.getByRole("dialog", { name: "Thread maintenance" });
    fireEvent.mouseDown(dialog);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(dialog.parentElement!);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("finishes with a red card for failures and a blue card for what was kept", async () => {
    const { api, emit } = fixtureApi();
    const { dialog } = await openReview(api);
    fireEvent.click(within(dialog).getByRole("button", { name: "Archive 2 and continue" }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "Remove 1 and finish" }));
    await within(dialog).findByRole("button", { name: "Stop after this item" });
    emit({
      runId: "run-1", revision: REV(), scanId: "scan-1", running: false, startedAt: NOW, finishedAt: NOW + 72_000,
      steps: [
        { step: "threads", ran: true, done: 1, kept: 0, failed: 1 },
        { step: "checkouts", ran: true, done: 3, kept: 1, failed: 0 },
        { step: "expired", ran: false, done: 0, kept: 0, failed: 0 },
      ],
      problems: [
        { step: "threads", kind: "failed", object: "Fix tooltip flicker", reason: "Archive failed", detail: "Codex did not answer." },
        { step: "checkouts", kind: "kept", object: "/home/.codex/worktrees/r4t7/kiln-sandbox", reason: "Repository no longer exists" },
      ],
    });

    expect(await within(dialog).findByText("Maintenance finished with 1 problem")).toBeInTheDocument();
    const failed = within(dialog).getByRole("region", { name: "1 thread wasn't archived" });
    expect(failed).toHaveClass("is-failed");
    expect(within(failed).getByText("Codex did not answer.", { exact: false })).toBeInTheDocument();
    const kept = within(dialog).getByRole("region", { name: "1 checkout kept" });
    expect(kept).toHaveClass("is-kept");
    expect(within(dialog).getByRole("button", { name: "New scan" })).toBeInTheDocument();
  });

  it("links each outcome row that names a thread, once the run has finished", async () => {
    const { api, emit } = fixtureApi();
    const onOpenThread = vi.fn();
    const { dialog } = await openReview(api, onOpenThread);
    fireEvent.click(within(dialog).getByRole("button", { name: "Archive 2 and continue" }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "Remove 1 and finish" }));
    await within(dialog).findByRole("button", { name: "Stop after this item" });
    const problems: ThreadMaintenanceRun["problems"] = [
      { step: "threads", kind: "kept", object: "Fix tooltip flicker", reason: "New activity during the run",
        backend: "codex", threadId: "t-changes" },
      { step: "checkouts", kind: "kept", object: "/home/.codex/worktrees/r4t7/kiln-sandbox", reason: "Repository no longer exists" },
    ];
    emit({ runId: "run-1", revision: REV(), scanId: "scan-1", running: true, startedAt: NOW, steps: [], problems,
      current: { step: "checkouts", processed: 0, total: 1 } });
    expect(within(dialog).queryByRole("button", { name: /^Open thread/ })).toBeNull();

    emit({ runId: "run-1", revision: REV(), scanId: "scan-1", running: false, startedAt: NOW, finishedAt: NOW + 9_000, problems,
      steps: [{ step: "threads", ran: true, done: 1, kept: 1, failed: 0 }] });
    const links = await within(dialog).findAllByRole("button", { name: /^Open thread/ });
    expect(links.map((link) => link.getAttribute("aria-label"))).toEqual(["Open thread Fix tooltip flicker"]);
    fireEvent.click(links[0]!);
    expect(onOpenThread).toHaveBeenCalledWith({ backend: "codex", threadId: "t-changes" });
  });

  it("shows checkouts no thread refers to as their own unselected group", async () => {
    const scan = fixtureScan();
    scan.checkouts.items.push({ kind: "unreferenced", worktreePath: "/home/.pwragent/worktrees/z9/kiln-old",
      workspace: { kind: "changes", files: 2, bytes: 4_000 } });
    const { api } = fixtureApi({ scanThreadMaintenance: vi.fn(async () => scan) } as Partial<DesktopApi>);
    render(<ThreadMaintenanceDialog desktopApi={api} onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "Thread maintenance" });
    fireEvent.click(within(dialog).getByRole("radio", { name: "Archived checkouts" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Scan" }));
    const group = await within(dialog).findByRole("region", { name: "No thread" });
    const checkbox = within(group).getByRole("checkbox", { name: "Remove /home/.pwragent/worktrees/z9/kiln-old" });
    expect(checkbox).not.toBeChecked();
    fireEvent.click(checkbox);
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove 2 and finish" }));
    await waitFor(() => expect(api.applyThreadMaintenance).toHaveBeenCalledOnce());
    expect(vi.mocked(api.applyThreadMaintenance!).mock.calls[0]![0].removeUnreferenced)
      .toEqual([{ worktreePath: "/home/.pwragent/worktrees/z9/kiln-old" }]);
  });

  it("runs only the archived checkouts step from its tab", async () => {
    const { api } = fixtureApi();
    render(<ThreadMaintenanceDialog desktopApi={api} onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "Thread maintenance" });
    fireEvent.click(within(dialog).getByRole("radio", { name: "Archived checkouts" }));
    expect(within(dialog).queryByRole("heading", { name: "Archive idle threads" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Scan" }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "Remove 1 and finish" }));
    await waitFor(() => expect(api.applyThreadMaintenance).toHaveBeenCalledOnce());
    expect(vi.mocked(api.applyThreadMaintenance!).mock.calls[0]![0].archive).toEqual([]);
  });

  it("shows a run another surface started", async () => {
    const { api } = fixtureApi({
      getThreadMaintenanceRun: vi.fn(async (): Promise<ThreadMaintenanceRun> => ({
        runId: "agent-run", revision: REV(), scanId: "scan-9", running: true, startedAt: NOW, steps: [], problems: [],
        current: { step: "checkouts", processed: 1, total: 4, object: "/home/.pwragent/worktrees/x/y" },
      })),
    } as Partial<DesktopApi>);
    render(<ThreadMaintenanceDialog desktopApi={api} onClose={vi.fn()} />);
    expect(await screen.findByText("Removing archived checkouts")).toBeInTheDocument();
  });

  it("keeps Tab inside the dialog", () => {
    const { api } = fixtureApi();
    render(<ThreadMaintenanceDialog desktopApi={api} onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "Thread maintenance" });
    expect(tabEscapes(dialog)).toEqual({ forward: [], backward: [] });
  });

  it("closes on Escape when idle", () => {
    const { api } = fixtureApi();
    const onClose = vi.fn();
    render(<ThreadMaintenanceDialog desktopApi={api} onClose={onClose} />);
    pressEscape();
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("thread maintenance selection", () => {
  it("never selects an over-limit thread or an orphaned checkout by default", () => {
    const scan = fixtureScan();
    const request = buildApplyRequest(scan, defaultSelection(scan), "combined");
    expect(request.archive.map((item) => item.threadId)).toEqual(["t-clean", "t-changes"]);
    expect(request.trashCheckouts).toEqual([]);
    expect(request.removeCheckouts).toHaveLength(1);
  });

  it("never selects a checkout no thread refers to until the operator does", () => {
    const scan = fixtureScan();
    scan.checkouts.items.push({ kind: "unreferenced", worktreePath: "/home/.pwragent/worktrees/z9/kiln-old", workspace: { kind: "clean" } });
    const selection = defaultSelection(scan);
    expect(buildApplyRequest(scan, selection, "combined").removeUnreferenced).toEqual([]);
    selection.checkouts.add("/home/.pwragent/worktrees/z9/kiln-old");
    const request = buildApplyRequest(scan, selection, "checkouts");
    expect(request.removeUnreferenced).toEqual([{ worktreePath: "/home/.pwragent/worktrees/z9/kiln-old" }]);
    expect(request.removeCheckouts.map((item) => item.worktreePath)).not.toContain("/home/.pwragent/worktrees/z9/kiln-old");
    expect(buildApplyRequest(scan, selection, "threads").removeUnreferenced).toEqual([]);
  });

  it("sends no checkout work from the idle threads tab", () => {
    const scan = fixtureScan();
    const request = buildApplyRequest(scan, defaultSelection(scan), "threads");
    expect(request.removeCheckouts).toEqual([]);
    expect(request.removeEmptyFolders).toBe(false);
  });
});
