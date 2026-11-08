import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DesktopSettingsSnapshot,
  ThreadMaintenanceRun,
  ThreadMaintenanceScan,
} from "@pwragent/shared";
import type { DesktopApi } from "../lib/desktop-api";
import { App } from "../App";

// The real dialog inside the real App: what this pins is the session's
// lifecycle across minimize, Open thread, File → Thread Maintenance…, and a
// scan or run that ends while the dialog is hidden.

afterEach(() => {
  cleanup();
  delete (window as Window & { pwragent?: DesktopApi }).pwragent;
});

const NOW = new Date(2026, 10, 7, 11, 0).getTime();
const GB = 1024 ** 3;

function scan(): ThreadMaintenanceScan {
  return {
    scanId: "scan-1", startedAt: NOW, finishedAt: NOW,
    rules: { mode: "count", keepPerProject: 20, inactivityDays: 7, rebuildableOutputIsClean: true },
    spaceSource: "filesystem",
    threads: { checked: 0, projects: [], kept: {} },
    checkouts: { items: [], kept: {}, emptyFolders: 0, buildOutputs: [
      { kind: "cargo", checkoutPath: "/home/.pwragent/worktrees/m3x9/kiln", outputPath: "/home/.pwragent/worktrees/m3x9/kiln/target/debug",
        manifestPath: "/home/.pwragent/worktrees/m3x9/kiln/Cargo.toml", space: { allocatedBytes: 9 * GB },
        threads: [{ backend: "codex", threadId: "t-kiln", title: "Port the renderer to Rust" }] },
    ] },
    hibernate: {
      idleDays: 7, maxSnapshotMb: 100, removeRebuildableOutput: false, checked: 2, notIdleYet: 0,
      kept: { "Watching a PR": 1 },
      items: [{ backend: "codex", threadId: "t-idle", title: "Tidy the README", worktreePath: "/home/.codex/worktrees/a1/harbor-docs",
        lastActivityAt: NOW - 20 * 86_400_000, files: 0, bytes: 0, space: { allocatedBytes: GB } }],
      coverage: {
        roots: [{ path: "/home/.codex/worktrees", owner: "codex", checkouts: 2 }],
        keptCheckouts: [{ path: "/home/.pwragent/worktrees/m3x9/kiln", reason: "Watching a PR", allocatedBytes: 48 * GB,
          threads: [{ backend: "codex", threadId: "t-kiln", title: "Port the renderer to Rust" }] }],
      },
    },
    expired: { enabled: false, retentionDays: 0 },
    failures: [],
  };
}

function installDesktopApi() {
  let openListener: ((request: { projectKey?: string }) => void) | undefined;
  const runListeners = new Set<(run: ThreadMaintenanceRun) => void>();
  let resolveScan: ((value: ThreadMaintenanceScan) => void) | undefined;
  const scanThreadMaintenance = vi.fn(() => new Promise<ThreadMaintenanceScan>((resolve) => { resolveScan = resolve; }));
  const applyThreadMaintenance = vi.fn(async (): Promise<ThreadMaintenanceRun> => ({
    runId: "run-1", revision: 1, scanId: "scan-1", running: true, startedAt: NOW, steps: [], problems: [],
    current: { step: "hibernate", processed: 0, total: 1 },
  }));
  Object.defineProperty(window, "pwragent", {
    configurable: true,
    value: {
      readSettings: async () => ({
        snapshot: {
          general: {
            appearance: {
              theme: { value: "system", source: "default" },
              darkTheme: { value: "tangerine-dark", source: "default" },
              lightTheme: { value: "tangerine-light", source: "default" },
              themedDockIcon: { value: true, source: "default" },
              terminalMinimumContrast: { value: false, source: "default" },
              calmMotion: { value: false, source: "default" },
              density: { value: "mission-control", source: "default" },
              sidebarTextSize: { value: "md", source: "default" },
              transcriptTextSize: { value: "md", source: "default" },
            },
          },
          onboarding: { completed: { value: true, source: "default" } },
          imageUploads: { pastedImageMaxPatches: { value: 1536, source: "default" } },
          experimental: { fullAccessRiskWarningDismissed: { value: false, source: "default" } },
        } as DesktopSettingsSnapshot,
      }),
      onAgentEvent: () => () => undefined,
      scanThreadMaintenance,
      applyThreadMaintenance,
      getThreadMaintenanceRun: vi.fn(async () => null),
      onThreadMaintenanceRunChanged: (callback: (run: ThreadMaintenanceRun) => void) => {
        runListeners.add(callback);
        return () => { runListeners.delete(callback); };
      },
      onOpenThreadMaintenanceRequested: (next: (request: { projectKey?: string }) => void) => {
        openListener = next;
        return () => { openListener = undefined; };
      },
    } as Partial<DesktopApi>,
  });
  return {
    scanThreadMaintenance,
    applyThreadMaintenance,
    /** File → Thread Maintenance…, or Settings → Review… with a project. */
    launch: async (request: { projectKey?: string } = {}) => {
      await waitFor(() => expect(openListener).toBeDefined());
      await act(async () => {
        openListener?.(request);
        await Promise.resolve();
      });
    },
    finishScan: async () => {
      await act(async () => {
        resolveScan?.(scan());
        await Promise.resolve();
      });
    },
    emitRun: (run: ThreadMaintenanceRun) => {
      act(() => { for (const listener of runListeners) listener(run); });
    },
  };
}

