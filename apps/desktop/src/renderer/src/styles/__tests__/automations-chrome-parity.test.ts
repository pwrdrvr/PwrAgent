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

/** The `padding` shorthand's parts, in source order. */
function padding(selector: string): string[] {
  const match = ruleBody(selector).match(/\n\s*padding:\s*([^;]+);/);
  if (!match) {
    throw new Error(`Expected ${selector} to set padding`);
  }
  return match[1].trim().split(/\s+/);
}

/**
 * The Automations screen borrows Settings' nav, title bar, and grid, so the
 * two are one chrome wearing two labels. Everywhere they diverge is an
 * accident — and one already shipped: the content inset drifted to 20px
 * against Settings' 24px and nothing failed, which is what these lock.
 */
describe("Automations chrome matches Settings", () => {
  it("insets content from the window edge identically", () => {
    const settings = padding(".settings-content"); // 20px 24px 24px
    const automations = padding(".automations-content"); // 0 24px 24px
    expect(settings).toHaveLength(3);
    expect(automations).toHaveLength(3);
    // Horizontal and bottom track Settings. Compared rather than hardcoded so
    // that restyling Settings surfaces this screen as a decision to make.
    expect(automations[1]).toBe(settings[1]);
    expect(automations[2]).toBe(settings[2]);
  });

  it("keeps the Automations scrollport's top padding at zero", () => {
    // Deliberately NOT matching Settings' 20px top: this padding is inside
    // the scrollport, and rows would slide up through it and appear above the
    // sticky column header. `.automations-toolbar` carries that space
    // instead. Settings solves the same problem from the other side, with
    // `--settings-section-sticky-top: -20px`.
    expect(padding(".automations-content")[0]).toBe("0");
    expect(ruleBody(".automations-toolbar")).toMatch(/padding-top:\s*20px;/);
  });

  it("gives the nav's create row the same rhythm Exit has in Settings", () => {
    // `.settings-nav` is a flex column with `gap: 2px`, `.settings-nav__exit`
    // carries `margin: 6px 0 2px`, and the group label leads with `8px`. In
    // Settings that yields exit → group label = 2 + 2 + 8 = 12px. Automations
    // inserts this row into that gap, so `8px 0 2px` keeps both halves at
    // 12px; `0 0 8px` left 8px above and 16px below, clumping Exit and New
    // together.
    expect(ruleBody(".settings-nav")).toMatch(/gap:\s*2px;/);
    expect(ruleBody(".settings-nav__exit")).toMatch(/margin:\s*6px 0 2px;/);
    expect(ruleBody(".settings-nav__group-label")).toMatch(/margin:\s*8px 8px 2px;/);
    expect(ruleBody(".settings-nav__new")).toMatch(/margin:\s*8px 0 2px;/);
  });
});
