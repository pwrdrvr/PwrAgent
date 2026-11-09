import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import type {
  ThreadMaintenanceProblem,
  ThreadMaintenanceRun,
  ThreadMaintenanceScan,
  ThreadMaintenanceScanProgress,
} from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { ThreadMaintenanceDialog } from "../ThreadMaintenanceDialog";
import { allocationTotal, groupProblems, largestFirst } from "../thread-maintenance-selection";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const NOW = new Date(2026, 10, 4, 11, 0).getTime();
const DAY = 86_400_000;
const GB = 1024 ** 3;
const MB = 1024 ** 2;

const sized = fc.record({
  id: fc.nat(),
  space: fc.option(fc.record({
    allocatedBytes: fc.option(fc.nat({ max: 2 ** 40 }), { nil: undefined }),
    lowerBound: fc.option(fc.boolean(), { nil: undefined }),
  }), { nil: undefined }),
});

describe("thread maintenance sizes, as properties", () => {
  it("orders measured checkouts largest first, then unmeasured ones, each in scan order", () => {
    fc.assert(fc.property(fc.array(sized, { maxLength: 40 }), (items) => {
      const sorted = largestFirst(items);
      // A permutation: nothing dropped or duplicated.
      expect([...sorted].sort((a, b) => items.indexOf(a) - items.indexOf(b))).toEqual(items);
      const bytes = sorted.map((item) => item.space?.allocatedBytes);
      const firstUnmeasured = bytes.indexOf(undefined);
      if (firstUnmeasured >= 0) expect(bytes.slice(firstUnmeasured).every((value) => value === undefined)).toBe(true);
      for (let index = 1; index < sorted.length; index += 1) {
        const [before, after] = [bytes[index - 1], bytes[index]];
        if (before === undefined || after === undefined) continue;
        expect(before).toBeGreaterThanOrEqual(after);
        // Ties keep scan order.
        if (before === after) expect(items.indexOf(sorted[index - 1]!)).toBeLessThan(items.indexOf(sorted[index]!));
      }
      const unmeasured = sorted.filter((item) => item.space?.allocatedBytes === undefined);
      expect(unmeasured).toEqual(items.filter((item) => item.space?.allocatedBytes === undefined));
    }));
  });

  it("totals only measured allocation, and is a lower bound whenever any row is unmeasured or partial", () => {
    fc.assert(fc.property(fc.array(sized, { maxLength: 40 }), (items) => {
      const measured = items.filter((item) => item.space?.allocatedBytes !== undefined);
      const total = allocationTotal(items);
      if (!measured.length) {
        expect(total).toBeUndefined();
        return;
      }
      expect(total).toEqual({
        bytes: measured.reduce((sum, item) => sum + item.space!.allocatedBytes!, 0),
        measured: measured.length,
        lowerBound: measured.length < items.length || measured.some((item) => item.space!.lowerBound),
      });
    }));
  });

  it("counts a checkout two rows share once in a total", () => {
    const row = fc.record({
      worktreePath: fc.constantFrom("/w/a", "/w/b", "/w/c"),
      space: fc.option(fc.record({ allocatedBytes: fc.nat({ max: 2 ** 40 }) }), { nil: undefined }),
    });
    fc.assert(fc.property(fc.array(row, { maxLength: 30 }), (rows) => {
      // Oracle: keep each path's first row, then total those.
      const firsts = rows.filter((item, index) => rows.findIndex((other) => other.worktreePath === item.worktreePath) === index);
      const measured = firsts.filter((item) => item.space !== undefined);
      expect(allocationTotal(rows)).toEqual(measured.length ? {
        bytes: measured.reduce((sum, item) => sum + item.space!.allocatedBytes, 0),
        measured: measured.length,
        lowerBound: measured.length < firsts.length,
      } : undefined);
    }));
  });

  it("groups outcome rows into one group per reason, losing and reordering none", () => {
    const problem = fc.record({
      step: fc.constant("hibernate" as const),
      kind: fc.constantFrom("kept" as const, "failed" as const),
      object: fc.string({ maxLength: 6 }),
      reason: fc.constantFrom("Checkout missing", "No worktree checkout", "Kept awake", "Rebase in progress"),
    });
    fc.assert(fc.property(fc.array(problem, { maxLength: 40 }), (problems: ThreadMaintenanceProblem[]) => {
      const groups = groupProblems(problems);
      const reasons = groups.map((group) => group.reason);
      expect(new Set(reasons).size).toBe(reasons.length);
      expect(groups.flatMap((group) => group.problems)).toHaveLength(problems.length);
      for (const group of groups) {
        // Each group is exactly that reason's rows, in their original order.
        expect(group.problems).toEqual(problems.filter((row) => row.reason === group.reason));
      }
      for (let index = 1; index < groups.length; index += 1) {
        expect(groups[index - 1]!.problems.length).toBeGreaterThanOrEqual(groups[index]!.problems.length);
      }
    }));
  });
});

