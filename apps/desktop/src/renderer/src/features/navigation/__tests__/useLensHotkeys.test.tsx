import { useState } from "react";
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NavigationBrowseMode } from "@pwragent/shared";
import { _resetKeybindingsStoreForTests } from "../../../lib/keybindings-store";
import { useLensHotkeys } from "../useLensHotkeys";
import { ComposerTiptapInput } from "../../composer/ComposerTiptapInput";

type PwrWindow = Window & { pwragent?: { platform: string } };

beforeEach(() => {
  (window as PwrWindow).pwragent = { platform: "darwin" };
  _resetKeybindingsStoreForTests({ overrides: {}, filePath: "/fixture/keybindings.toml" });
});

afterEach(() => {
  cleanup();
  delete (window as PwrWindow).pwragent;
  _resetKeybindingsStoreForTests();
});

function setup(initial: NavigationBrowseMode, empty = false) {
  const onChange = vi.fn();
  const hook = renderHook(({ threadLensesEmpty }) => {
    const [browseMode, setBrowseMode] = useState(initial);
    useLensHotkeys({
      browseMode,
      onBrowseModeChange: (mode) => {
        onChange(mode);
        setBrowseMode(mode);
      },
      threadLensesEmpty,
    });
    return { browseMode, setBrowseMode };
  }, { initialProps: { threadLensesEmpty: empty } });
  return { ...hook, onChange };
}

function press(digit: number, init: KeyboardEventInit = {}, target: EventTarget = window): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: String(digit),
    code: `Digit${digit}`,
    metaKey: true,
    altKey: true,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  act(() => { target.dispatchEvent(event); });
  return event;
}

function renderComposer(value = "Draft"): HTMLElement {
  render(<form className="composer">
    <ComposerTiptapInput id="reply" label="Reply" value={value} skillTokens={[]}
      markdownConversion placeholder="Ask anything" onChange={() => undefined} />
  </form>);
  const field = screen.getByRole("textbox", { name: "Reply" });
  Object.defineProperty(field, "isContentEditable", { value: true });
  field.focus();
  return field;
}

