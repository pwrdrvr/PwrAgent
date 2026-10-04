/**
 * Shell prompts (powerlevel10k, starship, oh-my-posh) draw their icons and
 * segment separators from Nerd Font private-use codepoints. The bundled
 * Geist Mono and the rest of `--font-mono` carry none of them, and Chromium
 * does not reach into a system font for a private-use glyph on its own, so a
 * prompt that renders in the operator's own terminal drew tofu boxes here.
 *
 * Anyone running such a prompt already has a Nerd Font installed for it, so
 * the terminal finds one with the Local Font Access API and names it in its
 * font stack as a fallback. It goes after the stack's named families, so
 * Geist Mono still draws every glyph it has and sets the cell size; the Nerd
 * Font only supplies what nothing before it can.
 *
 * `queryLocalFonts()` took 1.5s with 600 faces installed, so it runs once
 * per window, never blocks a terminal from opening, and is shared by every
 * terminal after the first.
 */

type LocalFontData = { family: string };
type LocalFontWindow = Window & {
  queryLocalFonts?: () => Promise<LocalFontData[]>;
};

let discovery: Promise<string | undefined> | undefined;
let discovered: string | undefined;

/** The Nerd Font family to fall back to, once a discovery has finished. */
export function discoveredNerdFontFamily(): string | undefined {
  return discovered;
}

export function discoverNerdFontFamily(): Promise<string | undefined> {
  discovery ??= queryNerdFontFamily().then((family) => {
    discovered = family;
    return family;
  });
  return discovery;
}

async function queryNerdFontFamily(): Promise<string | undefined> {
  const target = window as LocalFontWindow;
  if (typeof target.queryLocalFonts !== "function") return undefined;
  try {
    const fonts = await target.queryLocalFonts();
    return pickNerdFontFamily(fonts.map((font) => font.family));
  } catch {
    // Denied, or not a secure context: the terminal keeps its stack.
    return undefined;
  }
}

/**
 * Ranked so the cell grid stays even: the symbols-only font made for this
 * job first, then single-width "Mono" variants, then the rest. "Propo"
 * variants draw icons wider than a cell and are never picked. "NF" is the
 * v2 abbreviation powerlevel10k's "MesloLGS NF" still uses; "NFM" is v3's
 * for Mono.
 */
const NERD_FONT_RANKS: readonly RegExp[] = [
  /^Symbols Nerd Font Mono$/,
  /^Symbols Nerd Font$/,
  / Nerd Font Mono$/,
  / NFM$/,
  / Nerd Font$/,
  / NF$/,
];

export function pickNerdFontFamily(
  families: Iterable<string>,
): string | undefined {
  let best: { family: string; rank: number } | undefined;
  for (const family of new Set(families)) {
    const rank = NERD_FONT_RANKS.findIndex((pattern) => pattern.test(family));
    if (rank < 0) continue;
    if (
      !best
      || rank < best.rank
      || (rank === best.rank && family < best.family)
    ) {
      best = { family, rank };
    }
  }
  return best?.family;
}

/** `stack` with `family` added just ahead of a trailing generic family, so
 *  the generic still comes last. */
export function withNerdFontFallback(
  stack: string,
  family: string | undefined,
): string {
  if (!family) return stack;
  const quoted = `"${family.replace(/["\\]/g, "")}"`;
  const parts = stack.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.some((part) => part.replace(/["']/g, "") === family)) return stack;
  const generic = parts.at(-1);
  if (generic && /^(monospace|ui-monospace)$/.test(generic)) {
    return [...parts.slice(0, -1), quoted, generic].join(", ");
  }
  return [...parts, quoted].join(", ");
}