function sizedScan(): ThreadMaintenanceScan {
  return {
    scanId: "scan-1",
    startedAt: NOW,
    finishedAt: NOW + 41_000,
    rules: { mode: "count", keepPerProject: 20, inactivityDays: 7, rebuildableOutputIsClean: true },
    spaceSource: "pwrdisk",
    threads: { checked: 0, projects: [], kept: {} },
    checkouts: {
      items: [
        { backend: "codex", threadId: "a-1", title: "Stream progress", worktreePath: "/home/.pwragent/worktrees/q8d2/kiln-cli",
          kind: "removable", workspace: { kind: "clean" }, space: { allocatedBytes: 300 * MB } },
        { backend: "codex", threadId: "a-2", title: "Index the ledger", worktreePath: "/home/.codex/worktrees/r4t7/ledger-api",
          kind: "removable", workspace: { kind: "clean" }, space: { allocatedBytes: 7 * GB } },
      ],
      kept: {},
      emptyFolders: 0,
    },
    hibernate: {
      idleDays: 3,
      maxSnapshotMb: 100,
      removeRebuildableOutput: true,
      checked: 4,
      items: [
        // Scan order is smallest first, so the review's order is the sort's doing.
        { backend: "codex", threadId: "h-small", title: "Tidy the README", worktreePath: "/home/.codex/worktrees/a1/harbor-docs",
          lastActivityAt: NOW - 40 * DAY, files: 1, bytes: 166, space: { allocatedBytes: 12 * MB } },
        { backend: "codex", threadId: "h-unmeasured", title: "Draft the release notes", worktreePath: "/home/.codex/worktrees/a2/harbor-web",
          lastActivityAt: NOW - 30 * DAY, files: 0, bytes: 0 },
        { backend: "claude", threadId: "h-big", title: "Port the renderer to Rust", worktreePath: "/home/.pwragent/worktrees/a3/kiln",
          lastActivityAt: NOW - 20 * DAY, files: 8, bytes: 476 * 1024, removedOutput: ["target"],
          space: { allocatedBytes: 21 * GB, privateBytes: 9 * GB } },
        { backend: "codex", threadId: "h-mid", title: "Cache the TLS roots", worktreePath: "/home/.codex/worktrees/a4/grok-build",
          lastActivityAt: NOW - 10 * DAY, files: 0, bytes: 0, removedOutput: ["node_modules"], space: { allocatedBytes: 2 * GB } },
      ],
      notIdleYet: 0,
      kept: {},
      coverage: {
        roots: [
          { path: "/home/.pwragent/worktrees", owner: "pwragent", checkouts: 12, allocatedBytes: 40 * GB },
          { path: "/home/.codex/worktrees", owner: "codex", checkouts: 61, allocatedBytes: 120 * GB, lowerBound: true },
        ],
        providers: [{ backend: "codex", threads: 70 }, { backend: "claude", threads: 3 }],
        excluded: [{ reason: "outside a worktree root", count: 2, allocatedBytes: 3 * GB }],
      },
    },
    expired: { enabled: false, retentionDays: 0 },
    failures: [],
  };
}

