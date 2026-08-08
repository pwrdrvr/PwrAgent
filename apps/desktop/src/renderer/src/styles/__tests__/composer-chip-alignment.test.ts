import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Locks the vertical alignment contract for the composer's inline mention
 * chips (`$skill`, `@file`, `@directory`, `#thread`, PR pill).
 *
 * These chips are inline-flex, and an inline-flex box takes its baseline
 * from its FIRST flex item. The kinds do not agree on what that item is:
 * the `$`/`@` chips lead with their label text, `#thread` leads with a 1em
 * SVG icon, and the PR pill leads with an 8px dot — each of which sits at
 * a different height. A shared `vertical-align: <length>` is therefore
 * measured from three different origins and lands in three places (the
 * shipped 0.13em nudge spread the chips over 3.0px on an 18.9px chip).
 *
 * The fix is a zero-width-space `::before` strut that gives every kind the
 * same text baseline, plus `vertical-align: baseline` so that baseline is
 * the paragraph's. Both halves are load-bearing and neither reads as
 * obviously necessary at a glance, which is what this test is for. Layout
 * itself cannot be asserted here — jsdom does not lay out CSS — so the
 * contract is asserted on the declarations. Change these assertions in the
 * same commit as any deliberate change to the alignment.
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
    const body = ruleBody(MENTION);

    // A length here would reintroduce the per-kind spread: it is measured
    // from the chip's own synthesized baseline, which the strut — not the
    // nudge — is what makes uniform.
    expect(declaration(body, "vertical-align")).toBe("baseline");
  });

  it("keeps the zero-width baseline strut in front of every chip", () => {
    const body = ruleBody(STRUT);

    // U+200B. The strut must carry text, not `content: ""`: an empty box
    // synthesizes its baseline from its bottom edge and the chips go back
    // to disagreeing.
    expect(declaration(body, "content")).toBe('"\\200b"');
  });

  it("cancels exactly the one flex gap the strut opens", () => {
    const gap = declaration(ruleBody(MENTION), "gap");
    const cancel = declaration(ruleBody(STRUT), "margin-inline-end");

    // The strut is a real flex item, so `gap` applies in front of the
    // icon/dot until this margin takes it back. Drift between the two
    // shifts every chip's contents sideways.
    expect(cancel).toBe(`-${gap}`);
  });

  it("outranks the chip primitives on specificity, not on source order", () => {
    // `.chip` (24px/12px) and `.pr-chip` (22px/11px) are row and header
    // geometry; the composer's em-based sizing has to win regardless of
    // where these rules end up in the file.
    expect(css).toContain(MENTION);
    expect(css).not.toMatch(/\n\.composer-tiptap-input__mention\s*\{/);
  });
});
