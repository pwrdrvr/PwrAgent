import { describe, expect, it } from "vitest";

import { appCss } from "./css-rule-body";
import { appStyleRules } from "./css-style-rules";

/**
 * The workspace recovery slot shares the composer's column.
 *
 * `ThreadView` renders the missing-worktree card, the hibernated-checkout card
 * (which reuses `.missing-worktree-card`) and the recovery result notice in
 * `.thread-view__composer-slot`, beside the composer rather than inside it.
 * The slot is `display: contents`, so they are flex items of
 * `.thread-view__primary`. The composer's column comes from its own
 * `--composer-gutter` side padding and a `--chat-column-max` cap on each of
 * its rows, so a slot card that declares nothing horizontal stretches across
 * the whole pane while the composer under it sits inset: the hibernated card
 * ran edge to edge. The design (Thread Maintenance review, frame 10b) puts the
 * card and the composer on the same left and right edges, 12px apart.
 *
 * jsdom does no layout, so this is an oracle over the stylesheet: a small
 * model of the flex column computes both boxes' edges from the declarations
 * that apply, across pane widths on both sides of the column cap, and the
 * edges must agree. That the rendered card really sits under the slot these
 * selectors name is asserted against the DOM in
 * `thread-view-missing-worktree.test.tsx`.
 */

type Box = { left: number; right: number };

const SLOT = ".thread-view__composer-slot";

/** A `:root` length token in px. The style-rule walk does not surface the
 *  `:root` token block, so its one declaration is read directly. */
function rootPx(name: string): number {
  const value = Number.parseFloat(new RegExp(`${name}:\\s*([\\d.]+)px;`).exec(appCss)?.[1] ?? "");
  if (!Number.isFinite(value)) throw new Error(`Expected :root to define ${name} in px`);
  return value;
}

/** Substitutes the `:root` px tokens the model knows. */
function withTokens(value: string): string {
  return value
    .replaceAll("var(--chat-column-max)", `${rootPx("--chat-column-max")}px`)
    .replaceAll("var(--composer-gutter)", `${rootPx("--composer-gutter")}px`);
}

/** Declarations from top-level rules naming any of `selectors`, in source order. */
function declarations(selectors: readonly string[]): Map<string, string> {
  const merged = new Map<string, string>();
  for (const rule of appStyleRules) {
    if (rule.atRules.length > 0) continue;
    if (!rule.selectors.some((selector) => selectors.includes(selector))) continue;
    for (const declaration of rule.body.split(";")) {
      const colon = declaration.indexOf(":");
      if (colon < 0) continue;
      merged.set(declaration.slice(0, colon).trim(), withTokens(declaration.slice(colon + 1).trim()));
    }
  }
  return merged;
}

/** A length in this model: px, `100%`, or `calc(100% - [N *] Mpx)`. */
function resolveLength(value: string | undefined, pane: number): number | undefined {
  if (value === undefined || value === "none" || value === "auto") return undefined;
  if (value === "100%") return pane;
  const calc = /^calc\(100%\s*-\s*(?:(\d+)\s*\*\s*)?(\d+(?:\.\d+)?)px\)$/.exec(value);
  if (calc) return pane - Number(calc[1] ?? 1) * Number(calc[2]);
  const px = /^(\d+(?:\.\d+)?)px$/.exec(value);
  if (px) return Number(px[1]);
  throw new Error(`Recovery slot model does not understand the length ${value}`);
}

function boxParts(shorthand: string | undefined): number[] {
  return (shorthand ?? "0").split(/\s+/).map((part) => Number.parseFloat(part));
}

/** [left, right] of a 1-4 value box shorthand (`padding`, `margin`). */
function sides(shorthand: string | undefined): [number, number] {
  const parts = boxParts(shorthand);
  const right = parts[1] ?? parts[0]!;
  const left = parts[3] ?? right;
  return [left, right];
}

/** [top, bottom] of a 1-4 value box shorthand. */
function ends(shorthand: string | undefined): [number, number] {
  const parts = boxParts(shorthand);
  return [parts[0]!, parts[2] ?? parts[0]!];
}

/** The composer's rows: the pane less its side padding, capped and centred. */
function composerColumn(pane: number): Box {
  const [padLeft, padRight] = sides(declarations([".composer"]).get("padding"));
  const rows = declarations([".composer > *"]);
  const inner = pane - padLeft - padRight;
  const width = Math.min(resolveLength(rows.get("width"), inner) ?? inner, resolveLength(rows.get("max-width"), inner) ?? inner);
  const left = padLeft + (inner - width) / 2;
  return { left, right: left + width };
}

/** A flex item of the `.thread-view__primary` column. */
function slotBox(className: string, pane: number): Box {
  // The child-combinator rule outranks the bare class whatever their order in
  // the file, so it is applied second rather than merged in source order.
  const own = new Map([
    ...declarations([className]),
    ...declarations([`${SLOT} > ${className}`]),
  ]);
  // The model centres or stretches the border box; a side margin would move
  // it, so refuse one rather than report edges Chromium does not draw.
  const [marginLeft, marginRight] = sides(own.get("margin"));
  for (const margin of [marginLeft, marginRight, own.get("margin-left"), own.get("margin-right"), own.get("margin-inline")]) {
    if (margin !== undefined && margin !== 0 && margin !== "0") {
      throw new Error(`Recovery slot model does not handle a side margin on ${className}`);
    }
  }
  const width = resolveLength(own.get("width"), pane);
  const maxWidth = resolveLength(own.get("max-width"), pane);
  const alignSelf = own.get("align-self");
  if (width === undefined && (alignSelf === undefined || alignSelf === "stretch")) {
    // Stretched across the column's cross axis (side margins refused above).
    const used = Math.min(pane, maxWidth ?? pane);
    return { left: 0, right: used };
  }
  if (alignSelf !== "center") {
    throw new Error(`Recovery slot model does not handle align-self ${alignSelf ?? "(unset)"} on ${className}`);
  }
  const used = Math.min(width ?? pane, maxWidth ?? Number.POSITIVE_INFINITY);
  const left = (pane - used) / 2;
  return { left, right: left + used };
}

describe("workspace recovery slot column", () => {
  const panes = [360, 520, 760, 940, 972, 984, 1200, 1600, 2400];

  // `.composer__footer` stands alone in the column when the missing-worktree
  // card replaces the composer, and must line up with the card above it.
  for (const className of [".missing-worktree-card", ".workspace-recovery-notice", ".composer__footer"]) {
    it(`puts ${className} on the composer's left and right edges`, () => {
      for (const pane of panes) {
        expect({ pane, ...slotBox(className, pane) }).toEqual({ pane, ...composerColumn(pane) });
      }
    });
  }

  for (const [className, gap] of [[".missing-worktree-card", 12], [".workspace-recovery-notice", 8]] as const) {
    it(`leaves ${gap}px between ${className} and the composer under it`, () => {
      // The card's bottom margin plus the composer's top padding. The more
      // specific sibling rule is applied over the composer's own.
      const [, cardBottom] = ends(declarations([className]).get("margin"));
      const composer = new Map([
        ...declarations([".composer"]),
        ...declarations([`${SLOT} > ${className} + .composer`]),
      ]);
      const [shorthandTop] = ends(composer.get("padding"));
      const composerTop = composer.has("padding-top") ? Number.parseFloat(composer.get("padding-top")!) : shorthandTop;
      expect(cardBottom + composerTop).toBe(gap);
    });
  }
});
