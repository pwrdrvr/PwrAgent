import { describe, expect, it } from "vitest";

import { appCss } from "./css-rule-body";
import { parseStyleRules } from "./css-style-rules";

/**
 * The thread list never scrolls sideways.
 *
 * It did. The lane (`.sidebar-list--dense`, `.directory-groups`) sets only
 * `overflow-y: auto`, which makes its x axis `auto` too, so any one row wider
 * than the lane turned the whole list into a horizontal scroller and shifted
 * every row's titles and chips off the left edge. Two row parts could be that
 * row, both found by rendering the real `Sidebar` in headless Chromium against
 * 1,000 generated thread populations (adversarial titles, paths, branch and
 * repository names, sub-agents, PR stacks; every lens, density, and sidebar
 * width) and checking each lane's `scrollWidth` against its `clientWidth`:
 * 923 of 1,000 overflowed before this change and none after it.
 *
 * - An expanded Sub-agents tray. `.native-subagents__list` was a grid with an
 *   implicit `auto` column, whose minimum is its widest row's min-content, and
 *   a sub-agent label is one nowrap line. A Claude worker named by a worktree
 *   path (`Running cd /Users/…/worktrees/mwy9dh26/docs.pwragent.ai && …`) grew
 *   the column 279px past a 340px lane.
 * - A repo-prefixed PR chip (`org/repo#123`, shown when a row's PRs span
 *   repositories). The chip had no width bound and its label could not
 *   shrink, so a long repository name pushed it 212px past the same lane;
 *   with a stack tag beside it the label sat one level deeper and did the same.
 *
 * jsdom has no layout engine, so the invariants that hold the rows inside the
 * lane are pinned here in the stylesheet.
 */
const rules = parseStyleRules(appCss);

function declarations(selector: string): string {
  const matching = rules.filter((rule) => rule.atRules.length === 0 && rule.selectors.includes(selector));
  if (matching.length === 0) {
    throw new Error(`Expected app.css to define ${selector}`);
  }
  return matching.map((rule) => rule.body).join("\n");
}

function lastValue(selector: string, property: string): string | undefined {
  const pattern = new RegExp(`(?:^|[;\\s])${property}\\s*:\\s*([^;]+)`, "g");
  return [...declarations(selector).matchAll(pattern)].at(-1)?.[1]?.trim();
}

describe("sidebar lane horizontal overflow", () => {
  it.each([".sidebar-list--dense", ".directory-groups"])("%s never scrolls sideways", (lane) => {
    // `hidden`, not `clip`: beside `overflow-y: auto` a `clip` computes to
    // `hidden` anyway. The rules below are what keep rows inside; this keeps
    // one that slips through from panning the whole list.
    expect(lastValue(lane, "overflow-x")).toBe("hidden");
    expect(lastValue(lane, "overflow-y")).toBe("auto");
  });

  it("holds the sub-agent tray's column to the tray", () => {
    expect(lastValue(".native-subagents__list", "display")).toBe("grid");
    expect(lastValue(".native-subagents__list", "grid-template-columns")).toBe("minmax(0, 1fr)");
  });

  it("ellipsizes a sub-agent's label and caps its role", () => {
    expect(lastValue(".native-subagents__agent", "min-width")).toBe("0");
    expect(lastValue(".native-subagents__agent-label", "min-width")).toBe("0");
    expect(lastValue(".native-subagents__agent-label", "text-overflow")).toBe("ellipsis");
    expect(lastValue(".native-subagents__agent-role", "max-width")).toBe("45%");
    expect(lastValue(".native-subagents__agent-role", "text-overflow")).toBe("ellipsis");
  });

  it("keeps a working sub-agent's activity line to one line inside its row", () => {
    // Without these the line's nowrap text sets its own width: a generated
    // run with them stripped overflowed in 112 of 200 cases, in the tray and
    // in the Sub-agents panel alike.
    expect(lastValue(".native-subagents__agent-text", "min-width")).toBe("0");
    expect(lastValue(".native-subagents__agent-line", "min-width")).toBe("0");
    expect(lastValue(".native-subagents__agent-activity", "min-width")).toBe("0");
    expect(lastValue(".rail-card__activity", "min-width")).toBe("0");
    expect(lastValue(".sub-agent-activity", "min-width")).toBe("0");
    expect(lastValue(".sub-agent-activity", "overflow")).toBe("hidden");
    expect(lastValue(".sub-agent-activity", "white-space")).toBe("nowrap");
    expect(lastValue(".sub-agent-activity__head", "min-width")).toBe("0");
    expect(lastValue(".sub-agent-activity__head", "overflow")).toBe("hidden");
    expect(lastValue(".sub-agent-activity__head", "text-overflow")).toBe("ellipsis");
    expect(lastValue(".sub-agent-activity__tail", "flex")).toBe("0 0 auto");
  });

  it("bounds a PR chip by its line and lets only the repository prefix give way", () => {
    expect(lastValue(".pr-chip", "max-width")).toBe("100%");
    expect(lastValue(".pr-chip", "min-width")).toBe("0");
    for (const shrinker of [".pr-chip > .pr-chip__trigger", ".pr-chip > .pr-chip__label", ".pr-chip__trigger > .pr-chip__label"]) {
      expect(lastValue(shrinker, "min-width"), shrinker).toBe("0");
      expect(lastValue(shrinker, "flex-shrink"), shrinker).toBe("1");
    }
    expect(lastValue(".pr-chip__label", "overflow")).toBe("hidden");
    expect(lastValue(".pr-chip__repo", "min-width")).toBe("0");
    expect(lastValue(".pr-chip__repo", "overflow")).toBe("hidden");
    expect(lastValue(".pr-chip__repo", "text-overflow")).toBe("ellipsis");
  });
});
