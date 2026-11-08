import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ThreadMaintenanceProblem,
  ThreadMaintenanceRun,
  ThreadMaintenanceRunItem,
  ThreadMaintenanceScan,
} from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { ThreadMaintenanceDialog } from "../ThreadMaintenanceDialog";

// The real dialog, driven by run snapshots the way main publishes them:
// four hibernations at once, 89 in all, results retained.

afterEach(() => {
  cleanup();
});

const NOW = new Date(2026, 10, 7, 11, 0).getTime();
const DAY = 86_400_000;
const GB = 1024 ** 3;
let revision = 0;

function scan(): ThreadMaintenanceScan {
  return {
    scanId: "scan-1", startedAt: NOW, finishedAt: NOW,
    rules: { mode: "count", keepPerProject: 20, inactivityDays: 7, rebuildableOutputIsClean: true },
    spaceSource: "filesystem",
    threads: { checked: 0, projects: [], kept: {} },
    hibernate: {
      idleDays: 7, maxSnapshotMb: 100, removeRebuildableOutput: true, checked: 1, notIdleYet: 0, kept: {},
      items: [{ backend: "codex", threadId: "t-0", title: "Thread 0", worktreePath: "/w/0/kiln",
        lastActivityAt: NOW - 20 * DAY, files: 0, bytes: 0, space: { allocatedBytes: GB } }],
    },
    checkouts: { items: [], kept: {}, emptyFolders: 0 },
    expired: { enabled: false, retentionDays: 0 },
    failures: [],
  };
}

/** 89 hibernations: `done` finished, the next four running, the rest queued. */
function items(done: number, overrides: Record<number, Partial<ThreadMaintenanceRunItem>> = {}): ThreadMaintenanceRunItem[] {
  return Array.from({ length: 89 }, (_, index): ThreadMaintenanceRunItem => {
    const base: ThreadMaintenanceRunItem = {
      itemId: `hibernate:${index}`, step: "hibernate", action: "hibernate", object: `Thread ${index}`,
      path: `/w/${index}/kiln`, backend: "codex", threadId: `t-${index}`, status: "queued",
    };
    const row: ThreadMaintenanceRunItem = index < done
      ? { ...base, status: "done", startedAt: NOW + index * 1000, finishedAt: NOW + index * 1000 + 900, allocatedBytesRemoved: 2 * GB }
      : index < done + 4
        ? { ...base, status: "running", stage: index % 2 ? "waiting" : "snapshotting", startedAt: NOW + index * 1000 }
        : base;
    return { ...row, ...overrides[index] };
  });
}

function run(rows: ThreadMaintenanceRunItem[], extra: Partial<ThreadMaintenanceRun> = {}): ThreadMaintenanceRun {
  return { runId: "run-1", revision: ++revision, scanId: "scan-1", running: true, startedAt: NOW, steps: [], problems: [],
    current: { step: "hibernate", processed: rows.filter((row) => row.status !== "queued" && row.status !== "running").length,
      total: rows.length, object: rows.find((row) => row.status === "running")?.object },
    items: rows, ...extra };
}

async function startRun(onOpenThread = vi.fn()) {
  const listeners = new Set<(next: ThreadMaintenanceRun) => void>();
  const desktopApi = {
    scanThreadMaintenance: vi.fn(async () => scan()),
    applyThreadMaintenance: vi.fn(async () => run(items(0))),
    getThreadMaintenanceRun: vi.fn(async () => null),
    stopThreadMaintenance: vi.fn(async () => {}),
    onThreadMaintenanceRunChanged: vi.fn((listener: (next: ThreadMaintenanceRun) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    }),
  } as unknown as DesktopApi;
  render(<ThreadMaintenanceDialog desktopApi={desktopApi} onClose={vi.fn()} onMinimize={vi.fn()} onOpenThread={onOpenThread} />);
  const dialog = screen.getByRole("dialog", { name: "Thread maintenance" });
  fireEvent.click(within(dialog).getByRole("radio", { name: "Idle checkouts" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "Scan" }));
  fireEvent.click(await within(dialog).findByRole("button", { name: "Hibernate 1 checkout" }));
  await within(dialog).findByRole("button", { name: /^Stop after/ });
  const emit = (next: ThreadMaintenanceRun) => { act(() => { for (const listener of listeners) listener(next); }); };
  return { dialog, emit, desktopApi, onOpenThread };
}

const titles = (region: HTMLElement) =>
  within(region).queryAllByRole("listitem").map((row) => row.querySelector(".thread-maintenance__run-title")?.textContent);

