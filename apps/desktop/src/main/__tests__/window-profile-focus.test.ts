import { describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
import { selectWindowForProfileFocus } from "../window-profile-focus";

function window(options: {
  children?: BrowserWindow[];
  destroyed?: boolean;
  minimized?: boolean;
  modal?: boolean;
  visible?: boolean;
} = {}): BrowserWindow {
  return {
    getChildWindows: vi.fn(() => options.children ?? []),
    isDestroyed: vi.fn(() => options.destroyed ?? false),
    isMinimized: vi.fn(() => options.minimized ?? false),
    isModal: vi.fn(() => options.modal ?? false),
    isVisible: vi.fn(() => options.visible ?? true),
  } as unknown as BrowserWindow;
}

describe("profile window activation", () => {
  const isShown = (candidate: BrowserWindow) => candidate.isVisible();
  it("preserves either last-focused conversation regardless of registration order", () => {
    const local = window();
    const remote = window();
    for (const windows of [[local, remote], [remote, local]]) {
      for (const last of [local, remote]) {
        expect(selectWindowForProfileFocus(windows, null, last, local, isShown)).toBe(last);
      }
    }
  });

  it("respects an explicit current selection over focus history", () => {
    const local = window();
    const remote = window();
    expect(selectWindowForProfileFocus([local, remote], remote, local, local, isShown)).toBe(remote);
  });

  it("preserves an auxiliary window when returning to its profile", () => {
    const local = window();
    const logs = window();
    expect(selectWindowForProfileFocus([local, logs], null, logs, local, isShown)).toBe(logs);
  });

  it("preserves a minimized or occluded window and ignores a destroyed or unowned one", () => {
    const local = window();
    for (const last of [window({ visible: false, minimized: true }), window({ visible: false })]) {
      expect(selectWindowForProfileFocus([local, last], null, last, local, isShown)).toBe(last);
    }
    const destroyed = window({ destroyed: true });
    expect(selectWindowForProfileFocus([local, destroyed], destroyed, destroyed, local, isShown)).toBe(local);
    const unowned = window();
    expect(selectWindowForProfileFocus([local], unowned, unowned, local, isShown)).toBe(local);
  });

  it("selects the deepest visible modal even when only its parent emitted focus", () => {
    const sheet = window({ modal: true, visible: false });
    const dialog = window({ modal: true, children: [sheet] });
    const local = window({ children: [window({ modal: true, visible: false }), dialog] });
    // The sheet is shown but occluded by the other application. A modal
    // constructed hidden must not be selected just because it is a child.
    const shown = (candidate: BrowserWindow) => [dialog, sheet].includes(candidate);
    expect(selectWindowForProfileFocus([local, dialog, sheet], null, local, local, shown)).toBe(sheet);
    expect(selectWindowForProfileFocus([local, dialog, sheet], null, undefined, local, shown)).toBe(sheet);
  });
});
