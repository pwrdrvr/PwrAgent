import { describe, expect, it } from "vitest";

import { appCss, cssRuleBodies, firstCssRuleBody } from "./css-rule-body";

/** A rule's declarations without its comments, which may quote other values. */
const ruleBody = (selector: string) => firstCssRuleBody(selector).replace(/\/\*[\s\S]*?\*\//g, "");

/** Every standalone or trailing-in-a-group rule for a selector, joined. */
const allRuleBodies = (selector: string) => cssRuleBodies(selector).join("\n");

const GROUP_HEADER =
  '.transcript-list__items .transcript-work-phase-group[data-expanded="true"] > .transcript-work-phase-group__header';
const ACTIVITY_HEADER =
  '.transcript-list__items .transcript-activity[data-expanded="true"]:not(.transcript-activity--warning) > :is(.transcript-activity__header, .transcript-thread-tool__header)';
const DETAIL_ROW =
  '.transcript-list__items .transcript-activity__detail[data-expanded="true"] > .transcript-activity__detail-row';

/**
 * Locks the declarations that keep open transcript work one click from
 * closed and inside the pane. jsdom does no layout, so the geometry itself is
 * asserted in Chromium by `e2e/transcript-pinned-headers.spec.ts`; this file
 * pins the stylesheet facts that geometry rests on, so a later edit that
 * breaks one fails here first, with the reason.
 */
describe("transcript pinned headers contract", () => {
  it("gives an open work group a box for its toggle to pin within", () => {
    // Under `display: contents` the toggle's containing block was the whole
    // transcript, so a pinned toggle could never unpin.
    const group = ruleBody(".transcript-work-phase-group");
    expect(group).toMatch(/display:\s*flex/);
    expect(group).not.toMatch(/display:\s*contents/);
    // The gap its children had as items of the transcript column.
    const column = ruleBody(".transcript-list__content").match(/gap:\s*([^;]+);/)?.[1];
    expect(group).toMatch(new RegExp(`gap:\\s*${column};`));
  });

  it("pins the three disclosure levels only while they are open", () => {
    expect(appCss).toContain(`${GROUP_HEADER},\n${ACTIVITY_HEADER},\n${DETAIL_ROW} {\n  position: sticky;`);
    for (const selector of [GROUP_HEADER, ACTIVITY_HEADER, DETAIL_ROW]) {
      expect(selector).toContain('[data-expanded="true"]');
    }
  });

  it("stacks the levels in nesting order, outermost on top", () => {
    const group = allRuleBodies(GROUP_HEADER);
    const activity = allRuleBodies(ACTIVITY_HEADER);
    const detail = allRuleBodies(DETAIL_ROW);
    expect(group).toMatch(/top:\s*0;/);
    expect(activity).toMatch(/top:\s*var\(--transcript-pin-group, 0px\);/);
    expect(detail).toMatch(
      /top:\s*calc\(var\(--transcript-pin-group, 0px\) \+ var\(--transcript-pin-activity, 0px\)\);/,
    );
    const z = (body: string) => Number(body.match(/z-index:\s*(\d+)/)?.[1]);
    expect(z(group)).toBeGreaterThan(z(activity));
    expect(z(activity)).toBeGreaterThan(z(detail));
  });

  it("each open level contributes one step, and only an open one does", () => {
    expect(ruleBody('.transcript-work-phase-group[data-expanded="true"]'))
      .toMatch(/--transcript-pin-group:\s*var\(--transcript-pin-step\)/);
    expect(ruleBody('.transcript-activity[data-expanded="true"]:not(.transcript-activity--warning)'))
      .toMatch(/--transcript-pin-activity:\s*var\(--transcript-pin-step\)/);
    expect(ruleBody('.transcript-activity__detail[data-expanded="true"]'))
      .toMatch(/--transcript-pin-detail:\s*var\(--transcript-pin-step\)/);
  });

  it("paints a pinned header's surface only while it is stuck, from the scrollport's top edge", () => {
    // At rest a surface would cover the row above; the header pins at the
    // scroller's content edge, so the stuck surface reaches up over the
    // scroller's top padding.
    const padTop = ruleBody(".transcript-list__items").match(/padding:\s*(\d+px)/)?.[1];
    const stuck = appCss.match(
      /@container scroll-state\(stuck: top\) \{\s*\.transcript-list__items \.transcript-work-phase-group[^{]*\{([^}]*)\}/,
    )?.[1] ?? "";
    expect(stuck).toMatch(new RegExp(`top:\\s*-${padTop};`));
    expect(stuck).toMatch(/background:\s*var\(--bg-app\)/);
    expect(firstCssRuleBody(`${GROUP_HEADER}::before,\n${ACTIVITY_HEADER}::before,\n${DETAIL_ROW}::before`))
      .not.toMatch(/background/);
  });

  it("cuts a command card to the scrollport less the headers pinned above it", () => {
    const card = ruleBody(".transcript-command");
    expect(card).toMatch(/max-height:/);
    for (const level of ["group", "activity", "detail"]) {
      expect(card).toContain(`- var(--transcript-pin-${level}, 0px)`);
    }
    expect(card).toContain("var(--transcript-scrollport-height, 80vh)");
    // Both panes give up height; neither is squeezed under its own floor.
    const panes = ruleBody(".transcript-command__block,\n.transcript-command__output");
    expect(panes).toMatch(/flex:\s*0 1 auto/);
    expect(panes).toMatch(/overflow-y:\s*auto/);
    expect(panes).toMatch(/min-height:\s*calc\(var\(--transcript-pane-lines, 1\)/);
  });
});
