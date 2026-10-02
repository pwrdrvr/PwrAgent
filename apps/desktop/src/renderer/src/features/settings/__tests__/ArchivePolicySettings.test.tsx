import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_THREAD_ARCHIVE_POLICY, type DesktopThreadArchiveSweepStatus } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { ArchivePolicySettings } from "../ArchivePolicySettings";

const clock = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const FINISHED_AT = new Date(2026, 9, 2, 15, 12).getTime();
const NEXT_AT = new Date(2026, 9, 2, 16, 12).getTime();

function sweepApi(initial: DesktopThreadArchiveSweepStatus, finished?: DesktopThreadArchiveSweepStatus) {
  let publish!: (status: DesktopThreadArchiveSweepStatus) => void;
  let finish!: () => void;
  const api: DesktopApi = {
    getThreadArchiveSweepStatus: vi.fn(async () => initial),
    runThreadArchiveSweep: vi.fn(async () => {
      publish({ running: true, startedAt: NEXT_AT, archived: 0, deleted: 0, failed: 0 });
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
  it("defaults to 20 eligible threads per project and explains protected threads are additional", () => {
    render(<ArchivePolicySettings onWriteConfig={vi.fn(async () => true)} />);
    expect(screen.getByRole("spinbutton", { name: "Eligible threads per project" })).toHaveValue(20);
    expect(screen.getByText(/Keep 20 eligible threads in every project, plus all/)).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Permanently delete expired archives" })).not.toBeChecked();
  });

  it("switches to seven-day inactivity and persists number edits on blur", async () => {
    const save = vi.fn(async () => true);
    render(<ArchivePolicySettings onWriteConfig={save} />);
    fireEvent.click(screen.getByRole("radio", { name: /Archive after inactivity/ }));
    await waitFor(() => expect(save).toHaveBeenCalledWith({ worktrees: { archive: { ...DEFAULT_THREAD_ARCHIVE_POLICY, mode: "age" } } }));
    const days = screen.getByRole("spinbutton", { name: "Days untouched" });
    expect(days).toHaveValue(7);
    await waitFor(() => expect(days).toBeEnabled());
    fireEvent.change(days, { target: { value: "14" } });
    fireEvent.blur(days);
    await waitFor(() => expect(save).toHaveBeenLastCalledWith({ worktrees: { archive: { ...DEFAULT_THREAD_ARCHIVE_POLICY, mode: "age", inactivityDays: 14 } } }));
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
    fireEvent.click(screen.getByRole("radio", { name: /Archive after inactivity/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be saved");
    expect(screen.getByRole("spinbutton", { name: "Eligible threads per project" })).toHaveValue(20);
  });

  it("shows the last sweep and when the next one runs", async () => {
    const { api } = sweepApi({
      running: false, startedAt: FINISHED_AT, finishedAt: FINISHED_AT, nextAt: NEXT_AT, archived: 4, deleted: 1, failed: 0,
    });
    render(<ArchivePolicySettings onWriteConfig={vi.fn(async () => true)} desktopApi={api} />);
    expect(await screen.findByText("Archived 4 threads. Deleted 1 expired archive.")).toBeInTheDocument();
    expect(screen.getByText(clock.format(FINISHED_AT))).toBeInTheDocument();
    expect(screen.getByText(`Next sweep about ${clock.format(NEXT_AT)}`)).toBeInTheDocument();
  });

  it("runs a sweep on request, holds the button while it runs, and refreshes the list after a change", async () => {
    const onSweepChanged = vi.fn();
    const { api, finish } = sweepApi(
      { running: false, nextAt: NEXT_AT, archived: 0, deleted: 0, failed: 0 },
      { running: false, startedAt: NEXT_AT, finishedAt: NEXT_AT, nextAt: NEXT_AT + 3_600_000, archived: 2, deleted: 0, failed: 0 },
    );
    render(<ArchivePolicySettings onWriteConfig={vi.fn(async () => true)} desktopApi={api} onSweepChanged={onSweepChanged} />);
    expect(await screen.findByText("Not run yet")).toBeInTheDocument();
    expect(screen.getByText(`First sweep about ${clock.format(NEXT_AT)}`)).toBeInTheDocument();
    const runNow = screen.getByRole("button", { name: "Run now" });
    fireEvent.click(runNow);
    await screen.findByText("Running");
    expect(runNow).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(runNow);
    expect(api.runThreadArchiveSweep).toHaveBeenCalledTimes(1);
    await act(async () => { finish(); });
    expect(await screen.findByText("Archived 2 threads.")).toBeInTheDocument();
    expect(runNow).not.toHaveAttribute("aria-disabled");
    // The broadcast and the invoke result report the same finish: one refresh.
    expect(onSweepChanged).toHaveBeenCalledTimes(1);
  });

  it("does not refresh for a sweep that finished before the pane opened or changed nothing", async () => {
    const onSweepChanged = vi.fn();
    const { api, publish } = sweepApi({
      running: false, finishedAt: FINISHED_AT, nextAt: NEXT_AT, archived: 3, deleted: 0, failed: 0,
    });
    render(<ArchivePolicySettings onWriteConfig={vi.fn(async () => true)} desktopApi={api} onSweepChanged={onSweepChanged} />);
    await screen.findByText("Archived 3 threads.");
    publish({ running: false, finishedAt: NEXT_AT, archived: 0, deleted: 0, failed: 0 });
    expect(await screen.findByText("Nothing to archive.")).toBeInTheDocument();
    expect(onSweepChanged).not.toHaveBeenCalled();
  });

  it("counts failures and shows the first error", async () => {
    const { api } = sweepApi({
      running: false, finishedAt: FINISHED_AT, nextAt: NEXT_AT, archived: 3, deleted: 0, failed: 2,
      error: "thread/archive timed out",
    });
    render(<ArchivePolicySettings onWriteConfig={vi.fn(async () => true)} desktopApi={api} />);
    expect(await screen.findByText("2 failed")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("thread/archive timed out");
  });

  it("hides Run now when archiving and deletion are both off", async () => {
    const { api } = sweepApi({ running: false, finishedAt: FINISHED_AT, archived: 1, deleted: 0, failed: 0 });
    render(<ArchivePolicySettings value={{ ...DEFAULT_THREAD_ARCHIVE_POLICY, enabled: false }}
      onWriteConfig={vi.fn(async () => true)} desktopApi={api} />);
    expect(await screen.findByText(/sweeps do nothing/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run now" })).not.toBeInTheDocument();
  });
});
