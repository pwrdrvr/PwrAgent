import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_THREAD_ARCHIVE_POLICY, type DesktopThreadArchiveSweepStatus } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { ArchivePolicySettings, ArchiveSweepField } from "../ArchivePolicySettings";
import { ThreadMaintenanceLauncherContext } from "../../maintenance/thread-maintenance-launcher";

const clock = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const FINISHED_AT = new Date(2026, 9, 2, 15, 12).getTime();
const NEXT_AT = new Date(2026, 9, 2, 16, 12).getTime();

function sweepApi(initial: DesktopThreadArchiveSweepStatus, finished?: DesktopThreadArchiveSweepStatus) {
  let publish!: (status: DesktopThreadArchiveSweepStatus) => void;
  let finish!: () => void;
  const api: DesktopApi = {
    getThreadArchiveSweepStatus: vi.fn(async () => initial),
    runThreadArchiveSweep: vi.fn(async () => {
      publish({ running: true, startedAt: NEXT_AT, deleted: 0, failed: 0 });
      await new Promise<void>((resolve) => { finish = resolve; });
      publish(finished!);
      return finished!;
    }),
    onThreadArchiveSweepStatusChanged: vi.fn((callback) => {
      publish = (status) => act(() => callback(status));
      return () => undefined;
    }),
  };
  return { api, publish: (status: DesktopThreadArchiveSweepStatus) => publish(status), finish: () => finish() };
}

afterEach(cleanup);

