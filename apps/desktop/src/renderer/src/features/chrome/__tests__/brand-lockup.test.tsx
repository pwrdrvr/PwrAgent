import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BrandLockup, PwrAgentMark } from "../BrandLockup";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const rendererSrc = path.resolve(testDir, "../../..");
const logoSvg = readFileSync(
  path.resolve(rendererSrc, "../../../../../docs/design/pwragent-v2/project/assets/logo-pwragnt.svg"),
  "utf8",
);

function rectsOf(markup: string): Array<Record<string, string>> {
  return [...markup.matchAll(/<rect\b([^>]*)>/g)].map((match) =>
    Object.fromEntries(
      [...match[1].matchAll(/([a-z]+)="([^"]*)"/g)].map((attr) => [attr[1], attr[2]]),
    ),
  );
}

describe("BrandLockup", () => {
  it("draws the mark from the app icon's own glyph", () => {
    // The mark is the icon glyph, not a new drawing: the same four bars at
    // the same opacities as logo-pwragnt.svg, which generate-macos-app-icon.swift
    // also draws from. Compared bar for bar so the two cannot drift.
    const { container } = render(<PwrAgentMark />);
    const drawn = [...container.querySelectorAll("rect")].map((rect) => ({
      x: rect.getAttribute("x"),
      y: rect.getAttribute("y"),
      width: rect.getAttribute("width"),
      height: rect.getAttribute("height"),
      rx: rect.getAttribute("rx"),
      opacity: rect.getAttribute("opacity") ?? "1",
    }));
    const source = rectsOf(logoSvg).map((rect) => ({
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      rx: rect.rx,
      opacity: rect.opacity ?? "1",
    }));
    expect(source).toHaveLength(4);
    expect(drawn).toEqual(source);
  });

  it("frames the glyph in a 20px square centred on its bounds", () => {
    const { container } = render(<PwrAgentMark />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("width")).toBe("20");
    expect(svg?.getAttribute("height")).toBe("20");
    // Bars span x 28–100 and y 32–96; the square about their centre (64, 64)
    // is 72 units on a side.
    expect(svg?.getAttribute("viewBox")).toBe("28 28 72 72");
    expect(svg?.querySelector("g")?.getAttribute("fill")).toBe("currentColor");
  });

  it("hides the mark from assistive tech and names the app once", () => {
    const { container } = render(<BrandLockup variant="sidebar" />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.getAttribute("focusable")).toBe("false");
    expect(container.textContent).toBe("PwrAgent");
  });

  it.each([
    ["sidebar", "sidebar__brand", "sidebar__brand-accent"],
    ["settings-nav", "settings-nav__brand", "settings-nav__brand-accent"],
    ["activity-titlebar", "activity-titlebar__brand", "activity-titlebar__brand-accent"],
  ] as const)("keeps the %s wordmark classes", (variant, wordmark, accent) => {
    const { container } = render(<BrandLockup variant={variant} />);
    const lockup = container.querySelector(".brand-lockup");
    expect(lockup?.children[0]?.matches("svg.brand-lockup__mark")).toBe(true);
    const text = lockup?.children[1];
    expect(text?.matches(`p.${wordmark}`)).toBe(true);
    expect(text?.querySelector(`span.${accent}`)?.textContent).toBe("Agent");
  });

  it("is the only way title chrome draws the wordmark", () => {
    // A hand-written `<p className="sidebar__brand">` renders the wordmark
    // without the mark, which is how one window ends up branded differently
    // from the rest. The Windows/Linux painted strip (`.app-titlebar__brand`)
    // is not title chrome on macOS and keeps its own markup.
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) {
          if (entry !== "__tests__") walk(full);
          continue;
        }
        if (!full.endsWith(".tsx") || full.endsWith("BrandLockup.tsx")) continue;
        const source = readFileSync(full, "utf8");
        if (/className="(sidebar|settings-nav|activity-titlebar)__brand"/.test(source)) {
          offenders.push(path.relative(rendererSrc, full));
        }
      }
    };
    walk(path.join(rendererSrc, "features"));
    expect(offenders).toEqual([]);
  });
});