describe("useLensHotkeys", () => {
  it.each<NavigationBrowseMode>(["drafts", "inbox", "recents", "directories"])(
    "visits Attention from %s and returns on the second press",
    (mode) => {
      const { result, onChange } = setup(mode);

      expect(press(0).defaultPrevented).toBe(true);
      expect(result.current.browseMode).toBe("attention");
      press(0);
      expect(result.current.browseMode).toBe(mode);
      expect(onChange.mock.calls).toEqual([["attention"], [mode]]);
    },
  );

  it("does nothing when Attention was already selected", () => {
    const { onChange } = setup("attention");
    press(0);
    press(0);
    expect(onChange).not.toHaveBeenCalled();
  });

  it.each<[number, NavigationBrowseMode]>([
    [1, "attention"], [2, "drafts"], [3, "inbox"], [4, "recents"], [5, "directories"],
  ])("switches directly with shortcut %i and does nothing when already there", (digit, mode) => {
    const { result, onChange } = setup(mode === "directories" ? "inbox" : "directories");
    press(digit);
    expect(result.current.browseMode).toBe(mode);
    press(digit);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("does not arm a return when switching directly to Attention", () => {
    const { result, onChange } = setup("drafts");
    press(1);
    press(0);
    expect(result.current.browseMode).toBe("attention");
    expect(onChange.mock.calls).toEqual([["attention"]]);
  });

  it("keeps the return target when Show Attention is pressed during a visit", () => {
    const { result } = setup("drafts");
    press(0);
    press(1);
    press(0);
    expect(result.current.browseMode).toBe("drafts");
  });

  it("ends the visit when another lens is selected by shortcut", () => {
    const { result } = setup("drafts");
    press(0);
    press(4);
    press(0);
    press(0);
    expect(result.current.browseMode).toBe("recents");
  });

  it("clears a stale return target after a lens is selected outside the shortcuts", () => {
    const { result, onChange } = setup("inbox");
    press(0);
    act(() => result.current.setBrowseMode("directories"));
    act(() => result.current.setBrowseMode("attention"));
    press(0);
    expect(onChange.mock.calls).toEqual([["attention"]]);
  });

  it("uses the latest lens after an external selection", () => {
    const { result } = setup("inbox");
    act(() => result.current.setBrowseMode("directories"));
    press(0);
    press(0);
    expect(result.current.browseMode).toBe("directories");
  });

  it("handles two presses before React renders the first change", () => {
    const { result, onChange } = setup("inbox");
    act(() => {
      press(0);
      press(0);
    });
    expect(result.current.browseMode).toBe("inbox");
    expect(onChange.mock.calls).toEqual([["attention"], ["inbox"]]);
  });

  it("ignores held keys, composition, and events another control already handled", () => {
    const { onChange } = setup("inbox");
    press(0, { repeat: true });
    press(0, { isComposing: true });
    const stop = (event: Event) => event.preventDefault();
    window.addEventListener("keydown", stop, true);
    try {
      press(0);
    } finally {
      window.removeEventListener("keydown", stop, true);
    }
    expect(onChange).not.toHaveBeenCalled();
  });

  it.each(["win32", "linux"])("uses Ctrl+Alt on %s", (platform) => {
    (window as PwrWindow).pwragent = { platform };
    const { result, onChange } = setup("inbox");
    press(0);
    expect(onChange).not.toHaveBeenCalled();
    press(0, { metaKey: false, ctrlKey: true });
    expect(result.current.browseMode).toBe("attention");
  });

  it("works from the composer without moving focus", () => {
    const { result } = setup("inbox");
    const composer = document.createElement("textarea");
    document.body.appendChild(composer);
    composer.focus();
    try {
      press(0, {}, composer);
      expect(result.current.browseMode).toBe("attention");
      press(0, {}, composer);
      expect(result.current.browseMode).toBe("inbox");
      expect(document.activeElement).toBe(composer);
    } finally {
      composer.remove();
    }
  });

  it.each<[number, NavigationBrowseMode]>([
    [0, "attention"], [1, "attention"], [2, "drafts"], [3, "inbox"], [4, "recents"], [5, "directories"],
  ])("gives shortcut %i priority over the Markdown editor's formatting", (digit, mode) => {
    // ProseMirror uses Ctrl for Mod in jsdom, as it does on Linux.
    (window as PwrWindow).pwragent = { platform: "linux" };
    const { result, onChange } = setup(mode === "directories" ? "inbox" : "directories");
    const field = renderComposer(digit === 0 ? "# Draft" : "Draft");
    const original = field.innerHTML;
    const modifiers = { metaKey: false, ctrlKey: true };

    press(digit, modifiers, field);
    expect(result.current.browseMode).toBe(mode);
    expect(field.innerHTML).toBe(original);
    expect(document.activeElement).toBe(field);

    press(digit, { ...modifiers, repeat: true }, field);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(field.innerHTML).toBe(original);

    press(digit, modifiers, field);
    expect(onChange).toHaveBeenCalledTimes(digit === 0 ? 2 : 1);
    expect(field.innerHTML).toBe(original);
  });

  it("leaves the editor unchanged when the Attention toggle starts in Attention", () => {
    (window as PwrWindow).pwragent = { platform: "linux" };
    const { onChange } = setup("attention");
    const field = renderComposer("# Draft");
    const original = field.innerHTML;
    press(0, { metaKey: false, ctrlKey: true }, field);
    expect(onChange).not.toHaveBeenCalled();
    expect(field.innerHTML).toBe(original);
  });

  it("restores the editor's formatting shortcut when the lens action is unbound", () => {
    (window as PwrWindow).pwragent = { platform: "linux" };
    const { onChange } = setup("directories");
    _resetKeybindingsStoreForTests({
      overrides: { "navigation.lens_attention": [] },
      filePath: "/fixture/keybindings.toml",
    });
    const field = renderComposer();
    press(1, { metaKey: false, ctrlKey: true }, field);
    expect(onChange).not.toHaveBeenCalled();
    expect(field.querySelector("h1")?.textContent).toBe("Draft");
  });

  it.each(["dialog", "menu", "listbox"])("leaves shortcuts to a focused %s", (role) => {
    const { onChange } = setup("inbox");
    const overlay = document.createElement("div");
    overlay.className = "composer";
    overlay.setAttribute("role", role);
    const field = document.createElement("textarea");
    overlay.append(field);
    document.body.append(overlay);
    try {
      expect(press(0, {}, field).defaultPrevented).toBe(false);
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      overlay.remove();
    }
  });

  it("lets the shortcut recorder capture a lens chord", () => {
    const { onChange } = setup("inbox");
    const recorder = document.createElement("div");
    recorder.setAttribute("role", "textbox");
    recorder.addEventListener("keydown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    document.body.append(recorder);
    try {
      press(0, {}, recorder);
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      recorder.remove();
    }
  });

  it("applies rebinding and unbinding immediately", () => {
    const { result, onChange } = setup("inbox");
    _resetKeybindingsStoreForTests({
      overrides: { "navigation.toggle_attention": ["CmdOrCtrl+Shift+A"], "navigation.lens_drafts": [] },
      filePath: "/fixture/keybindings.toml",
    });
    press(0);
    press(2);
    expect(onChange).not.toHaveBeenCalled();
    press(0, { key: "A", code: "KeyA", altKey: false, shiftKey: true });
    expect(result.current.browseMode).toBe("attention");
  });

  it("leaves a rebound text-editing shortcut to the composer", () => {
    const { onChange } = setup("inbox");
    _resetKeybindingsStoreForTests({
      overrides: { "navigation.toggle_attention": ["Alt+Left"] },
      filePath: "/fixture/keybindings.toml",
    });
    const form = document.createElement("form");
    form.className = "composer";
    const composer = document.createElement("textarea");
    form.append(composer);
    document.body.append(form);
    try {
      const event = press(0, { key: "ArrowLeft", code: "ArrowLeft", metaKey: false }, composer);
      expect(event.defaultPrevented).toBe(false);
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      form.remove();
    }
  });

  it("respects disabled thread lenses and removes its listener on unmount", () => {
    const { onChange, rerender, unmount } = setup("directories", true);
    for (const digit of [0, 1, 2, 3, 4, 5]) press(digit);
    expect(onChange).not.toHaveBeenCalled();
    rerender({ threadLensesEmpty: false });
    press(0);
    expect(onChange).toHaveBeenCalledTimes(1);
    unmount();
    expect(press(0).defaultPrevented).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
