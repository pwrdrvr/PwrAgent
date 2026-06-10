import { afterEach, describe, expect, it } from "vitest";
import { formatPrimaryAccel, isAccelLetter } from "../keyboard-accel";

type PwrWindow = Window & { pwragent?: { platform?: string } };

function setPlatform(platform: string | undefined): void {
  const win = window as PwrWindow;
  if (platform === undefined) {
    delete win.pwragent;
    return;
  }
  win.pwragent = { platform };
}

afterEach(() => {
  setPlatform(undefined);
});

describe("formatPrimaryAccel", () => {
  it("renders ⌘/⌥ glyphs on macOS", () => {
    setPlatform("darwin");
    expect(formatPrimaryAccel("B")).toBe("⌘B");
    expect(formatPrimaryAccel("B", { alt: true })).toBe("⌘⌥B");
  });

  it("renders Ctrl/Alt words on Windows", () => {
    setPlatform("win32");
    expect(formatPrimaryAccel("B")).toBe("Ctrl+B");
    expect(formatPrimaryAccel("B", { alt: true })).toBe("Ctrl+Alt+B");
  });

  it("renders Ctrl/Alt words on Linux", () => {
    setPlatform("linux");
    expect(formatPrimaryAccel("B")).toBe("Ctrl+B");
    expect(formatPrimaryAccel("B", { alt: true })).toBe("Ctrl+Alt+B");
  });

  it("falls back to the Ctrl form when the desktop bridge is unavailable", () => {
    setPlatform(undefined);
    expect(formatPrimaryAccel("B")).toBe("Ctrl+B");
    expect(formatPrimaryAccel("B", { alt: true })).toBe("Ctrl+Alt+B");
  });
});

describe("isAccelLetter", () => {
  const keydown = (init: KeyboardEventInit): KeyboardEvent =>
    new KeyboardEvent("keydown", init);

  it("matches the physical key when Option composes a glyph (⌘⌥B → key '∫')", () => {
    // The regression: macOS rewrites event.key to "∫" while Option is held,
    // so the old `event.key === "b"` check never fired for ⌘⌥B (toggle rail).
    expect(
      isAccelLetter(keydown({ code: "KeyB", key: "∫", altKey: true }), "b"),
    ).toBe(true);
  });

  it("matches a plain letter when code is absent (defensive fallback)", () => {
    expect(isAccelLetter(keydown({ code: "", key: "b" }), "b")).toBe(true);
    expect(isAccelLetter(keydown({ code: "", key: "B" }), "b")).toBe(true);
  });

  it("matches ⌘B (no Option) via either code or key", () => {
    expect(isAccelLetter(keydown({ code: "KeyB", key: "b" }), "b")).toBe(true);
  });

  it("rejects other keys, including other Option-composed glyphs", () => {
    expect(isAccelLetter(keydown({ code: "KeyA", key: "a" }), "b")).toBe(false);
    expect(
      isAccelLetter(keydown({ code: "KeyV", key: "√", altKey: true }), "b"),
    ).toBe(false);
  });
});