const dialog = () => screen.queryByRole("dialog", { name: "Thread maintenance" });
const notice = () => screen.queryByText("Thread maintenance", { selector: ".app-notice-toast *" })?.closest<HTMLElement>(".app-notice-toast") ?? null;

async function openAndPick(api: ReturnType<typeof installDesktopApi>) {
  render(<App />);
  await api.launch();
  const shown = await screen.findByRole("dialog", { name: "Thread maintenance" });
  fireEvent.click(within(shown).getByRole("radio", { name: "Idle checkouts" }));
  return shown;
}

describe("thread maintenance session in App", () => {
  it("keeps an edited plan through minimize and File → Thread Maintenance…", async () => {
    const api = installDesktopApi();
    const shown = await openAndPick(api);
    fireEvent.click(within(shown).getByRole("button", { name: "Minimise thread maintenance" }));
    // Hidden, and so not a dialog to assistive tech or the focus trap.
    expect(dialog()).toBeNull();
    expect(notice()).toHaveTextContent("Your plan is kept");

    // Settings → Review… names a project; the open session still wins.
    await api.launch({ projectKey: "/src/harbor-web" });
    const reopened = await screen.findByRole("dialog", { name: "Thread maintenance" });
    expect(within(reopened).getByRole("radio", { name: "Idle checkouts" })).toBeChecked();
    expect(notice()).toBeNull();
  });

  it("minimizes on Escape instead of discarding the session", async () => {
    const api = installDesktopApi();
    const shown = await openAndPick(api);
    fireEvent.keyDown(shown, { key: "Escape" });
    expect(dialog()).toBeNull();
    await api.launch();
    expect(within(await screen.findByRole("dialog", { name: "Thread maintenance" })).getByRole("radio", { name: "Idle checkouts" }))
      .toBeChecked();
  });

  it("lands a scan that finishes while minimized in the same session, and Open thread keeps the review", async () => {
    const api = installDesktopApi();
    const shown = await openAndPick(api);
    fireEvent.click(within(shown).getByRole("button", { name: "Scan" }));
    fireEvent.click(within(shown).getByRole("button", { name: "Minimise thread maintenance" }));
    expect(notice()).toHaveTextContent("Scanning");
    // A scan in flight cannot be discarded from the notice, and closing the
    // notice only hides it.
    expect(within(notice()!).queryByRole("button", { name: "Discard" })).toBeNull();
    fireEvent.click(within(notice()!).getByRole("button", { name: /^Hide this notice/ }));
    expect(notice()).toBeNull();

    await api.finishScan();
    // The finished scan brings the notice back.
    await waitFor(() => expect(notice()).toHaveTextContent("Review ready · 1 found"));
    fireEvent.click(within(notice()!).getByRole("button", { name: "Reopen" }));
    const review = await screen.findByRole("dialog", { name: "Thread maintenance" });
    const kept = within(review).getByRole("region", { name: "Kept checkouts" });

    fireEvent.click(within(kept).getByRole("button", { name: "Open thread Port the renderer to Rust" }));
    expect(dialog()).toBeNull();
    expect(notice()).toHaveTextContent("Review ready");

    await api.launch();
    const back = await screen.findByRole("dialog", { name: "Thread maintenance" });
    expect(within(back).getByRole("region", { name: "Kept checkouts" })).toBeInTheDocument();
    expect(within(back).getByRole("checkbox", { name: /Tidy the README/ })).toBeChecked();
    expect(api.scanThreadMaintenance).toHaveBeenCalledOnce();
  });

  it("keeps a picked build output through Open thread from its row and File → Thread Maintenance…", async () => {
    const api = installDesktopApi();
    render(<App />);
    await api.launch();
    const shown = await screen.findByRole("dialog", { name: "Thread maintenance" });
    fireEvent.click(within(shown).getByRole("radio", { name: "Archived checkouts" }));
    fireEvent.click(within(shown).getByRole("button", { name: "Scan" }));
    await api.finishScan();
    const outputs = await within(shown).findByRole("region", { name: "Build output" });
    fireEvent.click(within(outputs).getByRole("checkbox", { name: "Clean /home/.pwragent/worktrees/m3x9/kiln/target/debug" }));
    fireEvent.click(within(outputs).getByRole("button", { name: "Open thread Port the renderer to Rust" }));
    expect(dialog()).toBeNull();
    expect(notice()).toHaveTextContent("Review ready");

    await api.launch();
    const back = await screen.findByRole("dialog", { name: "Thread maintenance" });
    expect(within(within(back).getByRole("region", { name: "Build output" }))
      .getByRole("checkbox", { name: "Clean /home/.pwragent/worktrees/m3x9/kiln/target/debug" })).toBeChecked();
    expect(api.scanThreadMaintenance).toHaveBeenCalledOnce();
  });

  it("shows a run that finished while minimized when it is reopened", async () => {
    const api = installDesktopApi();
    const shown = await openAndPick(api);
    fireEvent.click(within(shown).getByRole("button", { name: "Scan" }));
    await api.finishScan();
    fireEvent.click(await within(shown).findByRole("button", { name: "Hibernate 1 checkout" }));
    await waitFor(() => expect(api.applyThreadMaintenance).toHaveBeenCalledOnce());
    await within(shown).findByRole("button", { name: "Stop after this item" });
    fireEvent.click(within(shown).getByRole("button", { name: "Minimise thread maintenance" }));
    expect(within(notice()!).queryByRole("button", { name: "Discard" })).toBeNull();

    api.emitRun({ runId: "run-1", revision: 2, scanId: "scan-1", running: false, startedAt: NOW, finishedAt: NOW + 1000,
      steps: [{ step: "hibernate", ran: true, done: 1, kept: 0, failed: 0 }], problems: [] });
    await waitFor(() => expect(notice()).toHaveTextContent("Finished · 1 checkout hibernated"));
    fireEvent.click(within(notice()!).getByRole("button", { name: "Reopen" }));
    expect(await screen.findByRole("dialog", { name: "Thread maintenance" })).toHaveTextContent("1 checkout hibernated");
  });

  it("starts over only after an explicit discard", async () => {
    const api = installDesktopApi();
    const shown = await openAndPick(api);
    fireEvent.click(within(shown).getByRole("button", { name: "Minimise thread maintenance" }));
    fireEvent.click(within(notice()!).getByRole("button", { name: "Discard" }));
    expect(notice()).toBeNull();
    await api.launch();
    const fresh = await screen.findByRole("dialog", { name: "Thread maintenance" });
    expect(within(fresh).getByRole("radio", { name: "Combined" })).toBeChecked();
  });
});
