import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Locks the vertical alignment of the composer's inline mention chips
 * (`$skill`, `@file`, `@directory`, `#thread`, PR pill) against the
 * paragraph baseline.
 *
 * Alignment is a layout outcome and jsdom does not lay out CSS, so what is
 * asserted here is every declaration the outcome depends on. That is a
 * narrower net than it sounds: with the `::before` strut in place the chips
 * no longer take their baseline from whichever child happens to be first,
 * so a DOM change in `ComposerTiptapInput`'s `renderHTML` can no longer
 * move them — only these declarations can. Change an assertion in the same
 * commit as any deliberate change to the alignment.
 *
 * What this cannot see: `align-items` and `font-size` reaching the chip
 * from `.chip` / `.pr-chip`, and anything that only shows up in real
 * layout. Measuring the chips themselves needs a browser.
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

const MENTION = ".composer-tiptap-input__editor .composer-tiptap-input__mention";
const STRUT = `${MENTION}::before`;
const COMPACT_MENTION = `.compact-composer ${MENTION}`;
const PR_CHIP = ".composer-tiptap-input__editor .pr-chip.composer-pr-chip";
const PR_STRUT = `${PR_CHIP}::before`;
const PR_LABEL = `${PR_CHIP} .pr-chip__label`;

describe("composer inline chip alignment contract", () => {
  it("aligns every mention chip on the paragraph baseline, not a nudge", () => {
    // A length here would reintroduce the per-kind spread: it is measured
    // from the chip's own synthesized baseline, and the strut — not the
    // nudge — is what makes that baseline uniform.
    expect(declaration(ruleBody(MENTION), "vertical-align")).toBe("baseline");
  });

  it("keeps the zero-width baseline strut in front of every chip", () => {
    // U+200B, with empty alt text so it stays out of accessible names. The
    // strut must carry text: an empty box synthesizes its baseline from its
    // bottom edge and the chip kinds go back to disagreeing.
    expect(declaration(ruleBody(STRUT), "content")).toBe('"\\200b" / ""');
  });

  it("cancels exactly the one flex gap the strut opens", () => {
    const gap = declaration(ruleBody(MENTION), "gap");
    const cancel = declaration(ruleBody(STRUT), "margin-inline-end");

    // The strut is a real flex item, so `gap` applies in front of the
    // icon/dot until this margin takes it back. Drift between the two
    // shifts every chip's contents sideways.
    expect(cancel).toBe(`-${gap}`);
  });

  it("keeps the strut's own line box unstyled", () => {
    // The strut is text, so its baseline sits inside its line box. A
    // unitless or fixed `line-height` here would move that box — and every
    // chip with it — without touching anything that reads as alignment.
    expect(declaration(ruleBody(MENTION), "line-height")).toBe("normal");
  });

  it("keeps chips inside the line box they interrupt", () => {
    // The ceiling is a share of the line box, not a fixed `em`: the strut is
    // centered and sits at the paragraph's own font size, so a chip fills its
    // line exactly when its height reaches `line-height`. Measured in
    // headless Chromium against this stylesheet, 1.45em (20.3px of a 22.4px
    // line box) leaves the chip paragraph exactly two line-units tall and
    // 1.55em does not.
    expect(declaration(ruleBody(MENTION), "height")).toBe("1.45em");
  });

  it("steps the height back for the card composer's shorter line box", () => {
    // `.compact-composer` runs 12px/1.5. The same 1.45em is 17.4px of an 18px
    // line box there and pushes every line it lands on; 1.35em is the same
    // ~0.9 share the full composer gets.
    expect(declaration(ruleBody(COMPACT_MENTION), "height")).toBe("1.35em");
  });

  it("keeps the PR pill's internals on .pr-chip's own pixels", () => {
    // The PR pill is the only mention chip that draws a border, so it is the
    // only one whose padding is visible. Sizing its internals off the 14px
    // paragraph put a 14px label in the chip-scale box; these three restore
    // the dot, gap, and padding the sidebar row and the transcript draw.
    const body = ruleBody(PR_CHIP);
    expect(declaration(body, "gap")).toBe("6px");
    expect(declaration(body, "padding")).toBe("0 8px");
    expect(declaration(ruleBody(PR_LABEL), "font-size")).toBe("11px");
  });

  it("cancels the PR pill's own gap, not the shared one", () => {
    // Same invariant as the shared rule above, restated because this chip
    // overrides `gap`. Left at the shared `-0.35em` the uncancelled 1.1px
    // walks the dot off the padding.
    expect(declaration(ruleBody(PR_STRUT), "margin-inline-end")).toBe(
      `-${declaration(ruleBody(PR_CHIP), "gap")}`
    );
  });

  it("sizes the PR pill's label, never the chip, so the strut stays put", () => {
    // The strut is sized in `em` off the chip. Shrinking the CHIP's font-size
    // would shrink the strut with it and drop this chip's baseline out from
    // under its 14px siblings on the same line (1.1px, measured). Only the
    // label may carry the smaller size; `align-items: center` places it.
    expect(declaration(ruleBody(PR_CHIP), "font-size")).toBeUndefined();
  });

  it("does not leave an unqualified base rule to lose the cascade with", () => {
    // `.chip` (24px/12px) and `.pr-chip` (22px/11px) are row and header
    // geometry. The composer's em-based sizing has to outrank them on
    // specificity, not on where these rules land in the file.
    expect(css).not.toMatch(/\n\.composer-tiptap-input__mention\s*\{/);
  });
});
