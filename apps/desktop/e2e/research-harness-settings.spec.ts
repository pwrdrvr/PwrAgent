import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";
import { configTomlPathForHomeRoot, stateDbPathForHomeRoot } from "./fixtures/readme-state-seeding";
import { enableResearchFixture, seedResearchState } from "./fixtures/research-state-seeding";

const specDir = path.dirname(fileURLToPath(import.meta.url));
// Contrived values only: no real path, host or key.
const BRIDGE = "/opt/example/bin/harness-bridge";
const ENDPOINT = "https://models.example.test/v1/chat/completions";
const PLATFORM_KEY = "mathos_contrived_key_0000000000";
const SHOTS = path.resolve(specDir, "../../../.local");

/** Attached to the report, and kept under the checkout's ignored .local/ for PR media. */
async function capture(window: Page, testInfo: { attach: (name: string, options: { body: Buffer; contentType: string }) => Promise<void> }, name: string) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const body = await window.screenshot({ path: path.join(SHOTS, `research-harness-settings-${name}.png`) });
  await testInfo.attach(name, { body, contentType: "image/png" });
}

async function openNewHarnessRun(window: Page) {
  await window.getByRole("tab", { name: "Research", exact: true }).click();
  const panel = window.getByRole("region", { name: "Research", exact: true });
  const harness = panel.getByRole("button", { name: "Open Math Harness", exact: true });
  const newRun = panel.getByRole("button", { name: "New run", exact: true });
  // Returning from Settings, the panel may still have its New run form open.
  await expect(harness.or(newRun).first()).toBeVisible();
  if (!(await harness.isVisible())) await newRun.click();
  await harness.click();
  return panel;
}

test("Open Math Harness settings save the bridge and Platform key, and New run's Bridge block reflects them", async ({ playwright: _playwright }, testInfo) => {
  const app = await launchElectronApp({
    fixturePath: path.join(specDir, "fixtures/research/replay.fixture.json"),
    secretStorage: "memory",
    preLaunchHook: async (homeRoot) => { enableResearchFixture(homeRoot); seedResearchState(stateDbPathForHomeRoot(homeRoot)); },
  });
  try {
    await app.window.getByRole("button", { name: /Queue ordering research/ }).first().click();
    let panel = await openNewHarnessRun(app.window);
    await expect(panel.getByText(/No Harness bridge is configured/)).toBeVisible();
    await capture(app.window, testInfo, "bridge-block-unconfigured");

    // The form links to the one place the bridge is configured.
    await panel.getByRole("button", { name: "Open Harness settings", exact: true }).click();
    const section = app.window.getByRole("region", { name: "Open Math Harness", exact: true });
    await expect(section).toBeVisible();
    await section.getByLabel("Bridge program", { exact: true }).fill(BRIDGE);
    await section.getByLabel("Bridge arguments", { exact: true }).fill("--profile\ncontrived");
    await section.getByLabel("Model endpoint", { exact: true }).fill(ENDPOINT);
    await section.getByLabel("Model", { exact: true }).fill("example-model");
    await section.getByLabel("Model key variable", { exact: true }).fill("EXAMPLE_MODEL_KEY");
    await section.getByRole("button", { name: "Save bridge", exact: true }).click();
    await expect(section.getByText("Bridge set", { exact: true })).toBeVisible();
    await expect(section.getByText("EXAMPLE_MODEL_KEY is not set in PwrAgent’s environment")).toBeVisible();

    const key = section.getByLabel("MathOS Platform API key", { exact: true });
    await key.fill(PLATFORM_KEY);
    await key.press("Enter");
    await expect(key).toHaveValue("");
    await expect(section.getByRole("button", { name: "Remove saved MathOS Platform API key", exact: true })).toBeVisible();
    await expect(section).not.toContainText(PLATFORM_KEY);

    const { violations } = await new AxeBuilder({ page: app.window }).setLegacyMode(true)
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).include("section:has(#settings-section-experimental-open-math-harness-heading)").analyze();
    expect(violations.map((v) => `${v.id} ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
    await section.scrollIntoViewIfNeeded();
    await capture(app.window, testInfo, "settings-saved");

    // config.toml holds the table, never the key.
    const config = fs.readFileSync(configTomlPathForHomeRoot(app.homeRoot), "utf8");
    expect(config).toContain("[research.harness]");
    expect(config).toContain(`command = "${BRIDGE}"`);
    expect(config).toContain("args = [\"--profile\", \"contrived\"]");
    expect(config).not.toContain(PLATFORM_KEY);

    const nav = app.window.getByRole("navigation", { name: "Settings sections" });
    await nav.getByRole("button", { name: /Exit Settings/i }).click();
    panel = await openNewHarnessRun(app.window);
    const bridge = panel.getByRole("region", { name: "Bridge", exact: true });
    await expect(bridge.getByText("harness-bridge", { exact: true })).toBeVisible();
    await expect(bridge.getByText("example-model", { exact: true })).toBeVisible();
    await expect(bridge.getByText("https://models.example.test", { exact: true })).toBeVisible();
    await expect(bridge.getByText("EXAMPLE_MODEL_KEY", { exact: true })).toBeVisible();
    await expect(bridge.getByText("Stored in PwrAgent · given to the bridge", { exact: true })).toBeVisible();
    await capture(app.window, testInfo, "bridge-block-configured");
  } finally { await app.close(); }
});
