import { describe, expect, it } from "vitest";
import { appCss, cssRuleBody, firstCssRuleBody } from "./css-rule-body";

/**
 * Locks the paint of the shared Select (components/Select.tsx). jsdom has no
 * layout and loads no stylesheet, so these can only be asserted against
 * app.css.
 */

function declaration(body: string, property: string): string | undefined {
  return body
    .match(new RegExp(`(?:^|\\n)\\s*${property}:\\s*([^;]+);`))?.[1]
    ?.replace(/\s+/g, " ")
    .trim();
}

describe("Select paint", () => {
  it("marks the keyboard cursor with the popover highlight and an inset ring", () => {
    // DOM focus stays on the trigger, so the row Enter picks carries the ring
    // an `aria-activedescendant` row takes (UI-THEME.md, "Focus rings").
    const cursor = cssRuleBody(".select-option.is-active");
    expect(cursor).toContain("background: var(--accent-soft);");
    expect(cursor).toContain("color: var(--accent-bright);");
    expect(cursor).toContain("outline: 2px solid var(--focus-ring);");
    expect(cursor).toContain("outline-offset: -2px;");
    // Not the thread-row selection language.
    expect(cursor).not.toContain("var(--bg-row-active)");
    expect(cursor).not.toContain("var(--accent-border)");
  });

  it("has no hover paint apart from the cursor, which the pointer moves", () => {
    // A hover tint of its own would paint a hovered row and the cursor alike
    // once the arrows moved away from the pointer.
    expect(appCss).not.toMatch(/\.select-option:hover/);
  });

  it("layers the list above Settings and Automations", () => {
    const listbox = cssRuleBody(".select-listbox");
    expect(declaration(listbox, "position")).toBe("fixed");
    const layer = Number(
      declaration(cssRuleBody(".app-shell__settings-layer"), "z-index"),
    );
    expect(layer).toBeGreaterThan(0);
    expect(Number(declaration(listbox, "z-index"))).toBeGreaterThan(layer);
  });

  it("draws the same chevron as .settings-select", () => {
    // A Select sits beside a surface picker, whose trigger is a
    // `.settings-select`, in the Automations form.
    const settings = firstCssRuleBody(".settings-select");
    const chevron = cssRuleBody(".select-trigger__chevron");
    expect(declaration(chevron, "background-image")).toBe(
      declaration(settings, "background-image"),
    );
    expect(declaration(chevron, "background-size")).toBe(
      declaration(settings, "background-size"),
    );
  });

  it("gives the Automations field chrome to the trigger, not a native select", () => {
    expect(appCss).not.toMatch(/\.automation-field(?:--[\w-]+)? select\b/);
    expect(appCss).toMatch(
      /\.automation-field \.select-trigger:focus,[\s\S]*?outline: 2px solid var\(--focus-ring\);/,
    );
  });
});
