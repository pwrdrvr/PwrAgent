import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Nothing but the shell's own padding may sit between the thread terminal
 * panel's top border and its first row of text. jsdom loads no stylesheet,
 * so the component tests could not see the two rules that broke this: a
 * 10px resize band laid out above the shell, and xterm anchored to the
 * bottom of its viewport, which put the fit addon's rounding remainder (up
 * to one row) above the first line. Together they left a 20-35px empty band
 * that read as a reserved error rail. These assertions read app.css the way
 * star-map-satellite-css.test.ts does.
 */
const CSS = readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../styles/app.css",
  ),
  "utf8",
);

function declarations(selector: string): Map<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`).exec(CSS);
  if (!match) throw new Error(`no rule for ${selector}`);
  const result = new Map<string, string>();
  for (const declaration of match[1]!.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon < 0) continue;
    result.set(
      declaration.slice(0, colon).trim(),
      declaration.slice(colon + 1).trim(),
    );
  }
  return result;
}

describe("thread terminal panel top edge", () => {
  it("lays the resize grip over the border instead of above the shell", () => {
    const grip = declarations(
      ".thread-terminal-panel > .integrated-terminal__resize-handle",
    );
    expect(grip.get("position")).toBe("absolute");
    expect(declarations(".thread-terminal-panel").get("position")).toBe(
      "relative",
    );
  });

  it("gives the whole panel height to the body", () => {
    expect(
      declarations(".thread-terminal-panel__body").get("height"),
    ).toBe("100%");
  });

  it("keeps the grip's hit area inside the shell's top padding", () => {
    const grip = declarations(
      ".thread-terminal-panel > .integrated-terminal__resize-handle",
    );
    const padding = declarations(
      ".integrated-terminal--hosted .integrated-terminal__body",
    ).get("padding");
    const paddingTop = Number(/^(\d+)px/.exec(padding ?? "")?.[1]);
    const top = Number(/^(-?\d+)px$/.exec(grip.get("top") ?? "")?.[1]);
    const height = Number(/^(\d+)px$/.exec(grip.get("height") ?? "")?.[1]);
    // The grip starts on the 1px border; its bottom edge must not reach
    // the first row, which begins after the border and the body padding.
    expect(top + height).toBeLessThanOrEqual(1 + paddingTop);
  });

  it("anchors xterm to the top so the row remainder falls below the last row", () => {
    const xterm = declarations(".integrated-terminal .xterm");
    expect(xterm.get("top")).toBe("0");
    expect(xterm.has("bottom")).toBe(false);
  });
});
