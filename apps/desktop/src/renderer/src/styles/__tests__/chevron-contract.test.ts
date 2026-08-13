import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Locks the shared disclosure-chevron language (PR #795). Every inline
 * expand/collapse chevron must point RIGHT when collapsed (`rotate(-45deg)`)
 * and rotate 90deg to point DOWN when expanded (`rotate(45deg)`). The
 * direction lives entirely in CSS, so it can only be asserted here, not in
 * a render test.
 *
 * The SIDEBAR is a deliberate FILLED-triangle family, asserted separately:
 * the thread-tree toggle, the directory header, and the directory-threads
 * divider all draw the same solid caret (2026-08 density pass — the
 * directory rows used to carry the unfilled language, which left the one
 * navigation surface speaking two disclosure vocabularies). Filled =
 * sidebar navigation tree, unfilled = inline content disclosure
 * (transcript, settings, live-work rail).
 */
const testDir = path.dirname(fileURLToPath(import.meta.url));
const css = readFileSync(path.resolve(testDir, "../app.css"), "utf8");

/** Body of the first top-level CSS rule whose selector matches exactly. */
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(
    new RegExp(`(?:^|\\n)${escaped}\\s*\\{(?<body>[\\s\\S]*?)\\n\\}`)
  );
  if (!match?.groups?.body) {
    throw new Error(`Expected app.css to define ${selector}`);
  }
  return match.groups.body;
}

// Each row names the selector that styles the COLLAPSED state and the one
// that styles the EXPANDED state. (For most chevrons the base element rule
// is the collapsed state; for the settings header the base is the expanded
// state because the panel defaults to open — either way the contract is the
// same: collapsed -> rotate(-45deg), expanded -> rotate(45deg).)
const INLINE_CHEVRONS: Array<{ name: string; collapsed: string; expanded: string }> = [
  {
    name: "transcript activity entry",
    collapsed: ".transcript-activity__chevron",
    expanded: '.transcript-activity__toggle[aria-expanded="true"] .transcript-activity__chevron',
  },
  {
    name: "transcript activity nested detail",
    collapsed: ".transcript-activity__chevron",
    expanded:
      '.transcript-activity__detail-toggle[aria-expanded="true"] .transcript-activity__chevron',
  },
  {
    name: "previous-messages work-phase group",
    collapsed: ".transcript-work-phase-group__chevron",
    expanded:
      '.transcript-work-phase-group__toggle[aria-expanded="true"] .transcript-work-phase-group__chevron',
  },
  {
    name: "settings section header",
    collapsed: ".settings-panel--is-collapsed .settings-section__chevron::before",
    expanded: ".settings-section__chevron::before",
  },
  {
    name: "edited-files group toggle",
    collapsed: '.edited-file-groups__group-toggle[aria-expanded="false"] .live-work-rail__chevron',
    expanded: '.edited-file-groups__group-toggle[aria-expanded="true"] .live-work-rail__chevron',
  },
  {
    name: "live-work-rail file toggle",
    collapsed: '.live-work-rail__file-toggle[aria-expanded="false"] .live-work-rail__chevron',
    expanded: '.live-work-rail__file-toggle[aria-expanded="true"] .live-work-rail__chevron',
  },
  {
    name: "unpublished commit toggle",
    collapsed: '.unpublished-commit__toggle[aria-expanded="false"] .live-work-rail__chevron',
    expanded: '.unpublished-commit__toggle[aria-expanded="true"] .live-work-rail__chevron',
  },
];

const NON_ARIA_STATE_CHEVRONS = INLINE_CHEVRONS.filter(
  ({ collapsed, expanded }) =>
    !collapsed.includes("aria-expanded")
    && !expanded.includes("aria-expanded"),
);

// The base element rule that paints each unfilled chevron's "V" shape.
// (`.directory-row__chevron` left this list in the 2026-08 density pass —
// it now belongs to the sidebar's filled-triangle family below.)
const UNFILLED_BASE_RULES = [
  ".transcript-activity__chevron",
  ".transcript-work-phase-group__chevron",
  ".transcript-monitor-result__chevron",
  ".settings-section__chevron::before",
  ".live-work-rail__chevron",
];

