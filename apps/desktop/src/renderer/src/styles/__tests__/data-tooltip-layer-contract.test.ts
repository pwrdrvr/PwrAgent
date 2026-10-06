import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { appCss, cssRuleBody } from "./css-rule-body";

/**
 * Pins the one way a `data-tooltip` reaches the screen: DataTooltipLayer's
 * portal on document.body.
 *
 * The tooltip used to be an `::after` on the control. A pseudo-element paints
 * inside its host, so it is clipped by every `overflow` ancestor and stacked
 * inside every stacking context around the host. The composer's toggles sit in
 * the main pane beside the sidebar, and their tooltips kept drawing under it.
 * Each fix moved one control onto the portal or shifted one tooltip's x until
 * the next control hit the same wall. None of that is visible to jsdom, so the
 * stylesheet and the mount are what can be asserted.
 */
const testDir = path.dirname(fileURLToPath(import.meta.url));
const rendererSrc = path.resolve(testDir, "../..");

function rendererStylesheets(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "__tests__" ? [] : rendererStylesheets(full);
    }
    return entry.name.endsWith(".css") ? [full] : [];
  });
}

function zIndex(body: string): number {
  const match = body.match(/z-index:\s*(\d+)/);
  if (!match) {
    throw new Error(`Expected a z-index in:\n${body}`);
  }
  return Number(match[1]);
}

describe("data-tooltip layer contract", () => {
  it("draws no data-tooltip from CSS generated content", () => {
    const offenders = rendererStylesheets(rendererSrc).filter((file) =>
      /attr\(\s*data-tooltip\s*\)/.test(readFileSync(file, "utf8")),
    );
    expect(offenders.map((file) => path.relative(rendererSrc, file))).toEqual([]);
  });

  it("mounts the layer at the renderer root, so every window has it", () => {
    const main = readFileSync(path.join(rendererSrc, "main.tsx"), "utf8");
    expect(main).toMatch(/<DataTooltipLayer\s*\/>/);
  });

  it("layers the portal over every surface a data-tooltip control sits in", () => {
    const voiceCss = readFileSync(
      path.join(rendererSrc, "features/native-voice/native-voice.css"),
      "utf8",
    );
    const layer = zIndex(cssRuleBody(".viewport-tooltip.data-tooltip-layer"));
    // Settings and Automations are full-window layers in the root stacking
    // context, and the director voice panel floats over them.
    expect(layer).toBeGreaterThan(zIndex(cssRuleBody(".app-shell__settings-layer", appCss)));
    expect(layer).toBeGreaterThan(zIndex(cssRuleBody(".director-voice-panel", voiceCss)));
  });
});
