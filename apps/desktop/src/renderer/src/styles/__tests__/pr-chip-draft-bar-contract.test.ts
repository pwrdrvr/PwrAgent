import { describe, expect, it } from "vitest";
import { appCss as css, firstCssRuleBody as ruleBody } from "./css-rule-body";

/**
 * Locks the PR chip's draft bar against the pill it is drawn in.
 *
 * The bar is a 2px marker under the dot + number, and the gap between it and
 * the text is the whole affordance: without one it reads as an underline (or,
 * at the smallest size, a strikethrough) rather than as a draft marker. It was
 * positioned `bottom: 2px` — measured from the pill's bottom edge — while the
 * label it has to clear is vertically CENTERED, so every context that shrinks
 * the chip closed that gap by exactly the height it removed. Measured in
 * headless Chromium against this stylesheet, label box bottom -> bar top:
 *
 *     base pill        22px     +0.5px   (the designed clearance)
 *     sidebar row      20px     -0.5px
 *     ⌘K palette row   19px     -0.5px
 *     composer         20.3px   -0.34px
 *     card composer    16.19px  -2.41px  (drew through the digits)
 *
 * Anchoring the bar to the centerline instead makes that gap the base pill's
 * own at every height. What varies is the room left UNDER the bar, and that is
 * what a new, shorter chip context can run out of — so the last test walks
 * every pill height the stylesheet declares and checks the bar still lands
 * inside the pill.
 *
 * Geometry is a layout outcome and jsdom does not lay out CSS, so what is
 * asserted here is the arithmetic behind the measurements above. Change an
 * assertion in the same commit as any deliberate change to the affordance.
 */

function declaration(body: string, property: string): string | undefined {
  const match = body.match(
    new RegExp(`(?:^|\\n)\\s*${property}:\\s*(?<value>[^;]+);`)
  );
  return match?.groups?.value.trim();
}

/** `6px` -> 6. Anything that is not a plain px length is not this contract. */
function px(declared: string | undefined, label: string): number {
  const match = declared?.match(/^(?<number>-?[0-9]*\.?[0-9]+)px$/);
  if (!match?.groups?.number) {
    throw new Error(`Expected ${label} to be a px length, got ${declared}`);
  }
  return Number(match.groups.number);
}

/** `translateY(-1px)` -> 1. The lift is always upward. */
function liftPx(declared: string | undefined, label: string): number {
  const match = declared?.match(
    /^translateY\((?<number>-?[0-9]*\.?[0-9]+)px\)$/
  );
  if (!match?.groups?.number) {
    throw new Error(`Expected ${label} to be a translateY, got ${declared}`);
  }
  return -Number(match.groups.number);
}

const BAR = ".pr-chip__draft-bar";
const COMPACT_BAR =
  ".compact-composer .composer-tiptap-input__editor" +
  " .pr-chip.composer-pr-chip .pr-chip__draft-bar";
const DRAFT_LABEL = ".pr-chip--draft .pr-chip__label";
const DRAFT_DOT = ".pr-chip--draft .pr-chip__dot";
const BASE_CHIP = ".pr-chip";
const MENTION = ".composer-tiptap-input__editor .composer-tiptap-input__mention";
const COMPACT_MENTION = `.compact-composer ${MENTION}`;
const COMPOSER = ".composer-tiptap-input";
const COMPACT_COMPOSER = `.compact-composer ${COMPOSER}`;

/**
 * The label's line box: 11px `--font-mono` at `line-height: normal`. Measured
 * in headless Chromium against this stylesheet, and the same 13px in every
 * full-size context — the composer restates `.pr-chip`'s 11px on the label
 * rather than inheriting the paragraph's size. The ⌘K palette row is the one
 * that differs (10px text, a 12px box), which only ever makes its gap larger.
 */
const LABEL_LINE_BOX_PX = 13;

/**
 * Empty leading between the digits' baseline and the bottom of that line box,
 * measured off the font's own metrics in headless Chromium (canvas
 * `fontBoundingBoxDescent` against `actualBoundingBoxDescent` for `#412`).
 *
 * It is what makes a NEGATIVE box gap survivable: the card composer's bar
 * overlaps the label BOX by 1px and still clears the ink by 1.57px. Every
 * clearance floor below is therefore measured against the ink, not the box.
 */