function api(overrides: Partial<DesktopApi> = {}) {
  const runListeners = new Set<(run: ThreadMaintenanceRun) => void>();
  const progressListeners = new Set<(progress: ThreadMaintenanceScanProgress) => void>();
  const value = {
    scanThreadMaintenance: vi.fn(async () => sizedScan()),
    applyThreadMaintenance: vi.fn(async (): Promise<ThreadMaintenanceRun> => ({
      runId: "run-1", revision: 1, scanId: "scan-1", running: true, startedAt: NOW, steps: [], problems: [],
      current: { step: "hibernate", processed: 0, total: 3 },
    })),
    getThreadMaintenanceRun: vi.fn(async () => null),
    stopThreadMaintenance: vi.fn(async () => {}),
    onThreadMaintenanceRunChanged: vi.fn((callback: (run: ThreadMaintenanceRun) => void) => {
      runListeners.add(callback);
      return () => { runListeners.delete(callback); };
    }),
    onThreadMaintenanceScanProgress: vi.fn((callback: (progress: ThreadMaintenanceScanProgress) => void) => {
      progressListeners.add(callback);
      return () => { progressListeners.delete(callback); };
    }),
    ...overrides,
  } as unknown as DesktopApi;
  const emitRun = (run: ThreadMaintenanceRun) => { act(() => { for (const listener of runListeners) listener(run); }); };
  const emitProgress = (progress: ThreadMaintenanceScanProgress) => {
    act(() => { for (const listener of progressListeners) listener(progress); });
  };
  return { api: value, emitRun, emitProgress };
}

