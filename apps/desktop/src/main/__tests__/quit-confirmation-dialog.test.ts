import { afterEach, describe, expect, it, vi } from "vitest";

type FakeDialogWindow = {
  /** Listeners the dialog registers, so tests can fire `ready-to-show` / `closed`. */
  listeners: Map<string, (...args: unknown[]) => void>;
  destroyed: boolean;
  minimized: boolean;
  shown: number;
  focused: number;
  restored: number;
  closed: number;
  once: (event: string, handler: (...args: unknown[]) => void) => void;
  webContents: {
    executeJavaScript: (script: string) => Promise<void>;
    on: () => void;
    setWindowOpenHandler: () => void;
  };
  /** The data: URL the dialog loaded, so tests can read the page it built. */
  loadedUrl?: string;
  /** Stays pending unless a test settles it — the real load is async too. */
  loadURL: (url: string) => Promise<void>;
  rejectLoad: (error: Error) => void;
  isDestroyed: () => boolean;
  isMinimized: () => boolean;
  restore: () => void;
  show: () => void;
  focus: () => void;
  close: () => void;
};

function createFakeDialogWindow(): FakeDialogWindow {
  let rejectLoad!: (error: Error) => void;
  const loaded = new Promise<void>((_resolve, reject) => {
    rejectLoad = reject;
  });
  const window: FakeDialogWindow = {
    listeners: new Map(),
    destroyed: false,
    minimized: false,
    shown: 0,
    focused: 0,
    restored: 0,
    closed: 0,
    once: (event, handler) => {
      window.listeners.set(event, handler);
    },
    webContents: {
      executeJavaScript: vi.fn(async () => undefined),
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    },
    loadURL: (url: string) => {
      window.loadedUrl = url;
      return loaded;
    },
    rejectLoad: (error) => rejectLoad(error),
    isDestroyed: () => window.destroyed,
    isMinimized: () => window.minimized,
    restore: () => {
      window.minimized = false;
      window.restored += 1;
    },
    show: () => {
      window.shown += 1;
    },
    focus: () => {
      window.focused += 1;
    },
    close: () => {
      window.closed += 1;
      window.destroyed = true;
    },
  };
  return window;
}

const dialogWindows: FakeDialogWindow[] = [];

function sendDialogAction(window: FakeDialogWindow, action: string): void {
  const on = window.webContents.on as unknown as {
    mock: { calls: Array<[string, (event: unknown, url: string) => void]> };
  };
  const willNavigate = on.mock.calls.find(
    ([event]) => event === "will-navigate",
  )?.[1];
  if (!willNavigate) throw new Error("dialog registered no will-navigate handler");
  const prefix = /pwragent-quit-confirmation:\/\/[^/]+\//.exec(
    decodeURIComponent(window.loadedUrl ?? ""),
  )?.[0];
  if (!prefix) throw new Error("dialog page carries no navigation prefix");
  willNavigate({ preventDefault: vi.fn() }, `${prefix}${action}`);
}

/** The app's own windows, as the dialog's parent lookup sees them. */
const electronWindows = vi.hoisted(() => ({
  focused: null as unknown,
  fromWebContents: vi.fn((_contents: unknown): unknown => null),
}));

const dialogPlacement = vi.hoisted(() => ({
  cursorDisplayArea: { x: 0, y: 0, width: 1440, height: 900 },
  parentDisplayArea: { x: 0, y: 0, width: 1440, height: 900 },
}));

vi.mock("electron", () => ({
  app: { focus: vi.fn() },
  // `new BrowserWindow(...)`: an arrow function is not constructible.
  BrowserWindow: Object.assign(
    vi.fn(function BrowserWindowMock() {
      const window = createFakeDialogWindow();
      dialogWindows.push(window);
      return window;
    }),
    {
      getFocusedWindow: () => electronWindows.focused,
      fromWebContents: electronWindows.fromWebContents,
    },
  ),
  nativeTheme: { shouldUseDarkColors: true },
  screen: {
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => ({
      workArea: dialogPlacement.cursorDisplayArea,
    }),
    getDisplayMatching: () => ({
      workArea: dialogPlacement.parentDisplayArea,
    }),
  },
}));