const LABEL_DESCENDER_LEADING_PX = 2.57;

/** The gap the base pill draws between the label box and the bar. */
const BASE_GAP_PX = 0.5;

/**
 * Floor on the gap between the digits' ink and the bar, for a context that
 * cannot afford the base pill's own. The base pill draws 3.07px and the card
 * composer 1.57px; below about 1px the bar stops reading as a separate marker
 * and becomes an underline, which is the defect this file exists to prevent.
 */
const MIN_INK_GAP_PX = 1;

/**
 * Smallest gap between the bar and the pill's inner edge that still survives
 * compositing as a gap. Verified at DPR 2 (one device pixel) and again at
 * DPR 1 — it is what the ⌘K palette row's 19px pill has left after the bar,
 * and the floor every shorter context has to be measured against.
 */
const MIN_INSET_PX = 0.5;

/** How far the label's ink bottom sits below the pill's centerline. */
function inkBottomBelowCenterline(lift: number): number {
  return LABEL_LINE_BOX_PX / 2 - lift - LABEL_DESCENDER_LEADING_PX;
}

function draftLift(): number {
  return liftPx(
    declaration(ruleBody(DRAFT_LABEL), "transform"),
    "the draft label lift"
  );
}

/** Height of a composer mention chip in px: its `em` times the line box's
 *  own font-size. Both composers size the chip off the paragraph, so the
 *  product is the only form that survives retuning either one. */
function emHeight(chipRule: string, composerRule: string, name: string): number {
  const declared = declaration(ruleBody(chipRule), "height");
  const match = declared?.match(/^(?<number>[0-9]*\.?[0-9]+)em$/);
  if (!match?.groups?.number) {
    throw new Error(`Expected ${name} chip height in em, got ${declared}`);
  }
  const fontSize = px(
    declaration(ruleBody(composerRule), "font-size"),
    `${name} font-size`
  );
  return Number(match.groups.number) * fontSize;
}

