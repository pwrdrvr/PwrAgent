import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, type Locator } from "./fixtures/electron-test";
import type { NavigationLaunchpadDefaults } from "@pwragent/shared/contracts/navigation";
import { launchElectronApp } from "./fixtures/electron-app";
import { seedProfileOverlayState } from "./fixtures/overlay-state-seeding";
import { mastheadAction } from "./fixtures/window-chrome";

async function assertTangerineFocusRing(locator: Locator) {
  await expect
    .poll(async () =>
      await locator.evaluate((element) => {
        (element as HTMLElement).focus();
        const style = getComputedStyle(element);
        return {
          isActive: document.activeElement === element,
          outlineColor: style.outlineColor,
          outlineStyle: style.outlineStyle,
        };
      })
    )
    .toEqual({
      isActive: true,
      outlineColor: "rgb(255, 138, 31)",
      outlineStyle: "solid",
    });
}

async function createProviderSelectorFixture(params: {
  backend: "codex";
  launchpadDefaults?: NavigationLaunchpadDefaults;
}): Promise<{
  cleanup: () => Promise<void>;
  env?: Record<string, string>;
  fixturePath: string;
}> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "pwragent-provider-model-selectors-"));
  const fixturePath = path.join(rootDir, "provider-model-selectors.fixture.json");

  if (params.launchpadDefaults) {
    await seedProfileOverlayState(rootDir, {
      launchpadDefaults: params.launchpadDefaults,
    });
  }

  await writeFile(
    fixturePath,
    JSON.stringify(
      {
        metadata: {
          backend: params.backend,
          scenario: "provider-model-selectors",
        },
        steps: [
          {
            id: "initialize-1",
            kind: "response",
            method: "initialize",
            result: {
              serverInfo: {
                name: "Replay Codex",
                version: "1.0.0",
              },
              methods: ["thread/list", "thread/read", "skills/list", "thread/start", "turn/start"],
            },
          },
          {
            id: "thread-list-1",
            kind: "response",
            method: "thread/list",
            result: [],
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );

  return {
    fixturePath,
    env: params.launchpadDefaults ? { HOME: rootDir } : undefined,
    cleanup: async () => {
      await rm(rootDir, { recursive: true, force: true });
    },
  };
}

test("OpenAI new-thread selector uses concrete model and reasoning defaults", async () => {
  const fixture = await createProviderSelectorFixture({ backend: "codex" });
  const app = await launchElectronApp({
    fixturePath: fixture.fixturePath,
    env: fixture.env,
  });

  try {
    await mastheadAction(app.window, "New thread").click();
    await expect(app.window.getByRole("heading", { level: 2, name: "New thread" })).toBeVisible();

    const settings = app.window.getByLabel("New thread settings");
    // Provider, model and effort are one pill; its data attributes carry each.
    const modelSettings = settings.getByTestId("composer-model-settings");
    await expect(modelSettings).toHaveAttribute("data-provider", "codex");
    await expect(modelSettings).toHaveAttribute("data-model", "gpt-5.5");
    await expect(modelSettings).toHaveAttribute("data-effort", "medium");
    await assertTangerineFocusRing(modelSettings);
    await modelSettings.click();
    const panel = app.window.getByRole("dialog", { name: "Model settings" });
    await expect(panel.getByRole("slider", { name: "Effort" })).toHaveAttribute("aria-valuetext", "medium");
    // A concrete default: no separate "Default" effort chip for Codex.
    await expect(panel.getByRole("button", { name: /^Default$/ })).toHaveCount(0);
    await app.window.keyboard.press("Escape");
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});

test("OpenAI new-thread launchpad wins when sticky ACP Grok defaults are unavailable", async () => {
  const fixture = await createProviderSelectorFixture({
    backend: "codex",
    launchpadDefaults: {
      backend: "acp:grok",
      executionMode: "default",
      model: "grok-4.5",
      reasoningEffort: "medium",
      workMode: "local",
    },
  });
  const app = await launchElectronApp({
    fixturePath: fixture.fixturePath,
    env: fixture.env,
  });

  try {
    await mastheadAction(app.window, "New thread").click();
    await expect(app.window.getByRole("heading", { level: 2, name: "New thread" })).toBeVisible();

    await expect(app.window.getByText("Grok CLI", { exact: true })).toHaveCount(0);
    await expect(app.window.getByText("OpenAI", { exact: true }).first()).toBeVisible();

    const settings = app.window.getByLabel("New thread settings");
    const modelSettings = settings.getByTestId("composer-model-settings");
    const prompt = app.window.getByRole("textbox", { name: "New thread" });

    await expect(modelSettings).toHaveAttribute("data-provider", "codex");
    await expect(modelSettings).toHaveAttribute("data-model", "gpt-5.5");
    await expect(
      app.window.getByText(
        "This backend is unavailable right now. Your draft stays here until send is available again."
      )
    ).toHaveCount(0);
    await expect(prompt).toBeEnabled();
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});
