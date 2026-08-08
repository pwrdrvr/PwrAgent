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
  webContents: { on: () => void; setWindowOpenHandler: () => void };
  /** Stays pending unless a test settles it — the real load is async too. */
  loadURL: () => Promise<void>;
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
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    },
    loadURL: () => loaded,
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

vi.mock("electron", () => ({
  // `new BrowserWindow(...)`: an arrow function is not constructible.
  BrowserWindow: vi.fn(function BrowserWindowMock() {
    const window = createFakeDialogWindow();
    dialogWindows.push(window);
    return window;
  }),
  nativeTheme: { shouldUseDarkColors: true },
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

vi.mock("../settings/appearance-bootstrap", () => ({
  readBootstrapAppearance: () => ({ theme: "dark" }),
}));

import { parseThreadIdentityKey } from "@pwragent/shared";
import {
  focusActiveQuitConfirmationDialog,
  formatQuitItemAction,
  parseQuitItemAction,
  showQuitConfirmationDialog,
  type QuitBlockerItem,
} from "../quit-confirmation-dialog";

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
});