vi.mock("../primary-main-window", () => ({
  primaryMainWindowWebContents: vi.fn(() => undefined),
}));

vi.mock("../log", () => ({
  getMainLogger: () => ({ info: vi.fn(), warn: vi.fn() }),
}));

vi.mock("../ipc/integrated-terminal", () => ({
  revealIntegratedTerminal: vi.fn(),
}));

vi.mock("../window-show-thread", () => ({
  requestShowThread: vi.fn(),
}));

vi.mock("../window-show-quit-blockers", () => ({
  requestShowQuitBlockers: vi.fn(),
}));

vi.mock("../settings/appearance-bootstrap", () => ({
  readBootstrapAppearance: () => ({ theme: "dark" }),
}));

import { app, BrowserWindow, type WebContents } from "electron";
import { parseThreadIdentityKey } from "@pwragent/shared";
import { primaryMainWindowWebContents } from "../primary-main-window";
import { revealIntegratedTerminal } from "../ipc/integrated-terminal";
import { requestShowThread } from "../window-show-thread";
import { requestShowQuitBlockers } from "../window-show-quit-blockers";
import {
  focusActiveQuitConfirmationDialog,
  formatQuitItemAction,
  parseQuitItemAction,
  showQuitConfirmationDialog,
  type QuitBlockerItem,
} from "../quit-confirmation-dialog";

it("announces the actual scaled deadline and reports countdown pauses", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  try {
    const changed = vi.fn();
    const pending = showQuitConfirmationDialog({
      countdownSeconds: 10, federationPeerCount: 2, onCountdownChanged: changed,
      inProgressThreadCount: 0, terminalSessionCount: 0,
    });
    const window = dialogWindows.at(-1)!;
    expect(changed).toHaveBeenCalledWith(11_000);
    const html = decodeURIComponent(window.loadedUrl!);
    expect(html).toContain("2 connected peers will lose access");
    expect(html).toContain("Work on other machines may continue");
    expect(html).not.toContain('id="wait"');
    sendDialogAction(window, "countdown-cancel");
    expect(changed).toHaveBeenLastCalledWith(null);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(window.closed).toBe(0);
    sendDialogAction(window, "manual-confirm");
    await expect(pending).resolves.toBe("manual-confirm");
  } finally { vi.useRealTimers(); }
});

describe("quit dialog row links", () => {
  it("round-trips a codex thread key", () => {
    const item: QuitBlockerItem = {
      kind: "terminal",
      backend: "codex",
      threadId: "thread-1",
      threadKey: "codex:thread-1",
    };

    expect(parseQuitItemAction(formatQuitItemAction(item))).toEqual({
      threadKey: "codex:thread-1",
      kind: "terminal",
    });
  });

  // The whole reason the key travels as one segment: an ACP backend kind
  // contains a colon, so splitting the action on delimiters would hand the
  // terminal registry a key it does not have and the reveal would silently
  // no-op.
  it("round-trips an ACP thread key whose backend contains a colon", () => {
    const item: QuitBlockerItem = {
      kind: "terminal",
      backend: "acp:grok",
      threadId: "thread-2",
      threadKey: "acp:grok:thread-2",
    };

    const parsed = parseQuitItemAction(formatQuitItemAction(item));

    expect(parsed).toEqual({
      threadKey: "acp:grok:thread-2",
      kind: "terminal",
    });
    // And the key the dialog hands back still resolves to the real backend.
    expect(parseThreadIdentityKey(parsed!.threadKey)).toEqual({
      backend: "acp:grok",
      threadId: "thread-2",
    });
  });

  // A thread key does not identify a thread across instances, so a peer's row
  // and a same-keyed local row would otherwise encode to the same action and
  // the click could not tell them apart.
  it("round-trips the owning instance for a remote row", () => {
    const item: QuitBlockerItem = {
      kind: "terminal",
      backend: "codex",
      threadId: "thread-3",
      threadKey: "codex:thread-3",
      target: { scope: "remote", instanceId: "peer-a" },
    };

    expect(parseQuitItemAction(formatQuitItemAction(item))).toEqual({
      threadKey: "codex:thread-3",
      kind: "terminal",
      instanceId: "peer-a",
    });

    // A local row carries no instance, and must not grow one.
    expect(
      parseQuitItemAction(formatQuitItemAction({ ...item, target: undefined })),
    ).toEqual({ threadKey: "codex:thread-3", kind: "terminal" });
  });

  it("ignores actions that are not row links", () => {
    expect(parseQuitItemAction("manual-confirm")).toBeUndefined();
    expect(parseQuitItemAction("countdown-cancel")).toBeUndefined();
  });
});

