import { afterEach, describe, expect, it, vi } from "vitest";
import {
  pickNerdFontFamily,
  withNerdFontFallback,
} from "../nerd-font-fallback";

const MONO_STACK =
  '"Geist Mono", "SF Mono", "JetBrains Mono", Consolas, monospace';

describe("pickNerdFontFamily", () => {
  it("prefers the symbols-only font made for fallback", () => {
    expect(pickNerdFontFamily([
      "MesloLGS NF",
      "MesloLGL Nerd Font Mono",
      "Symbols Nerd Font",
      "Symbols Nerd Font Mono",
    ])).toBe("Symbols Nerd Font Mono");
  });

  it("takes a single-width Mono variant over the others", () => {
    // queryLocalFonts lists every face, so families repeat.
    expect(pickNerdFontFamily([
      "MesloLGM Nerd Font",
      "MesloLGM Nerd Font Propo",
      "MesloLGM Nerd Font Mono",
      "MesloLGL Nerd Font Mono",
      "MesloLGL Nerd Font Mono",
    ])).toBe("MesloLGL Nerd Font Mono");
  });

  it("recognizes the abbreviated names powerlevel10k and v3 install", () => {
    expect(pickNerdFontFamily(["Menlo", "MesloLGS NF"])).toBe("MesloLGS NF");
    expect(pickNerdFontFamily(["MesloLGS NF", "Hack NFM"])).toBe("Hack NFM");
  });

  it("never picks a proportional variant or an ordinary font", () => {
    expect(pickNerdFontFamily([
      "Hack Nerd Font Propo",
      "Hack NFP",
      "Menlo",
      "SF Mono",
    ])).toBeUndefined();
  });
});

describe("withNerdFontFallback", () => {
  it("adds the family after the named fonts and before the generic", () => {
    expect(withNerdFontFallback(MONO_STACK, "MesloLGS NF")).toBe(
      '"Geist Mono", "SF Mono", "JetBrains Mono", Consolas, "MesloLGS NF", monospace',
    );
  });

  it("appends when the stack ends without a generic family", () => {
    expect(withNerdFontFallback('"Geist Mono"', "Hack NFM"))
      .toBe('"Geist Mono", "Hack NFM"');
  });

  it("leaves the stack alone with no family, or one it already names", () => {
    expect(withNerdFontFallback(MONO_STACK, undefined)).toBe(MONO_STACK);
    expect(withNerdFontFallback('"Hack NFM", monospace', "Hack NFM"))
      .toBe('"Hack NFM", monospace');
  });
});

describe("discoverNerdFontFamily", () => {
  afterEach(() => {
    Reflect.deleteProperty(window, "queryLocalFonts");
    vi.resetModules();
  });

  it("queries the installed fonts once per window", async () => {
    const queryLocalFonts = vi.fn(async () => [
      { family: "Menlo" },
      { family: "MesloLGS NF" },
    ]);
    Object.defineProperty(window, "queryLocalFonts", {
      configurable: true,
      value: queryLocalFonts,
    });
    const module = await import("../nerd-font-fallback");

    expect(module.discoveredNerdFontFamily()).toBeUndefined();
    await expect(module.discoverNerdFontFamily()).resolves.toBe("MesloLGS NF");
    await expect(module.discoverNerdFontFamily()).resolves.toBe("MesloLGS NF");
    expect(module.discoveredNerdFontFamily()).toBe("MesloLGS NF");
    expect(queryLocalFonts).toHaveBeenCalledTimes(1);
  });

  it("finds nothing where the API is missing or refused", async () => {
    let module = await import("../nerd-font-fallback");
    await expect(module.discoverNerdFontFamily()).resolves.toBeUndefined();

    vi.resetModules();
    Object.defineProperty(window, "queryLocalFonts", {
      configurable: true,
      value: vi.fn(async () => {
        throw new DOMException("Permission denied", "NotAllowedError");
      }),
    });
    module = await import("../nerd-font-fallback");
    await expect(module.discoverNerdFontFamily()).resolves.toBeUndefined();
  });
});
