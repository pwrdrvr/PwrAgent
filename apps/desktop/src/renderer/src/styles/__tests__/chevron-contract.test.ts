import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Locks the shared disclosure-chevron language (PR #795). Every inline
 * expand/collapse chevron must point RIGHT when collapsed (`rotate(-45deg)`)
 * and rotate 90deg to point DOWN when expanded (`rotate(45deg)`). The
 * direction lives entirely in CSS, so it can only be asserted here, not in
 * a render test. The sidebar tree is a deliberate FILLED-triangle family
 * and is asserted separately.
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
];

// The base element rule that paints each unfilled chevron's "V" shape.
const UNFILLED_BASE_RULES = [
  ".transcript-activity__chevron",
  ".transcript-work-phase-group__chevron",
  ".settings-section__chevron::before",
  ".live-work-rail__chevron",
];

describe("chevron disclosure direction contract", () => {
  it.each(INLINE_CHEVRONS)(
    "$name points right when collapsed (rotate(-45deg))",
    ({ collapsed }) => {
      const body = ruleBody(collapsed);
      expect(body).toContain("rotate(-45deg)");
      // "rotate(-45deg)" never contains the substring "rotate(45deg)", so
      // this guards against an expanded value leaking into a collapsed rule.
      expect(body).not.toContain("rotate(45deg)");
    }
  );

  it.each(INLINE_CHEVRONS)(
    "$name points down when expanded (rotate(45deg))",
    ({ expanded }) => {
      const body = ruleBody(expanded);
      expect(body).toContain("rotate(45deg)");
      expect(body).not.toContain("rotate(-45deg)");
    }
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

  it("keeps the sidebar as one deliberate FILLED-triangle family", () => {
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