describe("PR chip draft bar contract", () => {
  it("positions the bar against the pill at all", () => {
    // The precondition every other assertion here rests on. `top` and
    // `margin-top` are inert on a static box, and they resolve against the
    // wrong containing block without the positioned ancestor — so without
    // these two the whole file measures a geometry the browser never draws.
    expect(declaration(ruleBody(BAR), "position")).toBe("absolute");
    expect(declaration(ruleBody(BASE_CHIP), "position")).toBe("relative");
  });

  it("anchors the bar to the pill's centerline, not its bottom edge", () => {
    const body = ruleBody(BAR);

    // The bug this rule exists to prevent. `bottom` measures from an edge the
    // label is not placed against, so the gap becomes a function of the chip's
    // height and every smaller context silently loses it.
    expect(declaration(body, "bottom")).toBeUndefined();
    expect(declaration(body, "top")).toBe("50%");

    // And the per-context override does not reintroduce it either.
    expect(declaration(ruleBody(COMPACT_BAR), "bottom")).toBeUndefined();
  });

  it("offsets the bar by the label's own half-height, lift and gap", () => {
    // `margin-top` is measured from the centerline the label is centered on,
    // so it has to carry three terms: half the label's line box to reach its
    // bottom, the draft lift back off it, and the gap itself. Spelled out here
    // because the rule can only declare their sum.
    expect(px(declaration(ruleBody(BAR), "margin-top"), "the bar offset")).toBe(
      LABEL_LINE_BOX_PX / 2 - draftLift() + BASE_GAP_PX
    );

    // The dot rides with the label or the chip's contents come apart, and the
    // offset above would then be right for only one of them.
    expect(declaration(ruleBody(DRAFT_DOT), "transform")).toBe(
      declaration(ruleBody(DRAFT_LABEL), "transform")
    );
  });

  it("keeps the card composer's scaled bar clear of the digits", () => {
    // The 16.19px pill cannot hold a 2px bar at the shared offset — it hangs
    // past the pill's bottom edge — so it scales the bar and moves it up.
    // Moving up is what has to be bounded: the override may sit closer to the
    // text than the shared rule, but not so close that it lands on the ink,
    // which is the pre-fix defect in the context where it was worst (-2.41px
    // against the label box, 0.16px from the digits themselves).
    const shared = px(declaration(ruleBody(BAR), "margin-top"), "bar offset");
    const compact = px(
      declaration(ruleBody(COMPACT_BAR), "margin-top"),
      "card composer bar offset"
    );
    const sharedHeight = px(declaration(ruleBody(BAR), "height"), "bar height");
    const compactHeight = px(
      declaration(ruleBody(COMPACT_BAR), "height"),
      "card composer bar height"
    );

    expect(compact).toBeLessThan(shared);
    expect(compactHeight).toBeLessThan(sharedHeight);
    expect(
      compact - inkBottomBelowCenterline(draftLift()),
      "card composer bar, gap to the digits"
    ).toBeGreaterThanOrEqual(MIN_INK_GAP_PX);
  });

  it("leaves the bar room inside every pill height the file declares", () => {
    const sharedBar = {
      height: px(declaration(ruleBody(BAR), "height"), "bar height"),
      offset: px(declaration(ruleBody(BAR), "margin-top"), "bar offset"),
    };
    const compactBar = {
      height: px(declaration(ruleBody(COMPACT_BAR), "height"), "card bar height"),
      offset: px(declaration(ruleBody(COMPACT_BAR), "margin-top"), "card bar offset"),
    };
    const border = px(
      declaration(ruleBody(BASE_CHIP), "border")?.split(/\s+/)[0],
      "the chip border width"
    );

    // Every context that resizes the pill. The two composers derive theirs
    // from the paragraph they interrupt, so read both halves rather than
    // restating the product — retuning either composer's font-size has to
    // reach this check. `bar` defaults to the shared rule; only a context
    // with its own override names one.
    const pills: Array<{ bar?: typeof sharedBar; height: number; name: string }> = [
      {
        name: "base pill",
        height: px(declaration(ruleBody(BASE_CHIP), "height"), "base pill"),
      },
      {
        name: "sidebar row",
        height: px(
          declaration(ruleBody(".thread-row__chips .pr-chip"), "height"),
          "sidebar row pill"
        ),
      },
      {
        name: "⌘K palette row",
        height: px(
          declaration(ruleBody(".jump-palette__row-prs .pr-chip"), "height"),
          "palette row pill"
        ),
      },
      {
        name: "composer",
        height: emHeight(MENTION, COMPOSER, "composer"),
      },
      {
        bar: compactBar,
        name: "card composer",
        height: emHeight(COMPACT_MENTION, COMPACT_COMPOSER, "card composer"),
      },
    ];

    for (const pill of pills) {
      const bar = pill.bar ?? sharedBar;
      // Half the padding box is how far the centerline is from the pill's
      // inner edge; the bar reaches `offset + height` of it.
      const room = pill.height / 2 - border;
      expect(room - (bar.offset + bar.height), `${pill.name}, room under the bar`)
        .toBeGreaterThanOrEqual(MIN_INSET_PX);
    }

    // A new context that shrinks the pill has to land in the list above, so
    // fail when the file grows one this test does not know about. Two shapes
    // size a PR pill: a selector that ENDS at the chip (`.pr-chip__dot` and
    // friends carry their own heights and are not pills), and the composer's
    // `em` mention rule, which the PR pill shares with every other inline
    // chip and which no `.pr-chip` selector would reveal.
    const sized = { mention: new Set<string>(), pill: new Set<string>() };
    // Comments first: several of them end a sentence right above the rule they
    // describe, and the tail would otherwise read as part of the selector.
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const [, , selectors, body] of rules.matchAll(
      /(^|\n)([^@{}][^{}]*?)\{([^{}]*)\}/g
    )) {
      if (!/(^|\n)\s*height:/.test(body)) {
        continue;
      }
      for (const selector of selectors.split(",")) {
        const normalized = selector.trim().replace(/\s+/g, " ");
        if (/\.pr-chip$/.test(normalized)) {
          sized.pill.add(normalized);
        } else if (/\.composer-tiptap-input__mention$/.test(normalized)) {
          sized.mention.add(normalized);
        }
      }
    }
    expect([...sized.pill].sort()).toEqual([
      ".jump-palette__row-prs .pr-chip",
      ".pr-chip",
      ".thread-row__chips .pr-chip",
    ]);
    expect([...sized.mention].sort()).toEqual([COMPACT_MENTION, MENTION]);
  });
});
