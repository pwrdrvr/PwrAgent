import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: vi.fn(),
  nativeTheme: { shouldUseDarkColors: true },
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
  formatQuitItemAction,
  parseQuitItemAction,
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
