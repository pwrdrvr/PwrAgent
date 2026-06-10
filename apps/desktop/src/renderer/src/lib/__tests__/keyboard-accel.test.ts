import { afterEach, describe, expect, it } from "vitest";
import { formatPrimaryAccel } from "../keyboard-accel";

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