/**
 * Once the countdown is cancelled — which any deliberate interaction does, for
 * good — the only thing that settles the quit is the user answering this
 * dialog. So the dialog has to remain reachable: a repeat quit request asks the
 * quit manager to raise it, and a dialog that has already been answered must
 * not report itself as raisable.
 *
 * The subject holds the open dialog in module state, so each test here has to
 * leave it empty for the next one — see the `afterEach`.
 */
describe("raising the open quit dialog", () => {
  /** Open a dialog and drive it to the state a user would see it in. */
  function openDialog(options?: { ready?: boolean }) {
    const pending = showQuitConfirmationDialog({
      countdownSeconds: 10,
      inProgressThreadCount: 0,
      terminalSessionCount: 1,
    });
    const window = dialogWindows.at(-1)!;
    if (options?.ready ?? true) {
      window.listeners.get("ready-to-show")?.();
    }
    return { pending, window };
  }

  afterEach(async () => {
    // Close anything still open so module state does not leak into the next
    // test, then drop the fakes this test created.
    for (const window of dialogWindows) {
      if (!window.destroyed) {
        window.listeners.get("closed")?.();
      }
    }
    await Promise.resolve();
    dialogWindows.length = 0;
  });

  it("reports nothing to raise when no dialog is open", () => {
    expect(focusActiveQuitConfirmationDialog()).toBe(false);
  });

  it("restores, shows, and focuses the dialog that is on screen", async () => {
    const { pending, window } = openDialog();
    // `ready-to-show` shows and focuses it once; a raise is the second of each.
    window.minimized = true;

    expect(focusActiveQuitConfirmationDialog()).toBe(true);
    expect(window.restored).toBe(1);
    expect(window.shown).toBe(2);
    expect(window.focused).toBe(2);

    // Answering it clears the handle: a later request must not try to raise a
    // window that is gone.
    window.listeners.get("closed")?.();
    await expect(pending).resolves.toBe("manual-cancel");
    expect(focusActiveQuitConfirmationDialog()).toBe(false);
  });

  // The window is created hidden. Showing it before its first paint puts a
  // themed empty rectangle on screen, and its own `ready-to-show` handler is
  // about to show it anyway — so report the prompt as open and leave it alone.
  it("does not show a dialog that has not painted yet", async () => {
    const { pending, window } = openDialog({ ready: false });

    expect(focusActiveQuitConfirmationDialog()).toBe(true);
    expect(window.shown).toBe(0);
    expect(window.focused).toBe(0);

    window.listeners.get("closed")?.();
    await expect(pending).resolves.toBe("manual-cancel");
  });

  // No page means no controls, so there is no consent left to collect and
  // nothing for the user to answer. Settle it rather than park an unusable
  // window on screen until the hard ceiling fires.
  it("settles the request when the dialog page fails to load", async () => {
    const pending = showQuitConfirmationDialog({
      countdownSeconds: 10,
      inProgressThreadCount: 0,
      terminalSessionCount: 1,
    });
    const window = dialogWindows.at(-1)!;
    window.rejectLoad(new Error("ERR_ABORTED"));

    await expect(pending).resolves.toBe("countdown-expired");
    expect(window.shown).toBe(0);
    expect(window.closed).toBe(1);
    expect(focusActiveQuitConfirmationDialog()).toBe(false);
  });

  // Once the page has painted the prompt is up and the decision is the user's.
  // A late rejection there is noise — a superseded navigation, say — and must
  // not quit out from under someone reading the list.
  it("leaves a painted dialog alone when a late load rejection arrives", async () => {
    const { pending, window } = openDialog();
    window.rejectLoad(new Error("ERR_ABORTED"));
    await Promise.resolve();

    expect(window.closed).toBe(0);
    expect(focusActiveQuitConfirmationDialog()).toBe(true);

    window.listeners.get("closed")?.();
    await expect(pending).resolves.toBe("manual-cancel");
  });

  it("reports finished work before completing the quit", async () => {
    vi.useFakeTimers();
    try {
      const pending = showQuitConfirmationDialog({
        countdownSeconds: 10,
        inProgressThreadCount: 0,
        automationRunCount: 1,
        terminalSessionCount: 0,
        items: [
          {
            kind: "automation",
            backend: "codex",
            threadId: "agent-thread-1",
            threadKey: "codex:agent-thread-1",
            title: "Search Bots",
            detail: "Started 8:29:31 PM",
          },
        ],
        refresh: async () => ({
          inProgressThreadCount: 0,
          automationRunCount: 0,
          terminalSessionCount: 0,
          actionRunCount: 0,
          items: [],
        }),
      });
      const window = dialogWindows.at(-1)!;
      window.listeners.get("ready-to-show")?.();
      sendDialogAction(window, "wait-for-work");

      await vi.advanceTimersByTimeAsync(0);

      expect(window.webContents.executeJavaScript).toHaveBeenCalledWith(
        expect.stringContaining("All running work finished"),
        true,
      );
      expect(decodeURIComponent(window.loadedUrl ?? "")).toContain(
        "Wait for Work",
      );
      expect(decodeURIComponent(window.loadedUrl ?? "")).toContain(
        'send("wait-for-work")',
      );
      expect(decodeURIComponent(window.loadedUrl ?? "")).toContain(
        "1 automation is running",
      );
      expect(decodeURIComponent(window.loadedUrl ?? "")).toContain(
        "Search Bots",
      );
      await vi.advanceTimersByTimeAsync(1_250);
      await expect(pending).resolves.toBe("work-completed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not quit when work finishes after interaction only cancelled the countdown", async () => {
    vi.useFakeTimers();
    try {
      const pending = showQuitConfirmationDialog({
        countdownSeconds: 10,
        inProgressThreadCount: 1,
        terminalSessionCount: 0,
        refresh: async () => ({
          inProgressThreadCount: 0,
          automationRunCount: 0,
          terminalSessionCount: 0,
          actionRunCount: 0,
          items: [],
        }),
      });
      const window = dialogWindows.at(-1)!;
      sendDialogAction(window, "countdown-cancel");
      window.listeners.get("ready-to-show")?.();

      await vi.advanceTimersByTimeAsync(2_000);

      expect(window.closed).toBe(0);
      window.listeners.get("closed")?.();
      await expect(pending).resolves.toBe("manual-cancel");
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels wait completion when new work appears during the grace period", async () => {
    vi.useFakeTimers();
    try {
      let refreshCount = 0;
      const pending = showQuitConfirmationDialog({
        countdownSeconds: 10,
        inProgressThreadCount: 1,
        terminalSessionCount: 0,
        refresh: async () => {
          refreshCount += 1;
          const active = refreshCount > 1;
          return {
            inProgressThreadCount: active ? 1 : 0,
            automationRunCount: 0,
            terminalSessionCount: 0,
            actionRunCount: 0,
            items: active
              ? [
                  {
                    kind: "turn" as const,
                    backend: "codex",
                    threadId: "new-thread",
                    threadKey: "codex:new-thread",
                  },
                ]
              : [],
          };
        },
      });
      const window = dialogWindows.at(-1)!;
      window.listeners.get("ready-to-show")?.();
      sendDialogAction(window, "wait-for-work");

      await vi.advanceTimersByTimeAsync(2_000);

      expect(refreshCount).toBeGreaterThan(1);
      expect(window.closed).toBe(0);
      window.listeners.get("closed")?.();
      await expect(pending).resolves.toBe("manual-cancel");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("clicking a quit dialog row", () => {
  afterEach(async () => {
    for (const window of dialogWindows) {
      if (!window.destroyed) {
        window.listeners.get("closed")?.();
      }
    }
    await Promise.resolve();
    dialogWindows.length = 0;
    vi.mocked(revealIntegratedTerminal).mockReset();
    vi.mocked(requestShowThread).mockReset();
    vi.mocked(requestShowQuitBlockers).mockReset();
  });

  /**
   * Fire the dialog's own `will-navigate` handler with a row action, using
   * the per-dialog navigation prefix the page was actually built with.
   */
  function clickRow(window: (typeof dialogWindows)[number], action: string) {
    sendDialogAction(window, action);
  }

  it("routes the show-thread request to the window that owns a remote terminal", async () => {
    const owner = { id: 11 } as unknown as WebContents;
    vi.mocked(revealIntegratedTerminal).mockReturnValue({
      revealed: true,
      owner,
    });
    vi.mocked(requestShowThread).mockReturnValue(owner);
    const item: QuitBlockerItem = {
      kind: "terminal",
      backend: "codex",
      threadId: "0f9c2b7a-remote",
      threadKey: "codex:0f9c2b7a-remote",
      sessionId: "term-remote",
      target: { scope: "remote", instanceId: "peer-a" },
    };
    const pending = showQuitConfirmationDialog({
      countdownSeconds: 10,
      inProgressThreadCount: 0,
      terminalSessionCount: 1,
      items: [item],
    });
    const window = dialogWindows.at(-1)!;
    window.listeners.get("ready-to-show")?.();

    clickRow(window, formatQuitItemAction(item));

    // The terminal, not the thread: the row the operator clicked names one
    // shell, and the peer can be running several on this thread.
    expect(revealIntegratedTerminal).toHaveBeenCalledWith("term-remote", {
      instanceId: "peer-a",
    });
    // The dialog is what has focus, so requestShowThread would otherwise fall
    // back to whichever window subscribed first — for a peer's terminal that
    // is a window with no such thread.
    expect(requestShowThread).toHaveBeenCalledWith(
      {
        backend: "codex",
        federationTarget: { scope: "remote", instanceId: "peer-a" },
        threadId: "0f9c2b7a-remote",
      },
      { preferWebContents: owner },
    );
    expect(requestShowQuitBlockers).toHaveBeenCalledWith(owner, {
      inProgressThreadCount: 0,
      automationRunCount: 0,
      terminalSessionCount: 1,
      actionRunCount: 0,
      items: [item],
    });
    await expect(pending).resolves.toBe("manual-cancel");
  });

  it("leaves a local terminal row on the ordinary broadcast path", async () => {
    vi.mocked(revealIntegratedTerminal).mockReturnValue({ revealed: true });
    const item: QuitBlockerItem = {
      kind: "terminal",
      backend: "codex",
      threadId: "local-thread",
      threadKey: "codex:local-thread",
      sessionId: "term-local",
    };
    const pending = showQuitConfirmationDialog({
      countdownSeconds: 10,
      inProgressThreadCount: 0,
      terminalSessionCount: 1,
      items: [item],
    });
    const window = dialogWindows.at(-1)!;
    window.listeners.get("ready-to-show")?.();

    clickRow(window, formatQuitItemAction(item));

    // The instance slot is written empty rather than omitted, so this local
    // terminal's id survives the round trip as an id and not as a peer.
    expect(revealIntegratedTerminal).toHaveBeenCalledWith("term-local", {});
    expect(requestShowThread).toHaveBeenCalledWith(
      { backend: "codex", threadId: "local-thread" },
      { preferWebContents: undefined },
    );
    expect(requestShowQuitBlockers).not.toHaveBeenCalled();
    await expect(pending).resolves.toBe("manual-cancel");
  });
});

/**
 * A window the dialog can attach to. Records the order of the calls that bring
 * it forward, because the parent has to be up before its sheet is.
 */
function createFakeParentWindow(
  bounds = { x: 2560, y: 120, width: 1600, height: 1000 },
) {
  const calls: string[] = [];
  const parent = {
    calls,
    minimized: false,
    webContents: { id: 1 },
    getBounds: () => bounds,
    isDestroyed: () => false,
    isMinimized: () => parent.minimized,
    restore: () => {
      parent.minimized = false;
      calls.push("restore");
    },
    show: () => {
      calls.push("show");
    },
    focus: () => {
      calls.push("focus");
    },
  };
  return parent;
}

describe("where the quit dialog opens", () => {
  const originalPlatform = process.platform;

  afterEach(async () => {
    for (const window of dialogWindows) {
      if (!window.destroyed) {
        window.listeners.get("closed")?.();
      }
    }
    await Promise.resolve();
    dialogWindows.length = 0;
    electronWindows.focused = null;
    electronWindows.fromWebContents.mockReset();
    electronWindows.fromWebContents.mockReturnValue(null);
    vi.mocked(primaryMainWindowWebContents).mockReturnValue(undefined);
    vi.mocked(BrowserWindow).mockClear();
    vi.mocked(app.focus).mockClear();
    dialogPlacement.parentDisplayArea = { x: 0, y: 0, width: 1440, height: 900 };
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  function openDialog() {
    const pending = showQuitConfirmationDialog({
      countdownSeconds: 10,
      inProgressThreadCount: 0,
      terminalSessionCount: 1,
    });
    const window = dialogWindows.at(-1)!;
    const constructorOptions = vi.mocked(BrowserWindow).mock.calls.at(-1)?.[0];
    return { pending, window, constructorOptions };
  }

  function useMainWindow(parent: ReturnType<typeof createFakeParentWindow>) {
    vi.mocked(primaryMainWindowWebContents).mockReturnValue(
      parent.webContents as unknown as WebContents,
    );
    electronWindows.fromWebContents.mockImplementation((contents: unknown) =>
      contents === parent.webContents ? parent : null,
    );
  }

  // A quit from the Dock, from Ctrl+C in the terminal running the app, or from
  // any moment another app has focus finds no focused PwrAgent window. The
  // dialog used to open unparented then, wherever the OS centred a new window,
  // which on a multi-monitor desk is often a screen nobody is looking at.
  it("attaches to the main window when no PwrAgent window has focus", async () => {
    // The main window sits on a second display, right of the primary one.
    dialogPlacement.parentDisplayArea = { x: 2560, y: 0, width: 2560, height: 1440 };
    const main = createFakeParentWindow();
    useMainWindow(main);

    const { pending, window, constructorOptions } = openDialog();

    expect(constructorOptions).toMatchObject({ parent: main, modal: true });
    // Centred over the main window, on the main window's display. macOS draws
    // a modal child as a sheet and ignores this; Windows and Linux do not.
    const width = constructorOptions?.width as number;
    const height = constructorOptions?.height as number;
    expect(constructorOptions?.x).toBe(2560 + Math.round((1600 - width) / 2));
    expect(constructorOptions?.y).toBe(120 + Math.round((1000 - height) / 2));

    window.listeners.get("closed")?.();
    await expect(pending).resolves.toBe("manual-cancel");
  });

  it("prefers the window the user is looking at over the main window", async () => {
    const main = createFakeParentWindow();
    const settings = createFakeParentWindow({ x: 0, y: 0, width: 900, height: 700 });
    useMainWindow(main);
    electronWindows.focused = settings;

    const { pending, window, constructorOptions } = openDialog();

    expect(constructorOptions).toMatchObject({ parent: settings, modal: true });

    window.listeners.get("closed")?.();
    await expect(pending).resolves.toBe("manual-cancel");
  });

  // The window the dialog belongs to may be minimized, hidden, or behind
  // another app. A sheet on a window nobody can see is as lost as a dialog on
  // the wrong monitor, so bring the parent up and the app forward first.
  it("raises the parent and activates the app before showing the dialog", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    const main = createFakeParentWindow();
    main.minimized = true;
    useMainWindow(main);

    const { pending, window } = openDialog();
    window.listeners.get("ready-to-show")?.();

    expect(app.focus).toHaveBeenCalledWith({ steal: true });
    expect(main.calls).toEqual(["restore", "show"]);
    expect(window.shown).toBe(1);
    expect(window.focused).toBe(1);

    // A repeat quit request raises the open prompt the same way.
    main.minimized = true;
    expect(focusActiveQuitConfirmationDialog()).toBe(true);
    expect(main.calls).toEqual(["restore", "show", "restore", "show"]);
    expect(window.shown).toBe(2);

    window.listeners.get("closed")?.();
    await expect(pending).resolves.toBe("manual-cancel");
  });

  // On Windows and Linux app.focus() focuses the first window, which would
  // pull an unrelated window over the one the dialog is attached to.
  it("does not ask for app focus off macOS", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const main = createFakeParentWindow();
    useMainWindow(main);

    const { pending, window } = openDialog();
    window.listeners.get("ready-to-show")?.();

    expect(app.focus).not.toHaveBeenCalled();
    expect(main.calls).toEqual(["show"]);

    window.listeners.get("closed")?.();
    await expect(pending).resolves.toBe("manual-cancel");
  });

  // With no window at all to attach to, open where the pointer is: that is the
  // screen the user is on.
  it("opens on the pointer's display when there is no window to attach to", async () => {
    dialogPlacement.cursorDisplayArea = { x: -1920, y: 0, width: 1920, height: 1080 };
    try {
      const { pending, window, constructorOptions } = openDialog();

      expect(constructorOptions?.parent).toBeUndefined();
      expect(constructorOptions?.modal).toBe(false);
      const width = constructorOptions?.width as number;
      const height = constructorOptions?.height as number;
      expect(constructorOptions?.x).toBe(-1920 + Math.round((1920 - width) / 2));
      expect(constructorOptions?.y).toBe(Math.round((1080 - height) / 2));

      window.listeners.get("closed")?.();
      await expect(pending).resolves.toBe("manual-cancel");
    } finally {
      dialogPlacement.cursorDisplayArea = { x: 0, y: 0, width: 1440, height: 900 };
    }
  });

  // A parent straddling the edge of its display must not push the dialog off
  // that display.
  it("keeps the dialog on the parent's display", async () => {
    const main = createFakeParentWindow({ x: 1300, y: 800, width: 400, height: 300 });
    useMainWindow(main);

    const { pending, window, constructorOptions } = openDialog();

    const width = constructorOptions?.width as number;
    const height = constructorOptions?.height as number;
    expect(constructorOptions?.x).toBe(1440 - width);
    expect(constructorOptions?.y).toBe(900 - height);

    window.listeners.get("closed")?.();
    await expect(pending).resolves.toBe("manual-cancel");
  });
});
