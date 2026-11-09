import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import type {
  ThreadMaintenanceApplyRequest,
  ThreadMaintenanceRun,
  ThreadMaintenanceScan,
  ThreadMaintenanceScanProgress,
  ThreadMaintenanceScanStep,
} from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { pressEscape, tabEscapes } from "../../../test/tab-walk";
import { ThreadMaintenanceDialog } from "../ThreadMaintenanceDialog";
import { buildApplyRequest, defaultSelection, runSteps } from "../thread-maintenance-selection";

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
    hibernate: {
      idleDays: 7,
      maxSnapshotMb: 25,
      removeRebuildableOutput: true,
      checked: 9,
      items: [
        { backend: "codex", threadId: "h-changes", title: "Price the cart drawer", branch: "feat/cart-drawer",
          worktreePath: "/home/.pwragent/worktrees/m2p4/harbor-web", lastActivityAt: NOW - 9 * DAY,
          files: 3, bytes: 41 * 1024, removedOutput: ["node_modules", "packages/web/node_modules"] },
        { backend: "codex", threadId: "h-clean", title: "Stream progress to the TTY", branch: "feat/tty-progress",
          worktreePath: "/home/.pwragent/worktrees/w7c1/kiln-cli", lastActivityAt: NOW - 12 * DAY,
          files: 0, bytes: 0, removedOutput: ["target"] },
      ],
      notIdleYet: 3,
      alreadyHibernated: 5,
      kept: { "Other ignored files": 2, "Rebase in progress": 1, "Changes over the snapshot limit": 1 },
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

/** From the idle threads review through the idle checkouts review. */
async function continueToCheckouts(dialog: HTMLElement, archive: string) {
  fireEvent.click(within(dialog).getByRole("button", { name: archive }));
  fireEvent.click(await within(dialog).findByRole("button", { name: "Hibernate 2 and continue" }));
}

/** Combined with every step ticked, from the plan to the idle threads review. */
async function openReview(api: DesktopApi, onOpenThread?: (thread: { backend: string; threadId: string }) => void) {
  const onClose = vi.fn();
  render(<ThreadMaintenanceDialog desktopApi={api} onClose={onClose} onOpenThread={onOpenThread} />);
  const dialog = screen.getByRole("dialog", { name: "Thread maintenance" });
  fireEvent.click(within(dialog).getByRole("checkbox", { name: "Archive idle threads" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "Scan" }));
  await screen.findByText("3 idle threads");
  return { dialog, onClose };
}

describe("ThreadMaintenanceDialog", () => {
  it("opens on the plan and changes nothing until Scan", () => {
    const { api } = fixtureApi();
    render(<ThreadMaintenanceDialog desktopApi={api} onClose={vi.fn()} hibernationPolicy={{
      enabled: false, idleDays: 5, maxSnapshotMb: 25, removeRebuildableOutput: true, restoreOn: "send" }} />);
    // Archive, then hibernate, then archived checkouts, then expired archives.
    const steps = screen.getAllByRole("region").map((step) => [
      step.querySelector(".thread-maintenance__num")?.textContent, step.getAttribute("aria-label")]);
    expect(steps).toEqual([
      ["1", "Archive idle threads"],
      ["2", "Hibernate idle checkouts"],
      ["3", "Remove archived checkouts"],
      ["4", "Delete expired archives"],
    ]);
    // Archiving is the operator's choice: it starts unticked.
    expect(screen.getByRole("checkbox", { name: "Archive idle threads" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Hibernate idle checkouts" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Remove archived checkouts" })).toBeChecked();
    expect(screen.getByText(/^Threads idle 5 days\. Tracked and non-ignored changes are saved/)).toBeInTheDocument();
    expect(screen.getByText("Stops twice for you")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Archive idle threads" }));
    expect(screen.getByText(/^Threads idle 5 days that aren't being archived\./)).toBeInTheDocument();
    expect(screen.getByText("Stops three times for you")).toBeInTheDocument();
    expect(screen.getByText("Never removed")).toBeInTheDocument();
    expect(api.scanThreadMaintenance).not.toHaveBeenCalled();
    expect(api.applyThreadMaintenance).not.toHaveBeenCalled();
  });

  it("scans with the plan's rules and reviews idle threads by project", async () => {
    const { api } = fixtureApi();
    const { dialog } = await openReview(api);
    expect(api.scanThreadMaintenance).toHaveBeenCalledWith({
      rules: { mode: "count", keepPerProject: 20, inactivityDays: 7, rebuildableOutputIsClean: true },
      steps: ["threads", "hibernate", "checkouts"],
      hibernateIdleDays: 7,
      progressId: expect.any(String),
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
    await continueToCheckouts(dialog, "Archive 3 and continue");

    // Step 3: the orphaned checkout starts unchecked.
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
      removeEmptyFolders: true,
      hibernate: [{ backend: "codex", threadId: "h-changes" }, { backend: "codex", threadId: "h-clean" }],
    });
  });

  it("can be closed while a run keeps going, and Stop reads main's run back", async () => {
    const finished: ThreadMaintenanceRun = { runId: "run-1", revision: 0, scanId: "scan-1", running: false,
      startedAt: NOW, finishedAt: NOW + 1_000, steps: [{ step: "threads", ran: true, done: 2, kept: 0, failed: 0 }], problems: [] };
    const { api, emit } = fixtureApi({
      getThreadMaintenanceRun: vi.fn(async () => ({ ...finished, revision: 10_000 })),
    } as Partial<DesktopApi>);
    const { dialog, onClose } = await openReview(api);
    await continueToCheckouts(dialog, "Archive 2 and continue");
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
    await continueToCheckouts(dialog, "Archive 2 and continue");
    fireEvent.click(await within(dialog).findByRole("button", { name: "Remove 1 and finish" }));
    expect(await within(dialog).findByText("Maintenance finished")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Stop after this item" })).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("never archives from Combined unless the operator ticks it", async () => {
    const { api } = fixtureApi();
    render(<ThreadMaintenanceDialog desktopApi={api} onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "Thread maintenance" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Scan" }));
    // The scan reads only the ticked steps, and the first review is hibernate.
    expect(await within(dialog).findByText("2 idle checkouts can hibernate")).toBeInTheDocument();
    expect(vi.mocked(api.scanThreadMaintenance!).mock.calls[0]![0]!.steps).toEqual(["hibernate", "checkouts"]);
    const rail = within(dialog).getByRole("list", { name: "Steps" });
    expect(within(rail).getAllByRole("listitem").map((step) => step.querySelector(".thread-maintenance__rail-title")?.textContent))
      .toEqual(["Idle checkouts", "Archived checkouts"]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Hibernate 2 and continue" }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "Remove 1 and finish" }));
    await waitFor(() => expect(api.applyThreadMaintenance).toHaveBeenCalledOnce());
    expect(vi.mocked(api.applyThreadMaintenance!).mock.calls[0]![0].archive).toEqual([]);
  });

  it("scans idle checkouts with the plan's idle days and says where every thread went", async () => {
    const { api } = fixtureApi();
    render(<ThreadMaintenanceDialog desktopApi={api} onClose={vi.fn()} hibernationPolicy={{
      enabled: true, idleDays: 7, maxSnapshotMb: 25, removeRebuildableOutput: true, restoreOn: "send" }} />);
    const dialog = screen.getByRole("dialog", { name: "Thread maintenance" });
    const days = within(dialog).getByRole("spinbutton", { name: "Days idle before a checkout can hibernate" });
    expect(days).toHaveValue(7);
    expect(within(dialog).getByText(/The hourly sweep uses 7 days, set in Settings → Worktrees\./)).toBeInTheDocument();
    fireEvent.change(days, { target: { value: "3" } });
    expect(within(dialog).getByText(/^Threads idle 3 days\. Tracked and non-ignored changes are saved/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Scan" }));
    expect(vi.mocked(api.scanThreadMaintenance!).mock.calls[0]![0]).toMatchObject({ steps: ["hibernate", "checkouts"], hibernateIdleDays: 3 });

    await within(dialog).findByText("2 idle checkouts can hibernate");
    expect(within(dialog).getByText("9 checkouts on disk checked", { exact: false })).toBeInTheDocument();
    const counts = dialog.querySelector(".thread-maintenance__dispositions")!;
    const cells = [...counts.children].map((cell) => [...cell.children].map((part) => part.textContent));
    expect(cells).toEqual([
      ["Can hibernate", "2"],
      ["Not idle yet", "3", "active in the last 7 days"],
      ["Kept", "4", "reasons below"],
      ["Already hibernated", "5", "not counted above"],
    ]);
  });

  it("follows Settings' idle days until the field is edited, even when Settings load after open", async () => {
    const { api } = fixtureApi();
    const policy = (idleDays: number) => ({ enabled: true, idleDays, maxSnapshotMb: 25, removeRebuildableOutput: true, restoreOn: "send" as const });
    const { rerender } = render(<ThreadMaintenanceDialog desktopApi={api} onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "Thread maintenance" });
    const days = within(dialog).getByRole("spinbutton", { name: "Days idle before a checkout can hibernate" });
    rerender(<ThreadMaintenanceDialog desktopApi={api} onClose={vi.fn()} hibernationPolicy={policy(14)} />);
    expect(days).toHaveValue(14);
    fireEvent.change(days, { target: { value: "3" } });
    rerender(<ThreadMaintenanceDialog desktopApi={api} onClose={vi.fn()} hibernationPolicy={policy(21)} />);
    expect(days).toHaveValue(3);
    fireEvent.click(within(dialog).getByRole("button", { name: "Scan" }));
    expect(vi.mocked(api.scanThreadMaintenance!).mock.calls[0]![0]).toMatchObject({ hibernateIdleDays: 3 });
    await within(dialog).findByText("2 idle checkouts can hibernate");
  });

  it("words a run's footnote by the steps it runs, not the dialog's plan", async () => {
    const { api } = fixtureApi({
      getThreadMaintenanceRun: vi.fn(async (): Promise<ThreadMaintenanceRun> => ({
        runId: "agent-run", revision: REV(), scanId: "scan-9", running: true, startedAt: NOW, steps: [], problems: [],
        current: { step: "hibernate", processed: 1, total: 2, object: "/home/.pwragent/worktrees/x/y" },
      })),
    } as Partial<DesktopApi>);
    render(<ThreadMaintenanceDialog desktopApi={api} onClose={vi.fn()} />);
    expect(await screen.findByText("Each checkout comes back when its thread gets a message")).toBeInTheDocument();
  });

  it("never sends idle days for a scan without the idle checkouts step", async () => {
    const { api } = fixtureApi();
    render(<ThreadMaintenanceDialog desktopApi={api} onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "Thread maintenance" });
    fireEvent.click(within(dialog).getByRole("radio", { name: "Archived checkouts" }));
    expect(within(dialog).queryByRole("spinbutton", { name: "Days idle before a checkout can hibernate" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Scan" }));
    expect(vi.mocked(api.scanThreadMaintenance!).mock.calls[0]![0]).not.toHaveProperty("hibernateIdleDays");
    await within(dialog).findByRole("button", { name: "Remove 1 and finish" });
  });

  it("cannot scan with every step unticked", () => {
    const { api } = fixtureApi();
    render(<ThreadMaintenanceDialog desktopApi={api} onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "Thread maintenance" });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Hibernate idle checkouts" }));
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Remove archived checkouts" }));
    expect(within(dialog).getByText("Tick a step to run")).toBeInTheDocument();
    const scan = within(dialog).getByRole("button", { name: "Scan" });
    expect(scan).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(scan);
    expect(api.scanThreadMaintenance).not.toHaveBeenCalled();
  });

  it("shows what the scan is reading as it goes, and ignores another scan's progress", async () => {
    const progressListeners = new Set<(progress: ThreadMaintenanceScanProgress) => void>();
    let finishScan: (scan: ThreadMaintenanceScan) => void = () => {};
    const { api, scan } = fixtureApi({
      scanThreadMaintenance: vi.fn(() => new Promise<ThreadMaintenanceScan>((resolve) => { finishScan = resolve; })),
      onThreadMaintenanceScanProgress: vi.fn((callback: (progress: ThreadMaintenanceScanProgress) => void) => {
        progressListeners.add(callback);
        return () => { progressListeners.delete(callback); };
      }),
    } as Partial<DesktopApi>);
    render(<ThreadMaintenanceDialog desktopApi={api} onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "Thread maintenance" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Scan" }));
    expect(within(dialog).getByRole("button", { name: "Scanning…" })).toHaveAttribute("aria-disabled", "true");
    expect(within(dialog).getByRole("status")).toHaveTextContent("Starting the scan…");
    const progressId = vi.mocked(api.scanThreadMaintenance!).mock.calls[0]![0]!.progressId!;
    const emit = (progress: Omit<ThreadMaintenanceScanProgress, "progressId" | "steps">, id = progressId) => {
      act(() => { for (const listener of progressListeners) listener({ ...progress, progressId: id, steps: ["hibernate", "checkouts"] }); });
    };

    emit({ step: "hibernate", stage: "listing", processed: 0, total: 0, inFlight: [] });
    expect(within(dialog).getByRole("status")).toHaveTextContent("Reading threads…");
    emit({ step: "hibernate", stage: "checking", processed: 16, total: 141,
      inFlight: ["Price the cart drawer", "Stream progress to the TTY"] });
    expect(within(dialog).getByRole("status")).toHaveTextContent("Measuring idle checkouts");
    expect(within(dialog).getByText("16 of 141")).toBeInTheDocument();
    expect(within(dialog).getByText("16 / 141")).toBeInTheDocument();
    expect(within(dialog).getByText("now: Price the cart drawer · Stream progress to the TTY")).toBeInTheDocument();
    expect(within(dialog).getByRole("listitem", { current: "step" })).toHaveTextContent("Idle checkoutsscanning 16 of 141");

    // Another window's (or an earlier) scan never moves this card.
    emit({ step: "checkouts", stage: "checking", processed: 3, total: 9, inFlight: [] }, "someone-else");
    expect(within(dialog).getByText("16 of 141")).toBeInTheDocument();

    emit({ step: "checkouts", stage: "checking", processed: 2, total: 10, inFlight: ["/home/.pwragent/worktrees/q8d2/kiln-cli"] });
    expect(within(dialog).getByRole("status")).toHaveTextContent("Checking archived checkouts");
    const rail = within(within(dialog).getByRole("list", { name: "Steps" })).getAllByRole("listitem");
    expect(rail[0]).toHaveTextContent("scanned");
    expect(rail[1]).toHaveAttribute("aria-current", "step");

    await act(async () => { finishScan(scan); });
    expect(await within(dialog).findByText("2 idle checkouts can hibernate")).toBeInTheDocument();
    expect(within(dialog).queryByRole("status")).toBeNull();
  });

  it("keeps the plan's tabs, heading and footer in place through scan and review", async () => {
    const { api } = fixtureApi();
    render(<ThreadMaintenanceDialog desktopApi={api} onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "Thread maintenance" });
    // The pieces outside the scrolling body are the same elements throughout.
    const frame = () => [...dialog.children].map((child) => child.className);
    const planFrame = frame();
    expect(planFrame).toEqual(["thread-maintenance__head", "thread-maintenance__tabs", "thread-maintenance__body", "thread-maintenance__foot"]);
    const description = within(dialog).getByText(/^Find idle threads/);
    fireEvent.click(within(dialog).getByRole("button", { name: "Scan" }));
    expect(frame()).toEqual(planFrame);
    await within(dialog).findByText("2 idle checkouts can hibernate");
    expect(frame()).toEqual(planFrame);
    fireEvent.click(within(dialog).getByRole("button", { name: "Hibernate 2 and continue" }));
    await within(dialog).findByRole("button", { name: "Remove 1 and finish" });
    expect(frame()).toEqual(planFrame);
    expect(description).toBeInTheDocument();
  });

  const backdropPhases = ["plan", "scanning", "threads", "hibernate", "checkouts", "running", "finished"] as const;
  it.each(backdropPhases)("ignores backdrop interactions during %s", async (phase) => {
    let finishScan!: (scan: ThreadMaintenanceScan) => void;
    const { api, emit, scan } = fixtureApi({
      scanThreadMaintenance: vi.fn(() => new Promise<ThreadMaintenanceScan>((resolve) => { finishScan = resolve; })),
    } as Partial<DesktopApi>);
    const onClose = vi.fn();
    render(<ThreadMaintenanceDialog desktopApi={api} onClose={onClose} />);
    const dialog = screen.getByRole("dialog", { name: "Thread maintenance" });
    const phaseIndex = backdropPhases.indexOf(phase);
    if (phaseIndex >= 1) {
      fireEvent.click(within(dialog).getByRole("checkbox", { name: "Archive idle threads" }));
      fireEvent.click(within(dialog).getByRole("button", { name: "Scan" }));
    }
    if (phaseIndex >= 2) {
      await act(async () => { finishScan(scan); });
      await within(dialog).findByText("3 idle threads");
    }
    if (phaseIndex >= 3) fireEvent.click(within(dialog).getByRole("button", { name: "Archive 2 and continue" }));
    if (phaseIndex >= 4) fireEvent.click(within(dialog).getByRole("button", { name: "Hibernate 2 and continue" }));
    if (phaseIndex >= 5) {
      fireEvent.click(within(dialog).getByRole("button", { name: "Remove 1 and finish" }));
      await within(dialog).findByRole("button", { name: "Stop after this item" });
    }
    if (phaseIndex >= 6) {
      emit({ runId: "run-1", revision: REV(), scanId: scan.scanId, running: false,
        startedAt: NOW, finishedAt: NOW + 1_000, steps: [], problems: [] });
    }
    const scanCalls = vi.mocked(api.scanThreadMaintenance!).mock.calls.length;
    const applyCalls = vi.mocked(api.applyThreadMaintenance!).mock.calls.length;
    // Model: backdrop and drag gestures are identity transitions in every
    // workflow phase. Only an explicit close or stop changes that intent.
    fc.assert(fc.property(fc.array(fc.constantFrom("backdrop", "drag-out", "drag-in"), { maxLength: 8 }), (gestures) => {
      const backdrop = dialog.parentElement!;
      for (const gesture of ["backdrop", ...gestures]) {
        fireEvent.mouseDown(gesture === "drag-out" ? dialog : backdrop);
        fireEvent.mouseUp(gesture === "drag-in" ? dialog : backdrop);
        fireEvent.click(gesture === "drag-in" ? dialog : backdrop);
      }
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByRole("dialog", { name: "Thread maintenance" })).toBe(dialog);
      expect(api.stopThreadMaintenance).not.toHaveBeenCalled();
      expect(api.scanThreadMaintenance).toHaveBeenCalledTimes(scanCalls);
      expect(api.applyThreadMaintenance).toHaveBeenCalledTimes(applyCalls);
    }), { numRuns: 10 });
    if (phase === "scanning") {
      await act(async () => { finishScan(scan); });
      expect(await within(dialog).findByText("3 idle threads")).toBeInTheDocument();
    } else if (phase === "running") {
      emit({ runId: "run-1", revision: REV(), scanId: scan.scanId, running: false,
        startedAt: NOW, finishedAt: NOW + 1_000, steps: [], problems: [] });
      expect(within(dialog).getByText("Maintenance finished")).toBeInTheDocument();
    }
    fireEvent.click(within(dialog).getByRole("button", { name: "Close thread maintenance" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(api.stopThreadMaintenance).not.toHaveBeenCalled();
  });

  it("finishes with a red card for failures and a blue card for what was kept", async () => {
    const { api, emit } = fixtureApi();
    const { dialog } = await openReview(api);
    await continueToCheckouts(dialog, "Archive 2 and continue");
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
    await continueToCheckouts(dialog, "Archive 2 and continue");
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

  it("never offers a checkout no thread refers to, even from an older owner's scan", async () => {
    const scan = fixtureScan();
    scan.checkouts.items.push({ kind: "unreferenced", worktreePath: "/home/.pwragent/worktrees/z9/kiln-old",
      workspace: { kind: "changes", files: 2, bytes: 4_000 }, space: { allocatedBytes: 40 * 1024 ** 3 } });
    const { api } = fixtureApi({ scanThreadMaintenance: vi.fn(async () => scan) } as Partial<DesktopApi>);
    render(<ThreadMaintenanceDialog desktopApi={api} onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "Thread maintenance" });
    fireEvent.click(within(dialog).getByRole("radio", { name: "Archived checkouts" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Scan" }));
    await within(dialog).findByRole("button", { name: "Remove 1 and finish" });
    expect(within(dialog).queryByRole("region", { name: "No thread" })).toBeNull();
    expect(dialog).not.toHaveTextContent("/home/.pwragent/worktrees/z9/kiln-old");
    expect(dialog).not.toHaveTextContent(/no thread/i);
    expect(within(dialog).queryByRole("checkbox", { name: /kiln-old/ })).toBeNull();
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

  it("reviews idle checkouts between the two archive steps", async () => {
    const { api } = fixtureApi();
    const { dialog } = await openReview(api);
    fireEvent.click(within(dialog).getByRole("button", { name: "Archive 2 and continue" }));
    expect(await within(dialog).findByText("2 idle checkouts can hibernate")).toBeInTheDocument();
    expect(within(dialog).getByRole("listitem", { current: "step" })).toHaveTextContent("Idle checkouts");
    const group = within(dialog).getByRole("region", { name: "Can hibernate" });
    expect(within(group).getByText("Can hibernate · 2")).toBeInTheDocument();
    const rows = within(group).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("3 changed files · 41 KB snapshot · node_modules · idle 9 days");
    expect(within(rows[0]!).getByText("3 changed files")).toHaveClass("is-warn");
    expect(rows[1]).toHaveTextContent("Clean · target · idle 12 days");
    expect(within(rows[1]!).getByText("Clean")).toHaveClass("is-ok");
    expect(within(dialog).getByText("2 selected")).toBeInTheDocument();
    expect(within(dialog).getByText(/then archived checkouts/)).toBeInTheDocument();

    // The kept reasons fold behind Show.
    expect(within(dialog).queryByText("Rebase in progress")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Show" }));
    expect(within(dialog).getByText("Rebase in progress")).toBeInTheDocument();
    expect(within(dialog).getByText("Kept 4", { exact: false })).toBeInTheDocument();
  });

  it("drops only the skipped step's choices when idle checkouts are skipped", async () => {
    const { api } = fixtureApi();
    const { dialog } = await openReview(api);
    fireEvent.click(within(dialog).getByRole("button", { name: "Archive 2 and continue" }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "Skip idle checkouts" }));
    expect(await within(dialog).findByText("2 threads to archive first", { exact: false })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove 1 and finish" }));
    await waitFor(() => expect(api.applyThreadMaintenance).toHaveBeenCalledOnce());
    const request = vi.mocked(api.applyThreadMaintenance!).mock.calls[0]![0];
    expect(request.hibernate).toEqual([]);
    expect(request.archive).toHaveLength(2);
  });

  it("runs only the idle checkouts step from its tab", async () => {
    const { api } = fixtureApi();
    const onClose = vi.fn();
    render(<ThreadMaintenanceDialog desktopApi={api} onClose={onClose} />);
    const dialog = screen.getByRole("dialog", { name: "Thread maintenance" });
    fireEvent.click(within(dialog).getByRole("radio", { name: "Idle checkouts" }));
    expect(within(dialog).queryByRole("heading", { name: "Archive idle threads" })).toBeNull();
    expect(within(dialog).getByText(/^Threads idle 7 days\. Tracked and non-ignored changes are saved/)).toBeInTheDocument();
    expect(within(dialog).getByText("Stops once for you")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Scan" }));
    fireEvent.click(await within(dialog).findByRole("checkbox", { name: "Hibernate Stream progress to the TTY" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Hibernate 1 checkout" }));
    await waitFor(() => expect(api.applyThreadMaintenance).toHaveBeenCalledOnce());
    expect(vi.mocked(api.applyThreadMaintenance!).mock.calls[0]![0]).toEqual({
      scanId: "scan-1", archive: [], removeCheckouts: [], trashCheckouts: [],
      removeEmptyFolders: false, hibernate: [{ backend: "codex", threadId: "h-changes" }],
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes from the idle checkouts tab without a run", async () => {
    const { api } = fixtureApi();
    const onClose = vi.fn();
    render(<ThreadMaintenanceDialog desktopApi={api} onClose={onClose} />);
    const dialog = screen.getByRole("dialog", { name: "Thread maintenance" });
    fireEvent.click(within(dialog).getByRole("radio", { name: "Idle checkouts" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Scan" }));
    await within(dialog).findByText("2 idle checkouts can hibernate");
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Select every idle checkout" }));
    expect(within(dialog).getByRole("button", { name: "Hibernate 0 checkouts" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(api.applyThreadMaintenance).not.toHaveBeenCalled();
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

  // Property: a checkout no thread refers to never becomes a removal
  // request, whatever the selection holds, including one restored from an
  // older scan that still names its path.
  it("never sends a removal for a checkout no thread refers to", () => {
    const scan = fixtureScan();
    const orphans = ["/home/.pwragent/worktrees/z9/kiln-old", "/home/.codex/worktrees/y1/harbor-web"];
    for (const worktreePath of orphans) {
      scan.checkouts.items.push({ kind: "unreferenced", worktreePath, workspace: { kind: "clean" } });
    }
    const paths = scan.checkouts.items.map((item) => item.worktreePath);
    const modes = ["combined", "threads", "hibernate", "checkouts"] as const;
    fc.assert(fc.property(fc.constantFrom(...modes), fc.subarray(paths), fc.boolean(), (mode, chosen, emptyFolders) => {
      const selection = { ...defaultSelection(scan), checkouts: new Set(chosen), emptyFolders };
      const request = buildApplyRequest(scan, selection, mode);
      expect(request).not.toHaveProperty("removeUnreferenced");
      const sent = JSON.stringify(request);
      for (const orphan of orphans) expect(sent).not.toContain(orphan);
    }), { numRuns: 300 });
  });

  it("sends no checkout work from the idle threads tab", () => {
    const scan = fixtureScan();
    const request = buildApplyRequest(scan, defaultSelection(scan), "threads");
    expect(request.removeCheckouts).toEqual([]);
    expect(request.removeEmptyFolders).toBe(false);
    expect(request.hibernate).toEqual([]);
  });

  it("offers an archive candidate's checkout only while its archive is not chosen", () => {
    const scan = fixtureScan();
    scan.hibernate!.items.push({ backend: "codex", threadId: "t-clean", title: "Rebuild checkout flow",
      worktreePath: "/home/.pwragent/worktrees/k3m9/harbor-web", lastActivityAt: NOW - 26 * DAY, files: 0, bytes: 0,
      archiveKey: "codex:t-clean" });
    const selection = defaultSelection(scan);
    const hibernated = (mode: "combined" | "hibernate") =>
      buildApplyRequest(scan, selection, mode).hibernate?.map((item) => item.threadId);
    // Combined archives it, so it is not hibernated too.
    expect(hibernated("combined")).toEqual(["h-changes", "h-clean"]);
    // The tab that only hibernates offers it.
    expect(hibernated("hibernate")).toEqual(["h-changes", "h-clean", "t-clean"]);
    // Unticked in step 1, Combined offers it again.
    selection.threads.delete("codex:t-clean");
    expect(hibernated("combined")).toEqual(["h-changes", "h-clean", "t-clean"]);
  });

  it("selects every idle checkout the scan offers", () => {
    const scan = fixtureScan();
    expect(buildApplyRequest(scan, defaultSelection(scan), "combined").hibernate?.map((item) => item.threadId))
      .toEqual(["h-changes", "h-clean"]);
  });

  // Model: Combined runs exactly the steps its plan ticks, whatever the
  // operator selected in any review. Archive is never ticked by default.
  it("sends work only for the steps Combined's plan ticks", () => {
    const scan = fixtureScan();
    const threadKeys = scan.threads.projects.flatMap((project) => project.idle).map((row) => `${row.backend}:${row.threadId}`);
    const checkoutPaths = scan.checkouts.items.map((item) => item.worktreePath);
    const hibernateKeys = scan.hibernate!.items.map((item) => `${item.backend}:${item.threadId}`);
    expect(runSteps("combined")).toEqual(["hibernate", "checkouts"]);
    fc.assert(fc.property(
      fc.record({ threads: fc.boolean(), hibernate: fc.boolean(), checkouts: fc.boolean() }),
      fc.subarray(threadKeys), fc.subarray(checkoutPaths), fc.subarray(hibernateKeys), fc.boolean(),
      (plan, threads, checkouts, hibernate, emptyFolders) => {
        const steps = runSteps("combined", plan);
        expect(steps).toEqual((["threads", "hibernate", "checkouts"] as ThreadMaintenanceScanStep[]).filter((step) => plan[step]));
        const selection = { ...defaultSelection(scan), threads: new Set(threads), checkouts: new Set(checkouts),
          hibernate: new Set(hibernate), emptyFolders };
        const request = buildApplyRequest(scan, selection, steps);
        const fields = {
          threads: request.archive.length,
          hibernate: request.hibernate?.length ?? 0,
          checkouts: request.removeCheckouts.length + request.trashCheckouts.length
            + (request.removeEmptyFolders ? 1 : 0),
        };
        for (const [step, count] of Object.entries(fields)) {
          if (!plan[step as ThreadMaintenanceScanStep]) expect(count, `unticked ${step} sent work`).toBe(0);
        }
      },
    ), { numRuns: 300 });
  });

  // Model: a tab sends work for its own steps and nothing else, whatever
  // the operator selected. Each request field belongs to one step.
  it("sends work only for the steps a tab runs", () => {
    const scan = fixtureScan();
    scan.checkouts.items.push({ kind: "unreferenced", worktreePath: "/home/.pwragent/worktrees/z9/kiln-old", workspace: { kind: "clean" } });
    const threadKeys = scan.threads.projects.flatMap((project) => project.idle).map((row) => `${row.backend}:${row.threadId}`);
    const checkoutPaths = scan.checkouts.items.map((item) => item.worktreePath);
    const hibernateKeys = scan.hibernate!.items.map((item) => `${item.backend}:${item.threadId}`);
    const modes = ["combined", "threads", "hibernate", "checkouts"] as const;
    fc.assert(fc.property(
      fc.constantFrom(...modes),
      fc.subarray(threadKeys), fc.subarray(checkoutPaths), fc.subarray(hibernateKeys), fc.boolean(),
      (mode, threads, checkouts, hibernate, emptyFolders) => {
        const selection = { ...defaultSelection(scan), threads: new Set(threads), checkouts: new Set(checkouts),
          hibernate: new Set(hibernate), emptyFolders };
        const request = buildApplyRequest(scan, selection, mode);
        const runs = (step: string) => mode === "combined" || mode === step;
        const fields = {
          threads: request.archive.length,
          hibernate: request.hibernate?.length ?? 0,
          checkouts: request.removeCheckouts.length + request.trashCheckouts.length
            + (request.removeEmptyFolders ? 1 : 0),
        };
        for (const [step, count] of Object.entries(fields)) {
          if (!runs(step)) expect(count, `${mode} sent ${step} work`).toBe(0);
        }
        if (runs("hibernate")) expect(fields.hibernate).toBe(hibernate.length);
      },
    ), { numRuns: 300 });
  });
});
