import { describe, expect, it, vi } from "vitest";
import { coversCodePoint, preloadBundledFonts } from "../bundled-font-preload";

const LATIN = "U+0000-00FF, U+0131, U+0152-0153, U+2000-206F";
const CYRILLIC = "U+0301, U+0400-045F, U+0490-0491";

function face(family: string, unicodeRange: string, status: FontFaceLoadStatus = "unloaded") {
  return { family, unicodeRange, status, load: vi.fn(async () => ({}) as FontFace) };
}

describe("preloadBundledFonts", () => {
  it("loads the unloaded latin faces of the bundled families only", () => {
    const sans = face("\"Geist Sans\"", LATIN);
    const mono = face("Geist Mono", LATIN);
    const monoCyrillic = face("Geist Mono", CYRILLIC);
    const loaded = face("Geist Sans", LATIN, "loaded");
    const katex = face("KaTeX_Main", "U+0000-10FFFF");
    const upstream = face("Geist", LATIN);

    expect(preloadBundledFonts([sans, mono, monoCyrillic, loaded, katex, upstream])).toBe(2);

    expect(sans.load).toHaveBeenCalledOnce();
    expect(mono.load).toHaveBeenCalledOnce();
    for (const skipped of [monoCyrillic, loaded, katex, upstream]) {
      expect(skipped.load).not.toHaveBeenCalled();
    }
  });

  it("swallows a failed load so the text stays on the fallback stack", async () => {
    const broken = face("Geist Sans", LATIN);
    broken.load.mockRejectedValueOnce(new Error("missing asset"));
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      expect(preloadBundledFonts([broken])).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("does nothing without a font set", () => {
    expect(preloadBundledFonts(undefined)).toBe(0);
  });
});

describe("coversCodePoint", () => {
  it("reads single points, ranges and wildcards", () => {
    expect(coversCodePoint(LATIN, 0x41)).toBe(true);
    expect(coversCodePoint(LATIN, 0x131)).toBe(true);
    expect(coversCodePoint(CYRILLIC, 0x41)).toBe(false);
    expect(coversCodePoint("U+4??", 0x4a0)).toBe(true);
    expect(coversCodePoint("U+4??", 0x500)).toBe(false);
  });
});