// Every chevron that sits DIRECTLY in a flex toggle needs a shrink guard: the
// label beside it can only shrink so far, so past that the flex algorithm eats
// the glyph itself. `.live-work-rail__chevron` shipped without one and
// collapsed to 7.1px at a 240px rail and 5.4px at 200px, while the file rows
// (a grid, immune to flex shrink) stayed 8px -- two sizes of chevron in one
// column. `.settings-section__chevron` is the odd one out: the guard belongs on
// that host span, a fixed 16x16 inline-flex box, and NOT on the ::before that
// paints the V, which a fixed-size host can never squeeze.
const SHRINK_GUARDED_CHEVRONS = [
  ".transcript-activity__chevron",
  ".transcript-work-phase-group__chevron",
  ".transcript-monitor-result__chevron",
  ".directory-row__chevron",
  ".settings-section__chevron",
  ".live-work-rail__chevron",
];

/** Collapse whitespace so a CSS selector wrapped across lines still compares. */
function normalizeSelector(selector: string): string {
  return selector.trim().replace(/\s+/g, " ");
}

/** The single rotate() a chevron rule applies, or undefined if it applies none. */
function rotationOf(body: string): string | undefined {
  const rotations = body.match(/rotate\([^)]*\)/g) ?? [];
  return rotations.length === 1 ? rotations[0] : undefined;
}

type SweptRule = {
  selector: string;
  /** Selector with the state normalized out, so both states of one toggle pair up. */
  pairKey: string;
  state: "true" | "false";
  /** The chevron class the rule targets, e.g. ".live-work-rail__chevron". */
  chevron: string;
  rotations: string[];
};

/**
 * Every `aria-expanded` chevron rule in app.css that rotates its glyph,
 * whether or not anyone remembered to enumerate it above. Matches rules
 * nested inside `@media` / `@supports` too, since their selectors still
 * start on their own line.
 */
function sweepStateRules(): SweptRule[] {
  // Strip comments first: a rule's leading comment can otherwise carry
  // "chevron" or a rotate() into the match and skew the selector.
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const swept: SweptRule[] = [];

  for (const rule of stripped.matchAll(/(?:^|\n)([^{}\n][^{}]*?)\{([^{}]*)\}/g)) {
    const selector = normalizeSelector(rule[1]);
    const body = rule[2];
    const state = selector.match(/aria-expanded="(true|false)"/);
    if (!selector.includes("chevron") || !state || !/transform\s*:/.test(body)) {
      continue;
    }
    const chevrons = selector.match(/\.[\w-]*chevron[\w-]*/g) ?? [];
    swept.push({
      selector,
      pairKey: selector.replace(/aria-expanded="(true|false)"/, "aria-expanded"),
      state: state[1] as "true" | "false",
      chevron: chevrons[chevrons.length - 1] ?? "",
      rotations: body.match(/rotate\([^)]*\)/g) ?? [],
    });
  }

  return swept;
}

