import { describe, expect, it } from "vitest";

import { appCss } from "./css-rule-body";
import { appStyleRules } from "./css-style-rules";

/**
 * The workspace recovery slot shares the composer's column.
 *
 * `ThreadView` renders the missing-worktree card, the hibernated-checkout card
 * (which reuses `.missing-worktree-card`) and the recovery result notice as
 * flex items of `.thread-view__primary`, beside the composer rather than inside
 * it. The composer's column comes from its own 16px side padding and a
 * `--chat-column-max` cap on each of its rows, so a slot card that declares
 * nothing horizontal stretches across the whole pane while the composer under
 * it sits inset: the hibernated card ran edge to edge. The design (Thread
 * Maintenance review, frame 10b) puts the card and the composer on the same
 * left and right edges.
 *
 * jsdom does no layout, so this is an oracle over the stylesheet: a small
 * model of the flex column computes both boxes' edges from the declarations
 * that apply, across pane widths on both sides of the column cap, and the
 * edges must agree.
 */

type Box = { left: number; right: number };

/** Declarations from top-level rules naming any of `selectors`, in source order. */
function declarations(selectors: readonly string[]): Map<string, string> {
  const merged = new Map<string, string>();
  for (const rule of appStyleRules) {
    if (rule.atRules.length > 0) continue;
    if (!rule.selectors.some((selector) => selectors.includes(selector))) continue;
    for (const declaration of rule.body.split(";")) {
      const colon = declaration.indexOf(":");
      if (colon < 0) continue;
      merged.set(declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim());
    }
  }
  return merged;
}

function chatColumnMax(): number {
  // The style-rule walk does not surface the `:root` token block, so read the
  // one declaration directly.
  const value = Number.parseFloat(/--chat-column-max:\s*([\d.]+)px;/.exec(appCss)?.[1] ?? "");
  if (!Number.isFinite(value)) throw new Error("Expected :root to define --chat-column-max in px");
  return value;
}

/** A length in this model: px, `100%`, `calc(100% - Npx)` or the column variable. */
function resolveLength(value: string | undefined, pane: number): number | undefined {
  if (value === undefined || value === "none" || value === "auto") return undefined;
  if (value === "var(--chat-column-max)") return chatColumnMax();
  if (value === "100%") return pane;
  const calc = /^calc\(100%\s*-\s*(\d+(?:\.\d+)?)px\)$/.exec(value);
  if (calc) return pane - Number(calc[1]);
  const px = /^(\d+(?:\.\d+)?)px$/.exec(value);
  if (px) return Number(px[1]);
  throw new Error(`Recovery slot model does not understand the length ${value}`);
}

function sidePadding(padding: string | undefined): number {
  const parts = (padding ?? "0").split(/\s+/).map((part) => Number.parseFloat(part));
  // 1 value: all sides; 2-4 values: the second is left/right.
  return parts.length === 1 ? parts[0]! : parts[1]!;
}

/** The composer's rows: the pane less its side padding, capped and centred. */
function composerColumn(pane: number): Box {
  const padding = sidePadding(declarations([".composer"]).get("padding"));
  const rows = declarations([".composer > *"]);
  const inner = pane - padding * 2;
  const width = Math.min(resolveLength(rows.get("width"), inner) ?? inner, resolveLength(rows.get("max-width"), inner) ?? inner);
  const left = padding + (inner - width) / 2;
  return { left, right: left + width };
}

/** A flex item of the `.thread-view__primary` column. */
function slotBox(className: string, pane: number): Box {
  const own = declarations([className, `.thread-view__primary > ${className}`]);
  const width = resolveLength(own.get("width"), pane);
  const maxWidth = resolveLength(own.get("max-width"), pane);
  const alignSelf = own.get("align-self");
  if (width === undefined && (alignSelf === undefined || alignSelf === "stretch")) {
    // Stretched across the column's cross axis; the slot cards declare no
    // side margins, which the model would otherwise have to subtract.
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

  for (const className of [".missing-worktree-card", ".workspace-recovery-notice"]) {
    it(`puts ${className} on the composer's left and right edges`, () => {
      for (const pane of panes) {
        expect({ pane, ...slotBox(className, pane) }).toEqual({ pane, ...composerColumn(pane) });
      }
    });
  }
});
