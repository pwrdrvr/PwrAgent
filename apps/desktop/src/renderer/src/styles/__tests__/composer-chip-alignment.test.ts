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

function declaration(body: string, property: string): string | undefined {
  const match = body.match(
    new RegExp(`(?:^|\\n)\\s*${property}:\\s*(?<value>[^;]+);`)
  );
  return match?.groups?.value.trim();
}

const MENTION = ".composer-tiptap-input__editor .composer-tiptap-input__mention";
const STRUT = `${MENTION}::before`;

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
    // 1.35em = 18.9px against the composer's 22.4px line box, which leaves
    // the chip 14.7px above and 4.2px below the baseline — inside the
    // 16.0/6.4 the text strut already claims, so a chip never pushes its
    // own line taller than a plain one.
    expect(declaration(ruleBody(MENTION), "height")).toBe("1.35em");
  });

  it("does not leave an unqualified base rule to lose the cascade with", () => {
    // `.chip` (24px/12px) and `.pr-chip` (22px/11px) are row and header
    // geometry. The composer's em-based sizing has to outrank them on
    // specificity, not on where these rules land in the file.
    expect(css).not.toMatch(/\n\.composer-tiptap-input__mention\s*\{/);
  });
});