describe("a parallel run's rows", () => {
  it("shows all four items in progress with their directory, stage and time, and keeps each success findable", async () => {
    const { dialog, emit } = await startRun();
    emit(run(items(3)));
    const active = within(dialog).getByRole("region", { name: "In progress · 4" });
    expect(titles(active)).toEqual(["Thread 3", "Thread 4", "Thread 5", "Thread 6"]);
    const first = within(active).getAllByRole("listitem")[0]!;
    expect(first).toHaveTextContent("/w/3/kiln");
    expect(first).toHaveTextContent("Waiting for its repository");
    expect(within(active).getAllByRole("listitem")[1]).toHaveTextContent("Saving snapshot");
    expect(first.querySelector(".thread-maintenance__elapsed")).not.toBeNull();
    expect(within(dialog).getByRole("region", { name: "Done · 3" })).toHaveTextContent("Hibernated · 2.0 GB allocation removed");
    // The queue is one folded line after the results, not 82 rows.
    const waiting = within(dialog).getByRole("region", { name: "Waiting · 82" });
    expect(within(waiting).queryAllByRole("listitem")).toHaveLength(0);
    expect(dialog).toHaveTextContent("3 of 89 finished");

    // Later items start; earlier successes stay where they were.
    emit(run(items(9)));
    expect(titles(within(dialog).getByRole("region", { name: "Done · 9" })))
      .toEqual(Array.from({ length: 9 }, (_, index) => `Thread ${index}`));
    expect(titles(within(dialog).getByRole("region", { name: "In progress · 4" })))
      .toEqual(["Thread 9", "Thread 10", "Thread 11", "Thread 12"]);
    // The head chip counts results, not one moving title.
    expect(dialog).toHaveTextContent("9 / 89 · 4 in progress");
  });

  it("says Stop lets every item in progress finish and starts no more", async () => {
    const { dialog, emit } = await startRun();
    emit(run(items(3)));
    expect(within(dialog).getByRole("button", { name: "Stop after current items" })).toBeInTheDocument();
    emit(run(items(3), { stopRequested: true }));
    expect(dialog).toHaveTextContent("Stopping. 4 in progress finish; 82 waiting won't start.");
  });

  it("keeps every result with Open thread when finished, and says a kept or failed item once", async () => {
    const { dialog, emit, onOpenThread } = await startRun();
    const rows = items(89, {
      7: { status: "kept", reason: "Uncommitted changes", allocatedBytesRemoved: undefined },
      8: { status: "failed", reason: "Snapshot failed", detail: "git exited 128", allocatedBytesRemoved: undefined },
    });
    const problems: ThreadMaintenanceProblem[] = [
      { step: "hibernate", kind: "kept", object: "Thread 7", reason: "Uncommitted changes", backend: "codex", threadId: "t-7" },
      { step: "hibernate", kind: "failed", object: "Thread 8", reason: "Snapshot failed", backend: "codex", threadId: "t-8" },
      // A step-level note no item carries still shows.
      { step: "hibernate", kind: "kept", object: "Grok: list flaky specs", reason: "No worktree checkout" },
    ];
    emit(run(rows, { running: false, finishedAt: NOW + 240_000, problems,
      steps: [{ step: "hibernate", ran: true, done: 87, kept: 1, failed: 1, allocatedBytesRemoved: 174 * GB }] }));
    expect(within(dialog).getByRole("region", { name: "Done · 87" })).toBeInTheDocument();
    expect(within(dialog).getByRole("region", { name: "Kept · 1" })).toHaveTextContent("Uncommitted changes");
    expect(within(dialog).getByRole("region", { name: "Failed · 1" })).toHaveTextContent("Snapshot failed · git exited 128");
    expect(within(dialog).getAllByText("Thread 7")).toHaveLength(1);
    expect(within(dialog).getAllByText("Thread 8")).toHaveLength(1);
    expect(dialog).toHaveTextContent("Grok: list flaky specs");
    expect(dialog).toHaveTextContent("Maintenance finished with 1 problem");
    expect(dialog).not.toHaveTextContent(/freed|Trash/);
    fireEvent.click(within(dialog).getByRole("button", { name: "Open thread Thread 42" }));
    expect(onOpenThread).toHaveBeenCalledWith({ backend: "codex", threadId: "t-42" });
  });

  it("keeps the single progress line for an owner that sends no items", async () => {
    const { dialog, emit } = await startRun();
    emit({ runId: "run-1", revision: ++revision, scanId: "scan-1", running: true, startedAt: NOW, steps: [], problems: [],
      current: { step: "hibernate", processed: 2, total: 9, object: "Thread 2" } });
    expect(within(dialog).queryByRole("region", { name: "Run progress" })).toBeNull();
    expect(dialog).toHaveTextContent("now: Thread 2");
    expect(within(dialog).getByRole("button", { name: "Stop after this item" })).toBeInTheDocument();
  });
});
