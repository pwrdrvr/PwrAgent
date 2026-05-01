import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import type { AppServerBackendKind, NavigationLaunchpadDefaults } from "@pwragnt/shared";
import { launchElectronApp } from "./fixtures/electron-app";

async function assertTangerineFocusRing(locator: Locator) {
  await locator.focus();
  await expect(locator).toHaveCSS("outline-color", "rgb(255, 138, 31)");
  await expect(locator).toHaveCSS("outline-style", "solid");
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
  backend: AppServerBackendKind;
  launchpadDefaults?: NavigationLaunchpadDefaults;
}): Promise<{
  cleanup: () => Promise<void>;
  env?: Record<string, string>;
  fixturePath: string;
}> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "pwragnt-provider-model-selectors-"));
  const fixturePath = path.join(rootDir, "provider-model-selectors.fixture.json");
  const stateRoot = path.join(rootDir, "state");

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
                name: params.backend === "codex" ? "Replay Codex" : "Replay Grok",
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
    env: params.launchpadDefaults
      ? {
          PWRAGNT_STATE_ROOT: stateRoot,
        }
      : undefined,
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
    const modelSelect = settings.getByLabel("Model");
    const reasoningSelect = settings.getByLabel("Reasoning");
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

test("OpenAI new-thread launchpad wins when sticky Grok defaults are unavailable", async () => {
  const fixture = await createProviderSelectorFixture({
    backend: "codex",
    launchpadDefaults: {
      backend: "grok",
      executionMode: "default",
      model: "grok-4.20-reasoning",
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

    await expect(app.window.getByText("Grok", { exact: true })).toHaveCount(0);
    await expect(app.window.getByText("OpenAI", { exact: true }).first()).toBeVisible();

    const settings = app.window.getByLabel("New thread settings");
    const providerSelect = settings.getByLabel("Provider");
    const modelSelect = settings.getByLabel("Model");
    const prompt = app.window.locator("textarea.composer__input");

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

test("Grok new-thread selector hides reasoning for Grok 4.20 models", async () => {
  const fixture = await createProviderSelectorFixture({
    backend: "grok",
    launchpadDefaults: {
      backend: "grok",
      executionMode: "default",
      model: "grok-4.20-reasoning",
      reasoningEffort: "medium",
    },
  });
  const app = await launchElectronApp({
    fixturePath: fixture.fixturePath,
    env: fixture.env,
  });

  try {
    await app.window.getByRole("button", { name: "New thread" }).click();
    await expect(app.window.getByRole("heading", { level: 2, name: "New thread" })).toBeVisible();

    const settings = app.window.getByLabel("New thread settings");
    const providerSelect = settings.getByLabel("Provider");
    const modelSelect = settings.getByLabel("Model");
    await expect(providerSelect).toHaveAttribute("data-value", "grok");
    await expect(modelSelect).toHaveAttribute("data-value", "grok-4.20-reasoning");
    await expect(settings.getByLabel("Reasoning")).toHaveCount(0);
    await expect(settings.getByRole("option", { name: /^Default$/ })).toHaveCount(0);
    await assertTangerineFocusRing(providerSelect);
    await assertTangerineFocusRing(modelSelect);

    await selectComposerOption({
      select: modelSelect,
      window: app.window,
      option: "Grok 4.20 Non-Reasoning",
    });
    await expect(settings.getByLabel("Reasoning")).toHaveCount(0);

    await selectComposerOption({
      select: modelSelect,
      window: app.window,
      option: "Grok 4.20 Reasoning",
    });
    await expect(settings.getByLabel("Reasoning")).toHaveCount(0);
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});
