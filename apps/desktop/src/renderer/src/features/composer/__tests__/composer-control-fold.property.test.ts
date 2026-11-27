import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { appStyleRules } from "../../../styles/__tests__/css-style-rules";
import {
  COMPOSER_FOLD_TIERS,
  composerRowWidth,
  isComposerTierFolded,
  planComposerRowFold,
  type ComposerFoldTier,
  type ComposerRowItem,
} from "../composer-control-fold";

/**
 * The rule from the Composer Diet design (section 02), which replaced the
 * line-two rules of #4516: the control row is one line at every width. When
 * it runs out of room, controls fold into ⋮ in a fixed order: the controls
 * moving to the Details rail, then the environment ▶, then dictation, then
 * attach. The access control, model pill, ⋮, moon and Send never fold, and
 * the model name truncates only after everything that can fold has folded.
 * A pane narrower than those pinned controls is the one case that wraps, so
 * Send never leaves the box.
 */

function declarations(selector: string): Map<string, string> {
  const merged = new Map<string, string>();
  for (const rule of appStyleRules) {
    if (rule.atRules.length > 0) continue;
    if (!rule.selectors.includes(selector)) continue;
    for (const declaration of rule.body.split(";")) {
      const colon = declaration.indexOf(":");
      if (colon < 0) continue;
      merged.set(declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim());
    }
  }
  return merged;
}

function parseColumnGap(decls: Map<string, string>): number {
  const gap = decls.get("column-gap") ?? decls.get("gap")?.split(/\s+/).at(-1);
  if (!gap) return 0;
  const match = /^(\d+(?:\.\d+)?)px$/.exec(gap);
  if (!match) throw new Error(`Expected a px gap, got ${gap}`);
  return Number(match[1]);
}

const ROW_SELECTOR = ".composer__setup";
const row = declarations(ROW_SELECTOR);
const rowGap = parseColumnGap(row);
const rowWraps = row.get("flex-wrap") !== "nowrap";

type Control = ComposerRowItem & { id: string };

/** How many lines a flex row of `items` takes `available` px wide. */
function lineCount(items: readonly Control[], available: number): number {
  if (!rowWraps) return items.length > 0 ? 1 : 0;
  let lines = items.length > 0 ? 1 : 0;
  let used = 0;
  items.forEach((item, index) => {
    const next = index === 0 || used === 0 ? item.width : used + rowGap + item.width;
    if (used > 0 && next > available) {
      lines += 1;
      used = item.width;
    } else {
      used = next;
    }
  });
  return lines;
}

/**
 * The row as the composer draws it: the planner chooses what folds, the
 * model pill gives up `shrink` px, and the stylesheet decides whether what
 * is left can wrap.
 */
function layOut(controls: readonly Control[], available: number) {
  const plan = planComposerRowFold({ available, gap: rowGap, items: controls });
  let shrinkLeft = plan.shrink;
  const visible = controls
    .filter((control) => control.tier === undefined
      || !isComposerTierFolded(control.tier, plan.foldedTierCount))
    .map((control) => {
      if (control.minWidth === undefined || shrinkLeft <= 0) return control;
      const taken = Math.min(shrinkLeft, control.width - control.minWidth);
      shrinkLeft -= taken;
      return { ...control, width: control.width - taken };
    });
  return { plan, visible };
}

const width = fc.integer({ min: 16, max: 220 });

/** A row in the shape the composer builds: left group, then right group. */
const composerRow = fc
  .record({
    access: fc.integer({ min: 26, max: 120 }),
    modelMin: fc.integer({ min: 48, max: 90 }),
    modelExtra: fc.integer({ min: 0, max: 220 }),
    details: fc.array(width, { maxLength: 7 }),
    run: fc.boolean(),
    dictation: fc.boolean(),
    attach: fc.boolean(),
    send: fc.integer({ min: 28, max: 200 }),
  })
  .map((shape): Control[] => {
    const details = shape.details.map((detailWidth, index): Control => ({
      id: `details-${index}`,
      tier: "details",
      width: detailWidth,
    }));
    const half = Math.ceil(details.length / 2);
    return [
      { id: "access", width: shape.access },
      { id: "model", width: shape.modelMin + shape.modelExtra, minWidth: shape.modelMin },
      ...details.slice(0, half),
      ...(shape.attach ? [{ id: "attach", tier: "attach" as const, width: 26 }] : []),
      ...(shape.dictation ? [{ id: "dictation", tier: "dictation" as const, width: 26 }] : []),
      { id: "options", width: 26 },
      ...details.slice(half),
      ...(shape.run ? [{ id: "run", tier: "run" as const, width: 26 }] : []),
      { id: "moon", width: 26 },
      { id: "send", width: shape.send },
    ];
  });

/** The narrowest the row can draw: pinned controls, model at its floor. */
function pinnedFloor(controls: readonly Control[]): number {
  return composerRowWidth(
    controls
      .filter((control) => control.tier === undefined)
      .map((control) => ({ width: control.minWidth ?? control.width })),
    rowGap,
  );
}

const rowAndWidth = composerRow.chain((controls) =>
  fc.tuple(
    fc.constant(controls),
    fc.integer({
      min: Math.ceil(pinnedFloor(controls)),
      max: Math.ceil(composerRowWidth(controls, rowGap)) + 40,
    }),
  ));

