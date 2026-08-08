import { describe, expect, it, vi } from "vitest";

type FakeDialogWindow = {
  /** Listeners the dialog registers, so tests can fire `closed`. */
  listeners: Map<string, (...args: unknown[]) => void>;
  destroyed: boolean;
  minimized: boolean;
  shown: number;
  focused: number;
  restored: number;
  closed: number;
  once: (event: string, handler: (...args: unknown[]) => void) => void;
  webContents: { on: () => void; setWindowOpenHandler: () => void };
  loadURL: () => Promise<void>;
  isDestroyed: () => boolean;
  isMinimized: () => boolean;
  restore: () => void;
  show: () => void;
  focus: () => void;
  close: () => void;
};

function createFakeDialogWindow(): FakeDialogWindow {
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
    loadURL: vi.fn(async () => undefined),
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
      threadKey: "acp%3Agrok:thread-2",
    };

    const parsed = parseQuitItemAction(formatQuitItemAction(item));

    expect(parsed).toEqual({
      threadKey: "acp%3Agrok:thread-2",
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
 * Once the countdown is cancelled — which any deliberate keystroke does, for
 * good — the only thing that settles the quit is the user answering this
 * dialog. So the dialog has to remain reachable: a repeat quit request asks the
 * quit manager to raise it, and a dialog that has already been answered must
 * not report itself as raisable.
 */
describe("raising the open quit dialog", () => {
  it("reports nothing to raise before a dialog opens", () => {
    expect(focusActiveQuitConfirmationDialog()).toBe(false);
  });

  it("restores, shows, and focuses the dialog that is on screen", async () => {
    const pending = showQuitConfirmationDialog({
      countdownSeconds: 10,
      inProgressThreadCount: 0,
      terminalSessionCount: 1,
    });
    const dialog = dialogWindows.at(-1)!;
    dialog.minimized = true;

    expect(focusActiveQuitConfirmationDialog()).toBe(true);
    expect(dialog.restored).toBe(1);
    expect(dialog.shown).toBe(1);
    expect(dialog.focused).toBe(1);

    // Answering it clears the handle: a later request must not try to raise a
    // window that is gone.
    dialog.listeners.get("closed")?.();
    await expect(pending).resolves.toBe("manual-cancel");
    expect(focusActiveQuitConfirmationDialog()).toBe(false);
  });
});
