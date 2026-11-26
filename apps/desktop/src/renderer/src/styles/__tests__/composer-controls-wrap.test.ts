import { describe, expect, it } from "vitest";

import { appStyleRules } from "./css-style-rules";

/**
 * Locks the composer's unified wrapping control bar.
 *
 * Previously `.composer__setup` (access, project, workspace, model, toggles)
 * and `.composer__footer` (workspace tools + Cancel / Send) were separate
 * stacked rows inside `.composer`'s flex column. When `.composer__setup`
 * wrapped a handful of icon buttons onto line 2, `.composer__footer` still
 * started a 3rd row underneath even when its left side was empty (e.g. a
 * launchpad with no selected project) and the send controls easily fit beside
 * the wrapped overflow.
 *
 * Putting the setup fieldset (`display: contents`), optional workspace tools,
 * and right-aligned `.composer__actions` (`margin-left: auto`) in one
 * flex-wrap container lets `.composer__actions` share the wrapped line
 * whenever they fit and drop cleanly flush-right when they do not.
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

function parsePx(value: string | undefined, fallback = 0): number {
  if (!value) return fallback;
  const match = /^(\d+(?:\.\d+)?)px$/.exec(value.trim());
  if (!match) throw new Error(`Expected px length, got ${value}`);
  return Number(match[1]);
}

function parseColumnGap(decls: Map<string, string>): number {
  if (decls.has("column-gap")) return parsePx(decls.get("column-gap"));
  const gap = decls.get("gap");
  if (!gap) return 0;
  const parts = gap.split(/\s+/);
  return parsePx(parts[1] ?? parts[0]);
}

type FlexItemInput = {
  id: string;
  width: number;
  marginLeftAuto?: boolean;
  paddingLeft?: number;
};

type PlacedItem = {
  id: string;
  line: number;
  left: number;
  right: number;
};

/**
 * Models a horizontal `flex-wrap: wrap` container whose items are non-growing
 * chips/groups and whose trailing actions group may carry `margin-left: auto`.
 */
function packFlexLines(
  containerWidth: number,
  columnGap: number,
  items: readonly FlexItemInput[],
): PlacedItem[] {
  const lines: FlexItemInput[][] = [];
  let current: FlexItemInput[] = [];
  let used = 0;

  for (const item of items) {
    const outerWidth = Math.min(item.width + (item.paddingLeft ?? 0), containerWidth);
    const nextUsed = current.length === 0 ? outerWidth : used + columnGap + outerWidth;
    if (current.length > 0 && nextUsed > containerWidth) {
      lines.push(current);
      current = [item];
      used = outerWidth;
    } else {
      current.push(item);
      used = nextUsed;
    }
  }
  if (current.length > 0) lines.push(current);

  const placed: PlacedItem[] = [];
  lines.forEach((lineItems, lineIndex) => {
    const widths = lineItems.map((item) => Math.min(item.width + (item.paddingLeft ?? 0), containerWidth));
    const totalContent = widths.reduce((sum, w) => sum + w, 0)
      + Math.max(0, lineItems.length - 1) * columnGap;
    const freeSpace = Math.max(0, containerWidth - totalContent);
    const autoCount = lineItems.filter((item) => item.marginLeftAuto).length;
    const autoShare = autoCount > 0 ? freeSpace / autoCount : 0;

    let cursor = 0;
    lineItems.forEach((item, idx) => {
      if (idx > 0) cursor += columnGap;
      if (item.marginLeftAuto) cursor += autoShare;
      const boxWidth = widths[idx]!;
      placed.push({
        id: item.id,
        line: lineIndex,
        left: cursor + (item.paddingLeft ?? 0),
        right: cursor + boxWidth,
      });
      cursor += boxWidth;
    });
  });

  return placed;
}

describe("composer controls wrap layout", () => {
  it("declares one wrapping flex bar with right-aligned actions and transparent pending fieldset", () => {
    const setup = declarations(".composer__setup");
    const pending = declarations(".composer__pending-controls");
    const appActions = declarations(".composer__application-actions");
    const actions = declarations(".composer__actions");

    expect(setup.get("display")).toBe("flex");
    expect(setup.get("flex-wrap")).toBe("wrap");
    expect(setup.get("align-items")).toBe("center");

    // The fieldset generates no box so setup chips wrap directly with `.composer__actions`.
    expect(pending.get("display")).toBe("contents");

    // Workspace/app tools stay grouped when they fit and wrap internally on narrow panes.
    expect(appActions.get("flex-wrap")).toBe("wrap");
    expect(appActions.get("max-width")).toBe("100%");

    // Actions share the wrapped line when they fit and stay flush-right on every line.
    expect(actions.get("margin-left")).toBe("auto");
    expect(actions.get("justify-content")).toBe("flex-end");
    expect(actions.get("max-width")).toBe("100%");
  });

  it("places Cancel + Start thread on the 2nd line alongside wrapped toggles whenever they fit", () => {
    const setup = declarations(".composer__setup");
    const actions = declarations(".composer__actions");
    const columnGap = parseColumnGap(setup);
    const actionsPaddingLeft = parsePx(actions.get("padding-left"));
    const actionsMarginLeftAuto = actions.get("margin-left") === "auto";

    // Representative launchpad chips from the narrow center pane with the right rail open.
    const launchpadItems: FlexItemInput[] = [
      { id: "access", width: 52 },
      { id: "project", width: 146 },
      { id: "workspace", width: 84 },
      { id: "model", width: 214 },
      { id: "plan", width: 26 },
      { id: "reference", width: 26 },
      { id: "dictation", width: 26 },
      { id: "options", width: 26 },
      {
        id: "actions",
        width: 196,
        marginLeftAuto: actionsMarginLeftAuto,
        paddingLeft: actionsPaddingLeft,
      },
    ];

    // Medium pane (~540px): the 4 toggles wrap onto line 2, and actions fit beside them.
    const medium = packFlexLines(540, columnGap, launchpadItems);
    const mediumOptions = medium.find((item) => item.id === "options")!;
    const mediumActions = medium.find((item) => item.id === "actions")!;
    expect(mediumOptions.line).toBe(1);
    expect(mediumActions.line).toBe(1);
    expect(mediumActions.right).toBe(540);
    expect(mediumActions.left - mediumOptions.right).toBeGreaterThanOrEqual(columnGap);

    // Wide pane (~900px): every control and the send actions fit on one single row.
    const wide = packFlexLines(900, columnGap, launchpadItems);
    expect(new Set(wide.map((item) => item.line))).toEqual(new Set([0]));
    expect(wide.find((item) => item.id === "actions")!.right).toBe(900);

    // Across every pane width >= 300px, actions stay flush-right and never overlap the prior item.
    for (const paneWidth of [300, 360, 420, 480, 540, 620, 740, 900, 940]) {
      const placed = packFlexLines(paneWidth, columnGap, launchpadItems);
      const placedActions = placed.find((item) => item.id === "actions")!;
      const prior = placed[placed.length - 2]!;
      expect(placedActions.right).toBe(paneWidth);
      if (placedActions.line === prior.line) {
        expect(placedActions.left - prior.right).toBeGreaterThanOrEqual(columnGap);
      }
    }
  });
});
