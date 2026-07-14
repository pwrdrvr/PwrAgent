import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { useFindHotkeys } from "../useFindHotkeys";

afterEach(() => {
  cleanup();
});

function press(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { cancelable: true, ...init });
  window.dispatchEvent(event);
  return event;
}

function handlers(): {
  onOpenSearch: Mock<() => void>;
  onFind: Mock<() => void>;
  onThreadJump: Mock<() => void>;
} {
  return {
    onOpenSearch: vi.fn<() => void>(),
    onFind: vi.fn<() => void>(),
    onThreadJump: vi.fn<() => void>(),
  };
}

describe("useFindHotkeys", () => {
  it("routes ⌘F to the context find handler", () => {
    const spies = handlers();
    renderHook(() => useFindHotkeys(spies));

    const event = press({ metaKey: true, code: "KeyF", key: "f" });

    expect(spies.onFind).toHaveBeenCalledTimes(1);
    expect(spies.onThreadJump).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it("routes ⌘⇧F to the global search handler", () => {
    const spies = handlers();
    renderHook(() => useFindHotkeys(spies));

    press({ metaKey: true, shiftKey: true, code: "KeyF", key: "F" });

    expect(spies.onOpenSearch).toHaveBeenCalledTimes(1);
    expect(spies.onFind).not.toHaveBeenCalled();
  });

  it("routes ⌘K to the thread-jump handler", () => {
    const spies = handlers();
    renderHook(() => useFindHotkeys(spies));

    const event = press({ metaKey: true, code: "KeyK", key: "k" });

    expect(spies.onThreadJump).toHaveBeenCalledTimes(1);
    expect(spies.onFind).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it("routes ⌘K to thread-jump even while the caret is in the composer", () => {
    // ⌘F follows focus (the composer belongs to the thread, so ⌘F finds in the
    // thread). ⌘K is the focus-independent escape hatch — it must reach the
    // thread list from anywhere, which is the whole reason it exists.
    const spies = handlers();
    renderHook(() => useFindHotkeys(spies));
    const composer = document.createElement("textarea");
    document.body.appendChild(composer);
    composer.focus();

    composer.dispatchEvent(
      new KeyboardEvent("keydown", {
        metaKey: true,
        code: "KeyK",
        key: "k",
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(spies.onThreadJump).toHaveBeenCalledTimes(1);
    composer.remove();
  });

  it("leaves ⌘F and ⌘K untouched when no handler is wired", () => {
    const onOpenSearch = vi.fn();
    renderHook(() => useFindHotkeys({ onOpenSearch }));

    const find = press({ metaKey: true, code: "KeyF", key: "f" });
    const jump = press({ metaKey: true, code: "KeyK", key: "k" });

    expect(find.defaultPrevented).toBe(false);
    expect(jump.defaultPrevented).toBe(false);
  });
});