describe("ArchivePolicySettings", () => {
  it("has no automatic archive switch and says archiving waits for the operator", () => {
    render(<ArchivePolicySettings onWriteConfig={vi.fn(async () => true)} />);
    expect(screen.queryByRole("switch", { name: /Automatically archive/ })).toBeNull();
    expect(screen.getByText("Suggest threads to archive")).toBeInTheDocument();
    expect(screen.getByText(/PwrAgent archives a thread only when you ask/)).toBeInTheDocument();
    expect(screen.getByText(/The hourly sweep and its last run are in Settings → Worktrees/)).toBeInTheDocument();
  });

  it("defaults to 20 eligible threads per project and explains protected threads are additional", () => {
    render(<ArchivePolicySettings onWriteConfig={vi.fn(async () => true)} />);
    expect(screen.getByRole("spinbutton", { name: "Eligible threads per project" })).toHaveValue(20);
    expect(screen.getByText(/Keep 20 eligible threads in every project, plus all/)).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Permanently delete expired archives" })).not.toBeChecked();
  });

  it("switches to seven-day inactivity and persists number edits on blur, never writing `enabled`", async () => {
    const save = vi.fn(async () => true);
    render(<ArchivePolicySettings onWriteConfig={save} />);
    fireEvent.click(screen.getByRole("radio", { name: /Suggest after inactivity/ }));
    await waitFor(() => expect(save).toHaveBeenCalledWith({ worktrees: { archive: { ...DEFAULT_THREAD_ARCHIVE_POLICY, mode: "age" } } }));
    const days = screen.getByRole("spinbutton", { name: "Days untouched" });
    expect(days).toHaveValue(7);
    await waitFor(() => expect(days).toBeEnabled());
    fireEvent.change(days, { target: { value: "14" } });
    fireEvent.blur(days);
    await waitFor(() => expect(save).toHaveBeenLastCalledWith({ worktrees: { archive: { ...DEFAULT_THREAD_ARCHIVE_POLICY, mode: "age", inactivityDays: 14 } } }));
    for (const [patch] of save.mock.calls as unknown as Array<[{ worktrees: { archive: object } }]>) {
      expect(patch.worktrees.archive).not.toHaveProperty("enabled");
    }
  });

  it("enables a deletion period explicitly and keeps the input editable while empty", async () => {
    const save = vi.fn(async () => true);
    render(<ArchivePolicySettings onWriteConfig={save} />);
    fireEvent.click(screen.getByRole("switch", { name: "Permanently delete expired archives" }));
    const days = await screen.findByRole("spinbutton", { name: "Keep archives for days" });
    expect(days).toHaveValue(30);
    await waitFor(() => expect(days).toBeEnabled());
    fireEvent.change(days, { target: { value: "" } });
    expect(screen.getByRole("spinbutton", { name: "Keep archives for days" })).toBeInTheDocument();
    fireEvent.change(days, { target: { value: "90" } });
    fireEvent.blur(days);
    await waitFor(() => expect(save).toHaveBeenLastCalledWith({ worktrees: { archive: { ...DEFAULT_THREAD_ARCHIVE_POLICY, retentionDays: 90 } } }));
  });

  it("shows an error and restores the saved policy when persistence fails", async () => {
    render(<ArchivePolicySettings onWriteConfig={vi.fn(async () => false)} />);
    fireEvent.click(screen.getByRole("radio", { name: /Suggest after inactivity/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be saved");
    expect(screen.getByRole("spinbutton", { name: "Eligible threads per project" })).toHaveValue(20);
  });

  it("opens Thread Maintenance when App provides it", () => {
    const open = vi.fn();
    render(
      <ThreadMaintenanceLauncherContext.Provider value={open}>
        <ArchivePolicySettings onWriteConfig={vi.fn(async () => true)} />
      </ThreadMaintenanceLauncherContext.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Thread Maintenance…" }));
    expect(open).toHaveBeenCalledOnce();
  });

  it("refreshes the archived list when a sweep deletes expired archives", async () => {
    const onSweepChanged = vi.fn();
    const { api, publish } = sweepApi({ running: false, finishedAt: FINISHED_AT, deleted: 2, failed: 0 });
    render(<ArchivePolicySettings onWriteConfig={vi.fn(async () => true)} desktopApi={api} onSweepChanged={onSweepChanged} />);
    await waitFor(() => expect(api.getThreadArchiveSweepStatus).toHaveBeenCalled());
    // The sweep that finished before the pane opened is already in its list.
    publish({ running: false, finishedAt: FINISHED_AT, deleted: 2, failed: 0 });
    expect(onSweepChanged).not.toHaveBeenCalled();
    publish({ running: false, finishedAt: NEXT_AT, deleted: 1, failed: 0 });
    expect(onSweepChanged).toHaveBeenCalledOnce();
  });
});

describe("ArchiveSweepField", () => {
  it("says the sweep never archives a thread, and shows when the next one runs", async () => {
    const { api } = sweepApi({
      running: false, startedAt: FINISHED_AT, finishedAt: FINISHED_AT, nextAt: NEXT_AT, deleted: 1, failed: 0,
    });
    render(<ArchiveSweepField desktopApi={api} />);
    expect(await screen.findByText("Deleted 1 expired archive.")).toBeInTheDocument();
    expect(screen.getByText(/They never archive a thread/)).toBeInTheDocument();
    expect(screen.getByText(clock.format(FINISHED_AT))).toBeInTheDocument();
    expect(screen.getByText(`Next sweep about ${clock.format(NEXT_AT)}`)).toBeInTheDocument();
  });

  it("runs a sweep on request and holds the button while it runs", async () => {
    const { api, finish } = sweepApi(
      { running: false, nextAt: NEXT_AT, deleted: 0, failed: 0 },
      { running: false, startedAt: NEXT_AT, finishedAt: NEXT_AT, nextAt: NEXT_AT + 3_600_000, deleted: 0, failed: 0,
        hibernation: { checked: 2, hibernated: 2, kept: {} } },
    );
    render(<ArchiveSweepField desktopApi={api} />);
    expect(await screen.findByText("Not run yet")).toBeInTheDocument();
    expect(screen.getByText(`First sweep about ${clock.format(NEXT_AT)}`)).toBeInTheDocument();
    const runNow = screen.getByRole("button", { name: "Run now" });
    fireEvent.click(runNow);
    await screen.findByText("Running");
    expect(runNow).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(runNow);
    expect(api.runThreadArchiveSweep).toHaveBeenCalledTimes(1);
    await act(async () => { finish(); });
    expect(await screen.findByText("Hibernated 2 idle checkouts.")).toBeInTheDocument();
    expect(runNow).not.toHaveAttribute("aria-disabled");
  });

  it("says when a sweep had nothing to do", async () => {
    const { api } = sweepApi({ running: false, finishedAt: FINISHED_AT, nextAt: NEXT_AT, deleted: 0, failed: 0 });
    render(<ArchiveSweepField desktopApi={api} />);
    expect(await screen.findByText("Nothing to clean up.")).toBeInTheDocument();
  });

  it("counts failures and shows the first error", async () => {
    const { api } = sweepApi({
      running: false, finishedAt: FINISHED_AT, nextAt: NEXT_AT, deleted: 1, failed: 2,
      error: "git worktree remove timed out",
    });
    render(<ArchiveSweepField desktopApi={api} />);
    expect(await screen.findByText("2 failed")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("git worktree remove timed out");
  });

  it("reports each phase and lists every failure with its path", async () => {
    const { api } = sweepApi({
      running: false, finishedAt: FINISHED_AT, nextAt: NEXT_AT, deleted: 0, failed: 3,
      hibernation: { checked: 6, hibernated: 1,
        kept: { "Recently active": 2, "Other ignored files": 1, "Rebase in progress": 1, "Pinned thread": 1 } },
      worktrees: { candidates: 2, protected: 0, processed: 2, removed: 1, kept: { "Repository no longer exists": 1 } },
      error: "first",
      failures: [
        { phase: "worktrees", message: "EACCES: permission denied", path: "/w/one" },
        { phase: "hibernation", message: "snapshot mismatch", threadId: "t1" },
      ],
    });
    render(<ArchiveSweepField desktopApi={api} />);
    expect(await screen.findByText("Hibernated 1 idle checkout. Kept 5: Recently active (2), Other ignored files (1), Pinned thread (1), and 1 more reason."))
      .toBeInTheDocument();
    expect(screen.getByText("Cleaned 1 of 2 archived worktrees. Kept 1: Repository no longer exists (1).")).toBeInTheDocument();
    expect(screen.getByText("EACCES: permission denied (/w/one)")).toBeInTheDocument();
    expect(screen.getByText("snapshot mismatch")).toBeInTheDocument();
    expect(screen.getByText("and 1 more")).toBeInTheDocument();
    expect(screen.queryByText(/^Threads:|Checked \d+ threads|Archived \d/)).toBeNull();
  });

  it("shows archived worktree progress", async () => {
    const { api, publish } = sweepApi({ running: false, deleted: 0, failed: 0 });
    render(<ArchiveSweepField desktopApi={api} />);
    await screen.findByText("Not run yet");
    const worktrees = { candidates: 498, protected: 3, processed: 20, removed: 18 };
    publish({ running: true, deleted: 0, failed: 0, worktrees });
    expect(screen.getByText("Worktrees: 20 of 498 checked, 18 cleaned, 3 protected.")).toBeInTheDocument();
    publish({ running: false, finishedAt: FINISHED_AT, deleted: 0, failed: 0,
      worktrees: { ...worktrees, processed: 498, removed: 498 } });
    expect(screen.getByText("Cleaned 498 of 498 archived worktrees. Protected 3.")).toBeInTheDocument();
  });

  it("shows empty-folder progress", async () => {
    const { api, publish } = sweepApi({ running: false, deleted: 0, failed: 0 });
    render(<ArchiveSweepField desktopApi={api} />);
    await screen.findByText("Not run yet");
    const worktrees = { candidates: 0, protected: 0, processed: 0, removed: 0,
      emptyContainers: 259, processedContainers: 10, removedContainers: 10 };
    publish({ running: true, deleted: 0, failed: 0, worktrees });
    expect(screen.getByText("Folders: 10 of 259 checked, 10 cleaned.")).toBeInTheDocument();
    publish({ running: false, finishedAt: FINISHED_AT, deleted: 0, failed: 0,
      worktrees: { ...worktrees, processedContainers: 259, removedContainers: 259 } });
    expect(screen.getByText(/Cleaned 259 of 259 empty worktree folders/)).toBeInTheDocument();
  });

  it("opens Thread maintenance from Review… when App provides it", async () => {
    const { api } = sweepApi({ running: false, deleted: 0, failed: 0, finishedAt: FINISHED_AT, nextAt: NEXT_AT });
    const open = vi.fn();
    render(
      <ThreadMaintenanceLauncherContext.Provider value={open}>
        <ArchiveSweepField desktopApi={api} />
      </ThreadMaintenanceLauncherContext.Provider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Review…" }));
    expect(open).toHaveBeenCalledOnce();
  });

  it("has no Review… button without a launcher", async () => {
    const { api } = sweepApi({ running: false, deleted: 0, failed: 0, finishedAt: FINISHED_AT, nextAt: NEXT_AT });
    render(<ArchiveSweepField desktopApi={api} />);
    await screen.findByRole("button", { name: "Run now" });
    expect(screen.queryByRole("button", { name: "Review…" })).toBeNull();
  });
});
