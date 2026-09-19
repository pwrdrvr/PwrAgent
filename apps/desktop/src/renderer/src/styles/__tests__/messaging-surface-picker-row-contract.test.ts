import { describe, expect, it } from "vitest";

import { cssRuleBody } from "./css-rule-body";

/**
 * Locks how a messaging surface picker row spends its width.
 *
 * A row is one line: check, kind glyph, name, context, ID, last seen. The name
 * is the surface's own, the context is what it sits in, and the ID is what
 * tells two same-named rows apart. When the row cannot fit all of them, the
 * context gives way first, then the name, and the ID not at all.
 *
 * Before this the name slot held the whole path and could take 60% of the
 * row, and the ID had `flex: 1` of the rest. In a full 560px panel a Discord
 * thread read "Discord / Orchard Collective / orchard-plannin…" beside a
 * truncated 19-digit ID, so neither the part that differs nor the part that
 * disambiguates could be read.
 *
 * jsdom performs no layout, so the declarations are all this suite can see.
 * The DOM order they rely on is pinned in MessagingSurfacePicker.test.tsx.
 */
describe("messaging surface picker row contract", () => {
  const panel = ".messaging-surface-picker__panel";

  it("places the ID at its full width before anything else shrinks", () => {
    const id = cssRuleBody(`${panel} .project-picker__row-path`);
    expect(id).toMatch(/flex:\s*0 0 auto/);
    // The cap keeps a compound "topic / group" ID from taking a narrow row.
    expect(id).toMatch(/max-width:\s*50%/);
  });

  it("lays the context out from leftover space only", () => {
    const context = cssRuleBody(`${panel} .messaging-surface-picker__context`);
    // A zero basis never claims width that the name or the ID needed.
    expect(context).toMatch(/flex:\s*1 1 0\s*;/);
    expect(context).toMatch(/min-width:\s*0/);
    expect(context).toMatch(/text-overflow:\s*ellipsis/);
  });

  it("reserves no fixed share of the row for the name", () => {
    // A percentage cap here is what cut the ID short: the name took its share
    // before the ID was measured. And the cap has to be cleared, not dropped:
    // the shared `.project-picker__row-name` rule caps a name at 160px, which
    // cut a long thread name in half beside an empty context column when this
    // override was first written without it. Measured in Chromium, not here.
    const name = cssRuleBody(`${panel} .project-picker__row-name`);
    expect(name).toMatch(/flex:\s*0 1 auto/);
    expect(name).toMatch(/min-width:\s*0/);
    expect(name).toMatch(/max-width:\s*none/);
  });
});