describe("composer control row fold", () => {
  it("declares a row that never wraps, with folded slots out of the flow", () => {
    expect(row.get("display")).toBe("flex");
    expect(row.get("flex-wrap")).toBe("nowrap");
    // A folded slot is positioned against the row.
    expect(row.get("position")).toBe("relative");
    const folded = declarations(".composer__fold-slot.is-folded");
    expect(folded.get("position")).toBe("absolute");
    expect(folded.get("visibility")).toBe("hidden");
    // The tools group adds nothing but its children, so it must use the row's gap.
    expect(parseColumnGap(declarations(".composer__application-actions"))).toBe(rowGap);
    // The last resort, when even the pinned controls do not fit.
    expect(declarations(".composer__setup[data-overflowing]").get("flex-wrap")).toBe("wrap");
  });

  it("overflows, and so wraps, exactly when the pinned controls cannot fit", () => {
    fc.assert(
      fc.property(
        composerRow.chain((controls) =>
          fc.tuple(fc.constant(controls), fc.integer({ min: 1, max: Math.ceil(pinnedFloor(controls)) + 40 }))),
        ([controls, available]) => {
          const { plan } = layOut(controls, available);
          expect(plan.overflows).toBe(pinnedFloor(controls) > available + 0.5);
          if (plan.overflows) expect(plan.foldedTierCount).toBe(COMPOSER_FOLD_TIERS.length);
        },
      ),
    );
  });

  // From CI: a 900 px window with both rails open leaves the thread pane's
  // row about 212 px. Access, the effort-only model pill, ⋮, the moon and
  // Send need more than that, and the unwrapped row pushed Send out of the
  // box, where it could not be clicked.
  it("wraps a row too narrow for its pinned controls rather than clip Send", () => {
    const controls: Control[] = [
      { id: "access", width: 110 },
      { id: "model", width: 150, minWidth: 84 },
      { id: "dictation", tier: "dictation", width: 26 },
      { id: "options", width: 26 },
      { id: "moon", width: 66 },
      { id: "send", width: 54 },
    ];
    const { plan } = layOut(controls, 212);
    expect(plan.foldedTierCount).toBe(COMPOSER_FOLD_TIERS.length);
    expect(plan.overflows).toBe(true);
  });

  it("is one line at every width that fits the pinned controls", () => {
    fc.assert(
      fc.property(rowAndWidth, ([controls, available]) => {
        const { visible } = layOut(controls, available);
        expect(lineCount(visible, available)).toBe(1);
        expect(composerRowWidth(visible, rowGap)).toBeLessThanOrEqual(available + 0.5);
      }),
    );
  });

  it("folds tiers in the stated order and never folds a pinned control", () => {
    fc.assert(
      fc.property(rowAndWidth, ([controls, available]) => {
        const { plan, visible } = layOut(controls, available);
        const visibleIds = new Set(visible.map((control) => control.id));
        for (const control of controls) {
          if (control.tier === undefined) expect(visibleIds.has(control.id)).toBe(true);
        }
        // A tier is folded only if every tier before it is folded too.
        const foldedTiers = new Set(
          controls
            .filter((control) => control.tier && !visibleIds.has(control.id))
            .map((control) => control.tier as ComposerFoldTier),
        );
        for (const tier of foldedTiers) {
          for (const earlier of COMPOSER_FOLD_TIERS.slice(0, COMPOSER_FOLD_TIERS.indexOf(tier))) {
            expect(isComposerTierFolded(earlier, plan.foldedTierCount)).toBe(true);
          }
        }
      }),
    );
  });

  it("folds no more than it must, and truncates the model only once everything has folded", () => {
    fc.assert(
      fc.property(rowAndWidth, ([controls, available]) => {
        const { plan } = layOut(controls, available);
        if (plan.foldedTierCount > 0) {
          // One tier fewer would not fit.
          const unfolded = controls.filter((control) => control.tier === undefined
            || !isComposerTierFolded(control.tier, plan.foldedTierCount - 1));
          expect(composerRowWidth(unfolded, rowGap)).toBeGreaterThan(available + 0.5);
        }
        if (plan.shrink > 0) {
          expect(plan.foldedTierCount).toBe(COMPOSER_FOLD_TIERS.length);
        }
      }),
    );
  });

  // Shrunk counterexample from the first property, run against #4516's
  // behavior (every control drawn, `flex-wrap: wrap`): 170 px of controls and
  // five gaps did not fit 178 px, so Send dropped to a second line.
  it("folds one Details control rather than wrap a 178 px row", () => {
    const controls: Control[] = [
      { id: "access", width: 26 },
      { id: "model", width: 48, minWidth: 48 },
      { id: "details-0", tier: "details", width: 16 },
      { id: "options", width: 26 },
      { id: "moon", width: 26 },
      { id: "send", width: 28 },
    ];
    const { plan, visible } = layOut(controls, 178);
    expect(lineCount(visible, 178)).toBe(1);
    expect(plan.foldedTierCount).toBe(1);
    expect(visible.map((control) => control.id)).toEqual(["access", "model", "options", "moon", "send"]);
  });

  // The design's narrowest thread pane: environment, ▶, dictation and attach
  // on a 380 px pane, whose row has 366 px inside its padding.
  it("keeps the narrowest thread pane on one line, folding the environment and ▶", () => {
    const controls: Control[] = [
      { id: "access", width: 30 },
      { id: "model", width: 150, minWidth: 72 },
      { id: "attach", tier: "attach", width: 26 },
      { id: "dictation", tier: "dictation", width: 26 },
      { id: "options", width: 26 },
      { id: "environment", tier: "details", width: 104 },
      { id: "run", tier: "run", width: 26 },
      { id: "moon", width: 26 },
      { id: "send", width: 54 },
    ];
    const { plan, visible } = layOut(controls, 366);
    expect(lineCount(visible, 366)).toBe(1);
    expect(plan.foldedTierCount).toBe(2);
    expect(visible.map((control) => control.id)).toEqual([
      "access", "model", "attach", "dictation", "options", "moon", "send",
    ]);
  });
});
