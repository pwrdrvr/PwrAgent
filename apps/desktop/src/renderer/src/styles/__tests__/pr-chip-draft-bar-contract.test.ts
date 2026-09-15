import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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
 * every `.pr-chip` height the stylesheet declares and checks the bar still
 * lands inside the pill.
 *
 * Geometry is a layout outcome and jsdom does not lay out CSS, so what is
 * asserted here is the arithmetic behind the measurements above. Change an
 * assertion in the same commit as any deliberate change to the affordance.
 */
const testDir = path.dirname(fileURLToPath(import.meta.url));
const css = readFileSync(path.resolve(testDir, "../app.css"), "utf8");

/** Body of the first top-level CSS rule whose selector matches exactly.
 *
 * Descendant combinators match any run of whitespace so a selector the file
 * wraps across lines still resolves — app.css wraps the long ones. */
function ruleBody(selector: string): string {
  const pattern = selector
    .trim()
    .split(/\s+/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
  const match = css.match(
    new RegExp(`(?:^|\\n)${pattern}\\s*\\{(?<body>[\\s\\S]*?)\\n\\}`)
  );
  if (!match?.groups?.body) {
    throw new Error(`Expected app.css to define ${selector}`);
  }
  return match.groups.body;
}

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

/** The gap the base pill draws between the label box and the bar. */
const BASE_GAP_PX = 0.5;

/**
 * Smallest gap between the bar and the pill's inner edge that still survives
 * compositing as a gap. Verified at DPR 2, where 0.5px is one device pixel —
 * it is what the ⌘K palette row's 19px pill has left after the bar, and the
 * floor every shorter context has to be measured against.
 */
const MIN_INSET_PX = 0.5;

describe("PR chip draft bar contract", () => {
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
    const lift = liftPx(
      declaration(ruleBody(DRAFT_LABEL), "transform"),
      "the draft label lift"
    );
    expect(px(declaration(ruleBody(BAR), "margin-top"), "the bar offset")).toBe(
      LABEL_LINE_BOX_PX / 2 - lift + BASE_GAP_PX
    );

    // The dot rides with the label or the chip's contents come apart, and the
    // offset above would then be right for only one of them.
    expect(declaration(ruleBody(DRAFT_DOT), "transform")).toBe(
      declaration(ruleBody(DRAFT_LABEL), "transform")
    );
  });

  it("keeps the card composer's scaled bar inside the same gap rule", () => {
    // The 16.19px pill cannot hold a 2px bar at the shared offset — it hangs
    // past the pill's bottom edge — so it scales the bar and moves it up. The
    // one thing that must NOT change with it is the direction: the override
    // may only ever sit closer to the text than the shared rule, never
    // further, or it is drawing outside its own pill.
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
  });

  it("leaves the bar room inside every pill height the file declares", () => {
    const barOffset = px(declaration(ruleBody(BAR), "margin-top"), "bar offset");
    const barHeight = px(declaration(ruleBody(BAR), "height"), "bar height");
    const border = px(
      declaration(ruleBody(BASE_CHIP), "border")?.split(/\s+/)[0],
      "the chip border width"
    );

    // Every context that resizes the pill. The two composers derive theirs
    // from the paragraph they interrupt, so read both halves rather than
    // restating the product — retuning either composer's font-size has to
    // reach this check.
    const heights: Array<[string, number, number, number]> = [
      ["base pill", px(declaration(ruleBody(BASE_CHIP), "height"), "base pill"), barOffset, barHeight],
      [
        "sidebar row",
        px(
          declaration(ruleBody(".thread-row__chips .pr-chip"), "height"),
          "sidebar row pill"
        ),
        barOffset,
        barHeight,
      ],
      [
        "⌘K palette row",
        px(
          declaration(ruleBody(".jump-palette__row-prs .pr-chip"), "height"),
          "palette row pill"
        ),
        barOffset,
        barHeight,
      ],
      [
        "composer",
        emHeight(MENTION, COMPOSER, "composer"),
        barOffset,
        barHeight,
      ],
      [
        "card composer",
        emHeight(COMPACT_MENTION, COMPACT_COMPOSER, "card composer"),
        px(declaration(ruleBody(COMPACT_BAR), "margin-top"), "card bar offset"),
        px(declaration(ruleBody(COMPACT_BAR), "height"), "card bar height"),
      ],
    ];

    for (const [name, height, offset, thickness] of heights) {
      // Half the padding box is how far the centerline is from the pill's
      // inner edge; the bar reaches `offset + thickness` of it.
      const room = height / 2 - border;
      expect(room - (offset + thickness), `${name}, room under the bar`)
        .toBeGreaterThanOrEqual(MIN_INSET_PX);
    }

    // A new context that shrinks the pill has to land in the list above, so
    // fail when the file grows one this test does not know about. Matches
    // rules whose selector ENDS at the chip — `.pr-chip__dot` and friends
    // carry their own heights and are not pills.
    const sized = new Set<string>();
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
        if (/\.pr-chip\s*$/.test(selector)) {
          sized.add(selector.trim().replace(/\s+/g, " "));
        }
      }
    }
    expect([...sized].sort()).toEqual([
      ".jump-palette__row-prs .pr-chip",
      ".pr-chip",
      ".thread-row__chips .pr-chip",
    ]);
  });
});

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
