/**
 * Starts loading every latin face of the bundled Geist Sans and Geist Mono
 * (`styles/fonts.css`) as the renderer boots.
 *
 * A face otherwise downloads only when text first asks for its weight, and
 * its arrival reflows everything drawn in the fallback until then. Before the
 * bundle the renderer drew system fonts and never swapped a font mid-session;
 * after it, the first bold word or code span to scroll into view could move
 * the layout under the operator. The transcript is the surface that notices:
 * it re-pins to the bottom when its content resizes while it was pinned, so a
 * face that lands as the operator scrolls up can snap them back down.
 *
 * Loading up front moves those reflows to startup, before anything is
 * interacted with. It does not block the first render: the faces are local
 * assets and arrive within milliseconds, and a failed load leaves that text
 * on the fallback stack, as before. Other subsets (cyrillic, symbols) stay
 * lazy; latin covers the UI.
 */

const BUNDLED_FAMILIES = new Set(["Geist Sans", "Geist Mono"]);

type PreloadableFace = Pick<FontFace, "family" | "status" | "unicodeRange" | "load">;

export function preloadBundledFonts(
  fonts: Iterable<PreloadableFace> | undefined = document.fonts,
): number {
  if (!fonts) return 0;
  let started = 0;
  for (const face of fonts) {
    if (face.status !== "unloaded") continue;
    if (!BUNDLED_FAMILIES.has(unquote(face.family))) continue;
    if (!coversCodePoint(face.unicodeRange, 0x41)) continue;
    started += 1;
    void face.load().catch(() => undefined);
  }
  return started;
}

function unquote(family: string): string {
  return family.trim().replace(/^(["'])(.*)\1$/, "$2");
}

/** Whether a CSS `unicode-range` value (`U+0000-00FF, U+0131, U+4??`)
 *  includes the code point. */
export function coversCodePoint(unicodeRange: string, codePoint: number): boolean {
  for (const part of unicodeRange.split(",")) {
    const range = part.trim().replace(/^U\+/i, "");
    if (!range) continue;
    let low: number;
    let high: number;
    if (range.includes("?")) {
      low = parseInt(range.replace(/\?/g, "0"), 16);
      high = parseInt(range.replace(/\?/g, "F"), 16);
    } else if (range.includes("-")) {
      const [from, to] = range.split("-");
      low = parseInt(from!, 16);
      high = parseInt(to!.replace(/^U\+/i, ""), 16);
    } else {
      low = high = parseInt(range, 16);
    }
    if (codePoint >= low && codePoint <= high) return true;
  }
  return false;
}
