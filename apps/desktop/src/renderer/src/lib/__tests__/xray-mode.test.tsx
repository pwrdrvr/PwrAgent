import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  XRAY_DOUBLE_PRESS_MS,
  XRAY_HOLD_MS,
  readXrayState,
  setXrayPinned,
  useXrayMode,
} from "../xray-mode";

function key(type: "keydown" | "keyup", name: string): void {
  window.dispatchEvent(new KeyboardEvent(type, { key: name, bubbles: true }));
}

const xrayAttribute = () => document.documentElement.hasAttribute("data-xray");

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  setXrayPinned(false);
  vi.useRealTimers();
});

function mount(platform = "darwin", enabled = true) {
  return renderHook((props: { enabled: boolean }) =>
    useXrayMode({ enabled: props.enabled, platform }), {
    initialProps: { enabled },
  });
}

describe("useXrayMode", () => {
  it("shows every chip while ⌘ is held, after the hold delay", () => {
    mount();
    key("keydown", "Meta");
    act(() => vi.advanceTimersByTime(XRAY_HOLD_MS - 1));
    expect(xrayAttribute()).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(xrayAttribute()).toBe(true);
    expect(readXrayState()).toEqual({ active: true, pinned: false });

    act(() => key("keyup", "Meta"));
    expect(xrayAttribute()).toBe(false);
  });

  it("uses Control off macOS", () => {
    mount("win32");
    key("keydown", "Meta");
    act(() => vi.advanceTimersByTime(XRAY_HOLD_MS));
    expect(xrayAttribute()).toBe(false);
    key("keyup", "Meta");
    key("keydown", "Control");
    act(() => vi.advanceTimersByTime(XRAY_HOLD_MS));
    expect(xrayAttribute()).toBe(true);
  });

  it("stays out of the way of a shortcut", () => {
    mount();
    key("keydown", "Meta");
    key("keydown", "k");
    act(() => vi.advanceTimersByTime(XRAY_HOLD_MS * 2));
    expect(xrayAttribute()).toBe(false);
  });

  it("puts the rows back when a shortcut follows a peek", () => {
    mount();
    key("keydown", "Meta");
    act(() => vi.advanceTimersByTime(XRAY_HOLD_MS));
    expect(xrayAttribute()).toBe(true);
    act(() => key("keydown", "Enter"));
    expect(xrayAttribute()).toBe(false);
  });

  it("does not peek once the pointer is pressed during the hold", () => {
    mount();
    key("keydown", "Meta");
    window.dispatchEvent(new Event("pointerdown"));
    act(() => vi.advanceTimersByTime(XRAY_HOLD_MS));
    expect(xrayAttribute()).toBe(false);
  });

  it("pins on a double press and unpins on the next one", () => {
    mount();
    key("keydown", "Meta");
    key("keyup", "Meta");
    act(() => key("keydown", "Meta"));
    expect(readXrayState()).toEqual({ active: true, pinned: true });
    key("keyup", "Meta");
    // Pinned survives the release and the hold timer.
    act(() => vi.advanceTimersByTime(XRAY_HOLD_MS));
    expect(xrayAttribute()).toBe(true);

    key("keydown", "Meta");
    key("keyup", "Meta");
    act(() => key("keydown", "Meta"));
    expect(readXrayState()).toEqual({ active: false, pinned: false });
  });

  it("does not count two presses far apart as a double press", () => {
    mount();
    key("keydown", "Meta");
    key("keyup", "Meta");
    act(() => vi.advanceTimersByTime(XRAY_DOUBLE_PRESS_MS + 50));
    key("keydown", "Meta");
    expect(readXrayState().pinned).toBe(false);
  });

  it("ends a peek when the window loses focus", () => {
    mount();
    key("keydown", "Meta");
    act(() => vi.advanceTimersByTime(XRAY_HOLD_MS));
    act(() => window.dispatchEvent(new Event("blur")));
    expect(xrayAttribute()).toBe(false);
  });

  it("turns off, pinned or not, when disabled", () => {
    const view = mount();
    act(() => setXrayPinned(true));
    expect(xrayAttribute()).toBe(true);
    view.rerender({ enabled: false });
    expect(xrayAttribute()).toBe(false);
    expect(readXrayState().pinned).toBe(false);
  });
});
