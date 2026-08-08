import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import type { NavigationLaunchpadDefaults } from "@pwragent/shared";
import { launchElectronApp } from "./fixtures/electron-app";

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

async function selectComposerOption(params: {
  option: string | RegExp;
  select: Locator;
  window: Page;
}) {
  await params.select.click();
  await params.window.getByRole("option", { name: params.option }).click();
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
  // Use the legacy "pwragnt" directory name because the migration code in
  // migration.ts intentionally looks for legacy files at this path.
  const stateRoot = path.join(rootDir, ".local", "state", "pwragnt");

  if (params.launchpadDefaults) {
    await mkdir(stateRoot, { recursive: true });
    await writeFile(
      path.join(stateRoot, "overlay-state.json"),
      JSON.stringify(
        {
          version: 4,
          backends: {},
          launchpadDefaults: params.launchpadDefaults,
          directoryLaunchpads: {},
          threads: {},
        },
        null,
        2,
      ),
      "utf8",
    );
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
    await app.window.getByRole("button", { name: "New thread" }).click();
    await expect(app.window.getByRole("heading", { level: 2, name: "New thread" })).toBeVisible();

    const settings = app.window.getByLabel("New thread settings");
    const providerSelect = settings.getByLabel("Provider");
    const modelSelect = settings.getByLabel("Model", { exact: true });
    const reasoningSelect = settings.getByLabel("Reasoning", { exact: true });
    await expect(providerSelect).toHaveAttribute("data-value", "codex");
    await expect(modelSelect).toHaveAttribute("data-value", "gpt-5.5");
    await expect(reasoningSelect).toHaveAttribute("data-value", "medium");
    await expect(settings.getByRole("option", { name: /^Default$/ })).toHaveCount(0);
    await assertTangerineFocusRing(providerSelect);
    await assertTangerineFocusRing(modelSelect);
    await assertTangerineFocusRing(reasoningSelect);
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
    await app.window.getByRole("button", { name: "New thread" }).click();
    await expect(app.window.getByRole("heading", { level: 2, name: "New thread" })).toBeVisible();

    await expect(app.window.getByText("Grok CLI", { exact: true })).toHaveCount(0);
    await expect(app.window.getByText("OpenAI", { exact: true }).first()).toBeVisible();

    const settings = app.window.getByLabel("New thread settings");
    const providerSelect = settings.getByLabel("Provider");
    const modelSelect = settings.getByLabel("Model", { exact: true });
    const prompt = app.window.getByRole("textbox", { name: "New thread" });

    await expect(providerSelect).toHaveAttribute("data-value", "codex");
    await expect(modelSelect).toHaveAttribute("data-value", "gpt-5.5");
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
