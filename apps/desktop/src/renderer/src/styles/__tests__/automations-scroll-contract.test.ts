import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const css = readFileSync(path.resolve(testDir, "../app.css"), "utf8");

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(
    new RegExp(`(?:^|\\n)${escaped}\\s*\\{(?<body>[\\s\\S]*?)\\n\\}`),
  );
  if (!match?.groups?.body) {
    throw new Error(`Expected app.css to define ${selector}`);
  }
  return match.groups.body;
}

/**
 * The Automations screen scrolls at `.automations-content`; everything inside
 * it must be free to exceed that box rather than be squeezed into it.
 *
 * `.automations-table` clips to its border radius with `overflow: hidden`, so
 * a shrunk table does not overflow visibly and does not scroll — it silently
 * eats its own content. Measured once at 179px tall holding 1309px of rows,
 * with no scrollbar anywhere on the page. jsdom has no layout engine, so the
 * invariant is pinned here in the stylesheet instead.
 */
describe("automations screen scrolling", () => {
  it("scrolls the content column", () => {
    expect(ruleBody(".automations-content")).toMatch(/overflow:\s*auto;/);
  });

  it("keeps the table at its natural height inside that column", () => {
    const body = ruleBody(".automations-table");
    expect(body).toMatch(/flex:\s*0\s+0\s+auto;/);
    // The pairing is the trap: shrinkable + clipped = unreachable content.
    expect(body).toMatch(/overflow:\s*hidden;/);
  });
});
