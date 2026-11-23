import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/readme-recents-hero/replay.fixture.json");

test("keeps independent CPU capture rules across edits, toggles and Settings reopen", async () => {
  const app = await launchElectronApp({ fixturePath });
  try {
    const page = app.window;
    const openRules = async () => {
      await page.getByRole("button", { name: "Open settings", exact: true }).click();
      await page.getByRole("navigation", { name: "Settings sections" })
        .getByRole("button", { name: "Troubleshooting", exact: true }).click();
      return page.getByRole("group", { name: "Capture rules", exact: true });
    };
    const rules = await openRules();
    const high = rules.getByRole("checkbox", { name: "High CPU", exact: true });
    const slow = rules.getByRole("checkbox", { name: "Slow burn", exact: true });
    const sustained = rules.getByRole("radio", { name: "Sustained", exact: true });
    const spike = rules.getByRole("radio", { name: "Spike", exact: true });
    const sustainedThreshold = rules.getByRole("spinbutton", { name: "Sustained CPU threshold", exact: true });
    await expect(high).toBeChecked();
    await expect(high).toHaveAttribute("aria-disabled", "true");
    await high.focus();
    await high.press("Space");
    await expect(rules.getByRole("status")).toContainText("At least one rule stays on");
    await expect(high).toBeChecked();

    await sustainedThreshold.fill("401");
    await sustainedThreshold.press("Enter");
    await expect(sustainedThreshold).toHaveAttribute("aria-invalid", "true");
    await sustainedThreshold.press("Escape");
    await expect(sustainedThreshold).toHaveValue("50");
    await sustainedThreshold.fill("120");
    await sustainedThreshold.press("Enter");
    await expect(rules.getByText(/at least 120% of one core/)).toBeVisible();

    await sustained.focus();
    await sustained.press("ArrowLeft");
    await expect(spike).toBeChecked();
    await expect(spike).toBeFocused();
    const spikeThreshold = rules.getByRole("spinbutton", { name: "Spike CPU threshold", exact: true });
    await expect(spikeThreshold).toHaveValue("50");
    await spikeThreshold.fill("66");
    await spikeThreshold.press("Tab");
    await expect(rules.getByText(/at least 66% of one core/)).toBeVisible();
    const duration = rules.getByRole("combobox", { name: "Spike duration", exact: true });
    await duration.click();
    await page.getByRole("option", { name: "1 s · 1 sample", exact: true }).click();
    await expect(rules.getByText(/one 1 s sample/)).toBeVisible();

    await slow.click();
    await expect(slow).toBeChecked();
    await expect(rules.getByRole("combobox", { name: "Slow burn duration", exact: true }))
      .toHaveText("4 s · 4 samples");
    await high.click();
    await expect(high).not.toBeChecked();
    await expect(slow).toHaveAttribute("aria-disabled", "true");
    await expect(spikeThreshold).toBeDisabled();
    await expect(rules.getByRole("combobox", { name: "Slow burn duration", exact: true }))
      .toHaveText("4 s · 2 samples");
    await page.getByRole("navigation", { name: "Settings sections" })
      .getByRole("button", { name: /Exit Settings/i }).click();
    await openRules();
    await expect(high).not.toBeChecked();
    await expect(slow).toBeChecked();

    await high.click();
    await expect(high).toBeChecked();
    await expect(spikeThreshold).toHaveValue("66");
    await expect(duration).toHaveText("1 s · 1 sample");
    await sustained.click();
    await expect(sustainedThreshold).toHaveValue("120");
  } finally {
    await app.close();
  }
});