describe("ThreadMaintenanceDialog sizes and progress", () => {
  it("counts a slow listing step up from when it began, and says what it is reading", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(NOW);
    const { api: desktopApi, emitProgress } = api({
      scanThreadMaintenance: vi.fn(() => new Promise<ThreadMaintenanceScan>(() => {})),
    });
    render(<ThreadMaintenanceDialog desktopApi={desktopApi} onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "Thread maintenance" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Scan" }));
    const progressId = vi.mocked(desktopApi.scanThreadMaintenance!).mock.calls[0]![0]!.progressId!;
    const steps: ThreadMaintenanceScanProgress["steps"] = ["hibernate", "checkouts"];

    act(() => { vi.advanceTimersByTime(5_000); });
    emitProgress({ progressId, steps, step: "checkouts", stage: "listing", processed: 0, total: 0, inFlight: [] });
    act(() => { vi.advanceTimersByTime(134_000); });
    // Elapsed is the step's own, not the scan's: 134s since the step began.
    expect(within(dialog).getByText(/· 2m 14s/)).toBeInTheDocument();

    emitProgress({ progressId, steps, step: "checkouts", stage: "listing", processed: 0, total: 0, inFlight: [],
      found: 142, detail: "Listing worktrees", root: "/home/.codex/worktrees" });
    expect(within(dialog).getByText("142 found")).toBeInTheDocument();
    expect(within(dialog).getByText("Listing worktrees · /home/.codex/worktrees")).toBeInTheDocument();
  });

  it("lists idle checkouts largest first by allocation, apart from snapshot bytes, with a selected total", async () => {
    const { api: desktopApi } = api();
    render(<ThreadMaintenanceDialog desktopApi={desktopApi} onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "Thread maintenance" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Scan" }));
    const group = await within(dialog).findByRole("region", { name: "Can hibernate" });
    const titles = within(group).getAllByRole("listitem").map((row) => row.querySelector(".thread-maintenance__row-title")?.textContent);
    // Oracle: the fixture's allocations, sorted by hand; unmeasured last.
    expect(titles).toEqual(["Port the renderer to Rust", "Cache the TLS roots", "Tidy the README", "Draft the release notes"]);
    const big = within(group).getAllByRole("listitem")[0]!;
    expect(within(big).getByText("21 GB")).toBeInTheDocument();
    expect(within(big).getByText(/476 KB snapshot/)).toBeInTheDocument();
    expect(within(big).getByText("21 GB")).toHaveAttribute("data-tooltip", "21 GB on disk · 9.0 GB private allocation");
    // One row is unmeasured, so every total is a lower bound.
    expect(within(dialog).getByText(/candidates hold ≥ 23 GB on disk/)).toBeInTheDocument();
    expect(within(dialog).getByText(/≥ 23 GB on disk · then archived checkouts/)).toBeInTheDocument();

    fireEvent.click(within(big).getByRole("checkbox", { name: "Hibernate Port the renderer to Rust" }));
    expect(within(dialog).getByText(/≥ 2\.0 GB on disk · then archived checkouts/)).toBeInTheDocument();
  });

  it("says which roots and providers the scan read and what it left out", async () => {
    const { api: desktopApi } = api();
    render(<ThreadMaintenanceDialog desktopApi={desktopApi} onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "Thread maintenance" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Scan" }));
    const coverage = await within(dialog).findByRole("region", { name: "What the scan read" });
    expect(coverage).toHaveTextContent("Scanned 2 roots · 73 checkouts · ≥ 160 GB on disk");
    const roots = within(coverage).getAllByRole("listitem").map((row) => row.textContent);
    expect(roots).toEqual(["/home/.codex/worktreescodex61≥ 120 GB", "/home/.pwragent/worktreespwragent1240 GB"]);
    expect(coverage).toHaveTextContent("codex 70 · claude 3");
    expect(coverage).toHaveTextContent("2 outside a worktree root (3.0 GB)");
  });

  it("groups an older owner's largest kept checkouts by reason, largest first, without offering or inventing owners", async () => {
    const kept = sizedScan();
    // Scrambled on purpose: the order on screen is the dialog's.
    kept.hibernate!.coverage!.largestKept = [
      { path: "/w/c", reason: "Watching a PR", allocatedBytes: 30 * GB },
      { path: "/w/unknown", reason: "Other ignored files" },
      { path: "/w/a", reason: "Active in the last 3 days", allocatedBytes: 90 * GB },
      { path: "/w/e", reason: "Kept awake", allocatedBytes: 4 * GB },
      { path: "/w/b", reason: "Other ignored files", allocatedBytes: 41 * GB },
      { path: "/w/f", reason: "Shared checkout", allocatedBytes: 2 * GB },
      { path: "/w/d", reason: "Running or blocked", allocatedBytes: 12 * GB },
    ];
    const { api: desktopApi } = api({ scanThreadMaintenance: vi.fn(async () => kept) });
    render(<ThreadMaintenanceDialog desktopApi={desktopApi} onClose={vi.fn()} onOpenThread={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "Thread maintenance" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Scan" }));
    const section = await within(dialog).findByRole("region", { name: "Kept checkouts" });
    expect(section).toHaveTextContent("Largest kept");
    expect(section).toHaveTextContent("This scan sent only the largest, without their threads.");
    // Oracle, sorted by hand: groups by what they hold, rows largest first, unmeasured last.
    const groups = within(section).getAllByRole("list").map((list) => [
      list.getAttribute("aria-label"),
      ...within(list).getAllByRole("listitem").map((row) => row.textContent),
    ]);
    expect(groups).toEqual([
      ["Kept: Active in the last 3 days", "/w/a90 GB"],
      ["Kept: Other ignored files", "/w/b41 GB", "/w/unknown—"],
      ["Kept: Watching a PR", "/w/c30 GB"],
      ["Kept: Running or blocked", "/w/d12 GB"],
      ["Kept: Kept awake", "/w/e4.0 GB"],
      ["Kept: Shared checkout", "/w/f2.0 GB"],
    ]);
    // Nothing to select, and no thread the owner did not name.
    expect(within(section).queryByRole("checkbox")).toBeNull();
    expect(within(section).queryByRole("button", { name: /^Open thread/ })).toBeNull();
    expect(section).not.toHaveTextContent("Thread not identified in this scan");
  });

  it("says what a checking step is doing beside the items in flight", () => {
    const { api: desktopApi, emitProgress } = api({
      scanThreadMaintenance: vi.fn(() => new Promise<ThreadMaintenanceScan>(() => {})),
    });
    render(<ThreadMaintenanceDialog desktopApi={desktopApi} onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "Thread maintenance" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Scan" }));
    const progressId = vi.mocked(desktopApi.scanThreadMaintenance!).mock.calls[0]![0]!.progressId!;
    emitProgress({ progressId, steps: ["hibernate"], step: "hibernate", stage: "checking", processed: 4, total: 9,
      inFlight: ["/w/a", "/w/b"], detail: "Measuring allocation" });
    expect(within(dialog).getByText("Measuring allocation · now: /w/a · /w/b")).toBeInTheDocument();
  });

  it("folds a long root list after the five largest roots", async () => {
    const many = sizedScan();
    many.hibernate!.coverage!.roots = Array.from({ length: 7 }, (_, index) => ({
      path: `/repos/project-${index}/.worktrees`, owner: "other" as const, checkouts: 1, allocatedBytes: (index + 1) * GB,
    }));
    const { api: desktopApi } = api({ scanThreadMaintenance: vi.fn(async () => many) });
    render(<ThreadMaintenanceDialog desktopApi={desktopApi} onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "Thread maintenance" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Scan" }));
    const coverage = await within(dialog).findByRole("region", { name: "What the scan read" });
    expect(coverage).toHaveTextContent("Scanned 7 roots · 7 checkouts · 28 GB on disk");
    const paths = () => within(coverage).getAllByRole("listitem").map((row) => row.firstElementChild?.textContent);
    expect(paths()).toEqual([6, 5, 4, 3, 2].map((index) => `/repos/project-${index}/.worktrees`));
    fireEvent.click(within(coverage).getByRole("button", { name: "2 more roots · 3.0 GB" }));
    expect(paths()).toHaveLength(7);
  });

  it("finishes with kept rows grouped by reason, largest group first", async () => {
    const { api: desktopApi, emitRun } = api();
    render(<ThreadMaintenanceDialog desktopApi={desktopApi} onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "Thread maintenance" });
    fireEvent.click(within(dialog).getByRole("radio", { name: "Idle checkouts" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Scan" }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "Hibernate 4 checkouts" }));
    const kept: ThreadMaintenanceProblem[] = [
      ...Array.from({ length: 4 }, (_, index) => ({ step: "hibernate" as const, kind: "kept" as const,
        object: `Probe ${index}`, reason: "No worktree checkout", backend: "grok", threadId: `g-${index}` })),
      ...Array.from({ length: 18 }, (_, index) => ({ step: "hibernate" as const, kind: "kept" as const,
        object: `Thread ${index}`, reason: "Checkout missing", detail: "The folder was already gone.",
        backend: "codex", threadId: `c-${index}`, bytes: 1 * GB })),
    ];
    emitRun({
      runId: "run-1", revision: 2, scanId: "scan-1", running: false, startedAt: NOW, finishedAt: NOW + 60_000,
      steps: [{ step: "hibernate", ran: true, done: 13, kept: 22, failed: 0, allocatedBytesRemoved: 18 * GB }],
      problems: kept,
    });
    expect(await within(dialog).findByText(/13 checkouts hibernated \(18 GB allocation removed\)/)).toBeInTheDocument();
    const card = within(dialog).getByRole("region", { name: "22 checkouts kept" });
    const groups = within(card).getAllByRole("list").slice(1);
    expect(groups.map((list) => list.getAttribute("aria-label"))).toEqual(["Checkout missing", "No worktree checkout"]);
    // A detail every row in a group shares is said once, in its heading.
    expect(card).toHaveTextContent("Checkout missing · 18 · 18 GB on disk · The folder was already gone.");
    expect(within(card).getAllByText(/The folder was already gone/)).toHaveLength(1);
    // A long group shows three rows until asked for all of them.
    expect(within(groups[0]!).getAllByRole("listitem")).toHaveLength(3);
    fireEvent.click(within(card).getByRole("button", { name: "Show all 18" }));
    expect(within(groups[0]!).getAllByRole("listitem")).toHaveLength(18);
    // Each group folds on its own.
    expect(within(groups[1]!).getAllByRole("listitem")).toHaveLength(3);
    expect(within(card).getByRole("button", { name: "Show all 4" })).toHaveAttribute("aria-expanded", "false");
  });
});