describe("chevron disclosure direction contract", () => {
  // The generic aria-expanded sweep below covers those state pairs. These
  // two legacy state selectors do not use aria-expanded, so keep their
  // direction contract explicit without re-running every swept pair.
  it.each(NON_ARIA_STATE_CHEVRONS)(
    "$name points right when collapsed and down when expanded",
    ({ collapsed, expanded }) => {
      const body = ruleBody(collapsed);
      expect(body).toContain("rotate(-45deg)");
      // "rotate(-45deg)" never contains the substring "rotate(45deg)", so
      // this guards against an expanded value leaking into a collapsed rule.
      expect(body).not.toContain("rotate(45deg)");

      const expandedBody = ruleBody(expanded);
      expect(expandedBody).toContain("rotate(45deg)");
      expect(expandedBody).not.toContain("rotate(-45deg)");
    },
  );

  it.each(UNFILLED_BASE_RULES)("%s is an unfilled border chevron", (selector) => {
    const body = ruleBody(selector);
    expect(body).toContain("border-right");
    expect(body).toContain("border-bottom");
  });

  it("never uses the old 180deg flip (rotate(225deg)) anywhere", () => {
    // The pre-#795 transcript/directory chevrons flipped down->up via
    // rotate(225deg). The unified language never does; guard against it
    // creeping back in on any selector.
    expect(css).not.toContain("rotate(225deg)");
  });

  // The list above only covers chevrons somebody remembered to add. The
  // unpublished-commit toggle shipped with rotate(0deg)/rotate(-90deg) — a
  // right-angle elbow rather than a chevron, in both states — precisely
  // because it was never enumerated here. The two sweeps below need no
  // per-selector maintenance.
  it("points every aria-expanded chevron rule the right way, enumerated or not", () => {
    const offenders = sweepStateRules()
      .map((rule) => {
        const want = rule.state === "true" ? "rotate(45deg)" : "rotate(-45deg)";
        return rotationOf(rule.rotations.join(" ")) === want
          ? undefined
          : `${rule.selector} => ${rule.rotations.join(", ") || "(no rotate)"}, want ${want}`;
      })
      .filter(Boolean);

    expect(offenders).toEqual([]);
  });

  // Direction alone is not enough: a toggle can be pointed correctly in the
  // one state it declares and still never MOVE, which is how the
  // edited-file-groups header once sat stuck pointing down in both states
  // (see the comment above its rotation hooks in app.css). Most chevrons
  // declare only one state and inherit the other from the base rule, so the
  // check is that base + declared covers both directions — not that both
  // aria-expanded rules exist.
  it("leaves no aria-expanded chevron stuck in one direction", () => {
    const byPair = new Map<string, SweptRule[]>();
    for (const rule of sweepStateRules()) {
      byPair.set(rule.pairKey, [...(byPair.get(rule.pairKey) ?? []), rule]);
    }

    const stuck: string[] = [];
    for (const [pairKey, rules] of byPair) {
      const covered = new Set(
        rules.map((rule) => rotationOf(rule.rotations.join(" "))).filter(Boolean)
      );
      // The state the toggle does not declare falls through to the base rule.
      const base = rotationOf(ruleBody(rules[0].chevron));
      if (base) {
        covered.add(base);
      }
      if (!covered.has("rotate(-45deg)") || !covered.has("rotate(45deg)")) {
        stuck.push(`${pairKey} only ever reaches ${[...covered].join(", ") || "(nothing)"}`);
      }
    }

    expect(stuck).toEqual([]);
  });

  // Guards both sweeps against passing vacuously: a regex that silently stops
  // matching would otherwise look green forever. Tied to the enumerated list
  // rather than a hardcoded count, so it stays honest as rows come and go.
  it("visits every aria-expanded selector the enumerated list names", () => {
    const visited = new Set(sweepStateRules().map((rule) => rule.selector));
    const enumerated = INLINE_CHEVRONS.flatMap(({ collapsed, expanded }) => [
      collapsed,
      expanded,
    ])
      .filter((selector) => selector.includes("aria-expanded"))
      .map(normalizeSelector);

    expect(enumerated.length).toBeGreaterThan(0);
    expect([...visited]).toEqual(expect.arrayContaining(enumerated));
  });

  // A CSS-only sweep cannot see a toggle that has NO rotation rule at all —
  // that lives in TSX. The render-side counterpart is
  // features/thread-detail/__tests__/chevron-placement.test.tsx and the
  // ThreadContextPanel commit-toggle structure test.
  it.each(SHRINK_GUARDED_CHEVRONS)("%s cannot be squeezed by a flex toggle", (selector) => {
    expect(ruleBody(selector)).toMatch(/flex:\s*0 0 auto/);
  });

  it("keeps the sidebar as one deliberate FILLED-triangle family", () => {
    // Intentionally NOT the unfilled -45/45 language: filled = sidebar
    // navigation tree, unfilled = inline content disclosure. A solid
    // triangle via border-left that swings 0 -> 90deg — on the
    // thread-tree toggle, the directory header, and the
    // directory-threads divider alike, so the sidebar speaks a single
    // disclosure vocabulary.
    for (const [base, open] of [
      [".thread-row__subthread-toggle::before", ".thread-row__subthread-toggle.is-open::before"],
      [".directory-row__chevron", ".directory-row__chevron.is-open"],
      [
        ".directory-row__thread-divider-chevron",
        ".directory-row__thread-divider-chevron.is-open",
      ],
    ] as const) {
      expect(ruleBody(base), `${base} filled caret`).toContain("border-left");
      expect(ruleBody(base), `${base} filled caret`).not.toContain("border-right");
      expect(ruleBody(open), `${open} swing`).toContain("rotate(90deg)");
    }
  });
});
