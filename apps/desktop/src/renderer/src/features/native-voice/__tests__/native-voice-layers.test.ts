import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const appCss = readFileSync(new URL("../../../styles/app.css", import.meta.url), "utf8");
const voiceCss = readFileSync(new URL("../native-voice.css", import.meta.url), "utf8");

function layer(css: string, selector: string): number {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(new RegExp(`^${escaped}\\s*\\{([^}]+)\\}`, "gm"))];
  // Multiple declarations need an explicit cascade decision in this contract.
  expect(rules, selector).toHaveLength(1);
  const value = rules[0]![1]!.match(/(?:^|;)\s*z-index:\s*(\d+)\s*(?:;|$)/);
  expect(value, `${selector} declares its layer`).not.toBeNull();
  return Number(value![1]);
}

it("draws director tooltips above the panel and the default tooltip layer", () => {
  const panel = layer(voiceCss, ".director-voice-panel");
  const defaultTooltip = layer(appCss, ".viewport-tooltip");
  expect(panel).toBeGreaterThan(0);
  for (const selector of [".viewport-tooltip.director-voice-panel__tooltip", ".director-voice-card"]) {
    const tooltip = layer(voiceCss, selector);
    expect(tooltip, selector).toBeGreaterThan(panel);
    expect(tooltip, selector).toBeGreaterThan(defaultTooltip);
  }
});
