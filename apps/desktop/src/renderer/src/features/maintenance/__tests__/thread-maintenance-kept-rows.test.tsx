import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadMaintenanceKeptCheckout, ThreadMaintenanceScan } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { ThreadMaintenanceDialog } from "../ThreadMaintenanceDialog";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const NOW = new Date(2026, 10, 7, 11, 0).getTime();
const DAY = 86_400_000;
const GB = 1024 ** 3;

const watched: ThreadMaintenanceKeptCheckout = {
  path: "/home/.pwragent/worktrees/m3x9/kiln", reason: "Watching a PR", allocatedBytes: 48 * GB,
  threads: [{ backend: "codex", threadId: "t-kiln", title: "Port the renderer to Rust", branch: "kiln/rust-renderer",
    lastActivityAt: NOW - 2 * DAY,
    pullRequests: [
      { url: "https://forge.example/acme/kiln/pull/412", number: 412, title: "Port the renderer to Rust" },
      { url: "javascript:alert(1)", number: 9 },
    ] }],
};
const shared: ThreadMaintenanceKeptCheckout = {
  path: "/home/.codex/worktrees/q1/harbor-web", reason: "Recently active", allocatedBytes: 31 * GB,
  threads: [
    { backend: "codex", threadId: "t-harbor", title: "Tune the search ranking", lastActivityAt: NOW - DAY },
    { backend: "codex", threadId: "t-harbor-child", title: "Check the ranking fixtures", lastActivityAt: NOW - 3 * DAY },
  ],
};
const unowned: ThreadMaintenanceKeptCheckout = { path: "/home/.codex/worktrees/z0/ledger", reason: "Recently active", allocatedBytes: 2 * GB };

function scan(): ThreadMaintenanceScan {
  // Twelve more than the ten an older owner could send, so every row must be reachable.
  const more = Array.from({ length: 12 }, (_, index): ThreadMaintenanceKeptCheckout => ({
    path: `/home/.codex/worktrees/b${index}/grok-build`, reason: "Recently active", allocatedBytes: (index + 1) * 100 * 1024 ** 2,
    threads: [{ backend: "codex", threadId: `t-more-${index}`, title: `Grok task ${index}` }],
  }));
  return {
    scanId: "scan-1", startedAt: NOW, finishedAt: NOW,
    rules: { mode: "count", keepPerProject: 20, inactivityDays: 7, rebuildableOutputIsClean: true },
    spaceSource: "filesystem",
    threads: { checked: 0, projects: [], kept: {} },
    checkouts: { items: [], kept: {}, emptyFolders: 0, buildOutputs: [] },
    hibernate: {
      idleDays: 7, maxSnapshotMb: 100, removeRebuildableOutput: false, checked: 15, items: [], notIdleYet: 0,
      kept: { "Watching a PR": 1, "Recently active": 14 },
      coverage: {
        roots: [{ path: "/home/.codex/worktrees", owner: "codex", checkouts: 15 }],
        largestKept: [watched],
        keptCheckouts: [unowned, shared, ...more, watched],
      },
    },
    expired: { enabled: false, retentionDays: 0 },
    failures: [],
  };
}

async function openReview(onOpenThread = vi.fn()) {
  const desktopApi = {
    scanThreadMaintenance: vi.fn(async () => scan()),
    getThreadMaintenanceRun: vi.fn(async () => null),
    onThreadMaintenanceRunChanged: vi.fn(() => () => {}),
  } as unknown as DesktopApi;
  render(<ThreadMaintenanceDialog desktopApi={desktopApi} onClose={vi.fn()} onOpenThread={onOpenThread} />);
  const dialog = screen.getByRole("dialog", { name: "Thread maintenance" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Scan" }));
  const section = await within(dialog).findByRole("region", { name: "Kept checkouts" });
  return { dialog, section, onOpenThread };
}

describe("kept checkouts a person can act on", () => {
  it("leads with each owner's title, branch, activity and PR, the path after", async () => {
    const { section } = await openReview();
    expect(section).toHaveTextContent("Kept · 15 checkouts");
    const group = within(section).getByRole("list", { name: "Kept: Watching a PR" });
    const row = within(group).getByRole("listitem");
    expect(within(row).getByText("Port the renderer to Rust", { selector: ".thread-maintenance__row-title" })).toBeInTheDocument();
    expect(row).toHaveTextContent("codex · kiln/rust-renderer · last work 2 days ago");
    // Only the web link is offered.
    const links = within(row).getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["https://forge.example/acme/kiln/pull/412"]);
    expect(row.querySelector(".thread-maintenance__path")?.textContent).toBe(watched.path);
    expect(section).toHaveTextContent("Wakes this thread");
  });

  it("opens the PR through the app's external link path, not in the window", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const { section } = await openReview();
    fireEvent.click(within(section).getByRole("link", { name: "PR #412" }));
    expect(open).toHaveBeenCalledWith("https://forge.example/acme/kiln/pull/412", "_blank", "noopener,noreferrer");
  });

  it("opens each owner's thread, and says a shared checkout stays while any owner keeps it", async () => {
    const { section, onOpenThread } = await openReview();
    const group = within(section).getByRole("list", { name: "Kept: Recently active" });
    expect(section).toHaveTextContent("Worked in or restored within the last 7 days, this scan's idle threshold");
    const sharedRow = within(group).getAllByRole("listitem")[0]!;
    expect(sharedRow).toHaveTextContent("Shared by 2 threads. Any one of them can keep it, so it stays until none does.");
    fireEvent.click(within(sharedRow).getByRole("button", { name: "Open thread Check the ranking fixtures" }));
    expect(onOpenThread).toHaveBeenCalledWith({ backend: "codex", threadId: "t-harbor-child" });
    expect(section).toHaveTextContent("resolving one thread may leave another keeping it");
  });

  it("lets every sent checkout be inspected, and invents no owner for one without", async () => {
    const { section } = await openReview();
    const group = within(section).getByRole("list", { name: "Kept: Recently active" });
    expect(within(group).getAllByRole("listitem")).toHaveLength(3);
    fireEvent.click(within(section).getByRole("button", { name: "Show all 14" }));
    const rows = within(group).getAllByRole("listitem");
    expect(rows).toHaveLength(14);
    const last = rows.find((row) => row.textContent?.includes(unowned.path))!;
    expect(last).toHaveTextContent("Thread not identified in this scan");
    expect(within(last).queryByRole("button")).toBeNull();
    expect(within(section).queryByRole("checkbox")).toBeNull();
  });

  it("says Cargo output in a kept checkout is reviewed on its own", async () => {
    const { section } = await openReview();
    expect(section).toHaveTextContent("Cargo output inside a kept checkout is reviewed on its own, in the Archived checkouts step.");
  });
});
