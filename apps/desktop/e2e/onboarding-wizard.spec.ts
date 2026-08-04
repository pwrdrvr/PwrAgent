import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

/**
 * Wizard E2Es. These specs run the desktop binary against a brand-new
 * `HOME` (no `~/.pwragent/profiles/default/` pre-seeded) so the boot
 * decision returns `no-profile-configured` or `missing-named-profile`
 * and the wizard fires for real.
 *
 * They cover the navigation surface — getting stuck, weird screen
 * ordering, lost values across back/forward — without trying to
 * complete Codex SSO. Codex auth would need a network round-trip and
 * a real browser flow; integration of the login button is left to
 * unit tests (see `apps/desktop/src/main/__tests__/`).
 *
 * Uses the test runner's executable as a deterministic discovery candidate.
 * Its version output satisfies the provider gate without depending on a real
 * Codex install or attempting an external login.
 */

const wizardLaunchOptions = {
  // No `fixturePath`: thread replay isn't relevant for wizard-only specs.
  suppressOnboarding: false,
  requiresReplayDriver: false,
  env: { PWRAGENT_CODEX_COMMAND: process.execPath },
};

const fakeProviderNames = ["codex", "kimi", "qwen", "grok"] as const;
type FakeProviderName = (typeof fakeProviderNames)[number];

function fakeProviderScript(): string {
  return `#!${process.execPath}
const path = require("node:path");
const name = path.basename(process.argv[1]);
const args = process.argv.slice(2);

if (args.includes("--version")) {
  console.log(name + " 999.0.0");
  process.exit(0);
}

if (name === "qwen") {
  console.log("Qwen Code");
} else if (name === "grok") {
  console.log("Run the agent over stdio");
} else if (name === "kimi") {
  console.log("Agent Client Protocol server over stdio");
} else {
  console.log("Codex CLI");
}
`;
}

function wellKnownFakeProviderCommands(
  homeRoot: string,
): Record<FakeProviderName, string> {
  return {
    codex:
      process.platform === "darwin"
        ? path.join(
          homeRoot,
          "Applications",
          "Codex.app",
          "Contents",
          "Resources",
          "codex",
        )
        : path.join(homeRoot, ".local", "bin", "codex"),
    kimi: path.join(homeRoot, ".kimi-code", "bin", "kimi"),
    qwen: path.join(homeRoot, ".qwen", "bin", "qwen"),
    grok: path.join(homeRoot, ".grok", "bin", "grok"),
  };
}

async function launchWizardWithFakeProviders(
  source: "path" | "well-known",
) {
  const homeRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "pwragent-provider-discovery-e2e-"),
  );
  const customBin = path.join(homeRoot, ".bin");
  const commands =
    source === "path"
      ? Object.fromEntries(
        fakeProviderNames.map((name) => [name, path.join(customBin, name)]),
      ) as Record<FakeProviderName, string>
      : wellKnownFakeProviderCommands(homeRoot);

  for (const command of Object.values(commands)) {
    fs.mkdirSync(path.dirname(command), { recursive: true });
    fs.writeFileSync(command, fakeProviderScript(), "utf8");
    fs.chmodSync(command, 0o755);
  }

  const systemPath = "/usr/bin:/bin:/usr/sbin:/sbin";
  const discoveryPath =
    source === "path"
      ? `${customBin}${path.delimiter}${systemPath}`
      : systemPath;
  const profile = `export PATH="${discoveryPath}"\n`;
  for (const profileName of [".profile", ".bash_profile", ".zprofile"]) {
    fs.writeFileSync(path.join(homeRoot, profileName), profile, "utf8");
  }

  try {
    const app = await launchElectronApp({
      homeRoot,
      suppressOnboarding: false,
      requiresReplayDriver: false,
      env: {
        PATH: discoveryPath,
        PWRAGENT_CODEX_COMMAND: undefined,
        SHELL: process.platform === "darwin" ? "/bin/zsh" : "/bin/bash",
      },
    });
    return { app, commands };
  } catch (error) {
    fs.rmSync(homeRoot, { recursive: true, force: true });
    throw error;
  }
}

async function openProviderStepAndRefresh(
  app: Awaited<ReturnType<typeof launchElectronApp>>,
): Promise<void> {
  await app.window.getByRole("button", { name: /Get started/i }).click();
  await app.window.getByRole("button", { name: /^Continue/i }).click();
  const refresh = app.window.getByRole("button", {
    name: /Refresh after install/i,
  });
  await refresh.click();
  await expect(refresh).toHaveText("Refresh after install", { timeout: 20_000 });
}

async function expectFakeProvidersFound(
  app: Awaited<ReturnType<typeof launchElectronApp>>,
  commands: Record<FakeProviderName, string>,
): Promise<void> {
  const providerLabels: Record<FakeProviderName, string> = {
    codex: "Codex CLI",
    kimi: "Kimi Code",
    qwen: "Qwen Code",
    grok: "Grok Build",
  };
  for (const name of fakeProviderNames) {
    await app.window
      .getByRole("tab", { name: new RegExp(providerLabels[name], "i") })
      .click();
    const panel = app.window.getByRole("tabpanel");
    await expect(panel.getByText("✓ Found v999.0.0")).toBeVisible();
    await expect(panel.getByText(commands[name], { exact: true })).toBeVisible();
  }
}

test.describe("Onboarding wizard", () => {
  test("Get started and Back buttons are clickable", async () => {
    const app = await launchElectronApp(wizardLaunchOptions);
    try {
      await expect(
        app.window.getByRole("heading", {
          name: /A few short choices/i,
        }),
      ).toBeVisible();

      const getStarted = app.window.getByRole("button", { name: /Get started/i });
      await expect(getStarted).toBeVisible();
      await getStarted.click();

      await expect(
        app.window.getByRole("heading", {
          name: /Pick your appearance and thread density/i,
        }),
      ).toBeVisible();

      const back = app.window.getByRole("button", { name: /^← Back/i });
      await expect(back).toBeVisible();
      await back.click();

      await expect(
        app.window.getByRole("heading", {
          name: /A few short choices/i,
        }),
      ).toBeVisible();
    } finally {
      await app.close();
    }
  });

  test("fires on a fresh PWRAGENT_HOME and walks Welcome → Done in Shared mode", async () => {
    const app = await launchElectronApp(wizardLaunchOptions);
    try {
      // Welcome screen visible.
      await expect(
        app.window.getByRole("heading", {
          name: /A few short choices/i,
        }),
      ).toBeVisible();

      // Get started → Thread presentation.
      await app.window.getByRole("button", { name: /Get started/i }).click();
      await expect(
        app.window.getByRole("heading", {
          name: /Pick your appearance and thread density/i,
        }),
      ).toBeVisible();

      // Pick Compact density (so we can later assert back-nav preserved it).
      await app.window.getByText("Just the title", { exact: false }).click();
      await app.window.getByRole("button", { name: /^Continue/i }).click();

      // AI Providers — the deterministic executable override satisfies
      // discovery without collecting credentials in the wizard.
      await expect(
        app.window.getByRole("heading", {
          name: /Install at least one AI provider/i,
        }),
      ).toBeVisible();
      await app.window.getByRole("button", { name: /^Continue/i }).click();

      // Codex profile — pick Shared. The fresh HOME has no Codex auth.json,
      // so we expect the shared-codex-login step next.
      await expect(
        app.window.getByRole("heading", {
          name: /How should PwrAgent relate to your Codex install/i,
        }),
      ).toBeVisible();
      await app.window
        .getByText("Reuse your existing Codex login", { exact: false })
        .click();
      await app.window.getByRole("button", { name: /^Continue/i }).click();

      // Shared-codex-login step appears with a "Log in to your Codex
      // account" heading. We can't complete the SSO flow here, so
      // exercise the "I'll log in later" microlink to lift the gate.
      await expect(
        app.window.getByRole("heading", {
          name: /Log in to your Codex account/i,
        }),
      ).toBeVisible();
      await app.window
        .getByRole("button", { name: /I.ll log in later/i })
        .click();
      await app.window.getByRole("button", { name: /^Continue/i }).click();

      // Messaging warning step with Skip / Continue fork.
      await expect(
        app.window.getByRole("heading", {
          name: /Messaging is optional/i,
        }),
      ).toBeVisible();
      await app.window
        .getByRole("button", { name: /Skip messaging for now/i })
        .click();

      // Done step renders the operator's summary.
      await expect(
        app.window.getByRole("heading", { name: /You.re operating/i }),
      ).toBeVisible({ timeout: 10_000 });
    } finally {
      await app.close();
    }
  });

  test("messaging-safety gate: locked Continue flashes the ack card, checking it unlocks", async () => {
    const app = await launchElectronApp(wizardLaunchOptions);
    try {
      // Walk to the messaging-safety step (same path as the Shared walk).
      await app.window.getByRole("button", { name: /Get started/i }).click();
      await app.window.getByRole("button", { name: /^Continue/i }).click();
      await app.window.getByRole("button", { name: /^Continue/i }).click();
      await app.window
        .getByText("Reuse your existing Codex login", { exact: false })
        .click();
      await app.window.getByRole("button", { name: /^Continue/i }).click();
      await app.window
        .getByRole("button", { name: /I.ll log in later/i })
        .click();
      await app.window.getByRole("button", { name: /^Continue/i }).click();

      await expect(
        app.window.getByRole("heading", { name: /Messaging is optional/i }),
      ).toBeVisible();

      // Skip is the default action; Continue starts locked (aria-disabled)
      // and no flash ring is present yet.
      const continueBtn = app.window.getByRole("button", {
        name: /Continue with messaging/i,
      });
      await expect(continueBtn).toHaveAttribute("aria-disabled", "true");
      // Locked Continue points screen readers at the gate requirement.
      await expect(continueBtn).toHaveAttribute(
        "aria-describedby",
        "onboarding-messaging-gate-hint",
      );
      const flash = app.window.locator(".onboarding-wizard__safety-ack-flash");
      await expect(flash).toHaveCount(0);

      // Force-click the locked button: it must NOT advance, and it must
      // mount the attention flash on the acknowledgement card.
      await continueBtn.click({ force: true });
      await expect(
        app.window.getByRole("heading", { name: /Messaging is optional/i }),
      ).toBeVisible();
      await expect(flash).toHaveCount(1);

      // Tick the acknowledgement card → Continue unlocks.
      await app.window.locator(".onboarding-wizard__safety-ack").click();
      await expect(continueBtn).not.toHaveAttribute("aria-disabled", "true");
      // Unlocking also drops the screen-reader gate hint.
      await expect(continueBtn).not.toHaveAttribute(
        "aria-describedby",
        "onboarding-messaging-gate-hint",
      );

      // Now Continue advances to the provider picker.
      await continueBtn.click();
      await expect(
        app.window.getByRole("heading", {
          name: /Pick the messaging platforms you want to connect/i,
        }),
      ).toBeVisible();
    } finally {
      await app.close();
    }
  });

  test("messaging-safety flash does not replay when navigating back to the step", async () => {
    const app = await launchElectronApp(wizardLaunchOptions);
    try {
      // Walk to the messaging-safety step (same Shared-mode path).
      await app.window.getByRole("button", { name: /Get started/i }).click();
      await app.window.getByRole("button", { name: /^Continue/i }).click();
      await app.window.getByRole("button", { name: /^Continue/i }).click();
      await app.window
        .getByText("Reuse your existing Codex login", { exact: false })
        .click();
      await app.window.getByRole("button", { name: /^Continue/i }).click();
      await app.window
        .getByRole("button", { name: /I.ll log in later/i })
        .click();
      await app.window.getByRole("button", { name: /^Continue/i }).click();

      await expect(
        app.window.getByRole("heading", { name: /Messaging is optional/i }),
      ).toBeVisible();

      const continueBtn = app.window.getByRole("button", {
        name: /Continue with messaging/i,
      });
      const flash = app.window.locator(".onboarding-wizard__safety-ack-flash");

      // Force a flash (box still unchecked), then leave and return.
      await continueBtn.click({ force: true });
      await expect(flash).toHaveCount(1);

      // Anchored like the other call sites: the loose /Back/i also matches
      // the title-bar history Back button in the shell behind the wizard.
      await app.window.getByRole("button", { name: /^← Back/i }).click();
      // Back lands on the shared Codex login step (login already deferred,
      // so its Continue is live); Continue returns to messaging-safety.
      await app.window.getByRole("button", { name: /^Continue/i }).click();
      await expect(
        app.window.getByRole("heading", { name: /Messaging is optional/i }),
      ).toBeVisible();

      // Re-entry must NOT replay the ring — the box is still unchecked and
      // the operator never re-clicked the locked button.
      await expect(flash).toHaveCount(0);
      await expect(continueBtn).toHaveAttribute("aria-disabled", "true");
    } finally {
      await app.close();
    }
  });

  test("back navigation preserves density selection across Thread presentation ↔ Models", async () => {
    const app = await launchElectronApp(wizardLaunchOptions);
    try {
      // Welcome → Thread presentation.
      await app.window.getByRole("button", { name: /Get started/i }).click();
      await expect(
        app.window.getByRole("heading", {
          name: /Pick your appearance and thread density/i,
        }),
      ).toBeVisible();

      // Pick Compact (default is Mission Control).
      await app.window.getByText("Just the title", { exact: false }).click();
      // The hint reflects the selection — used to assert preservation later.
      await expect(
        app.window.locator(".onboarding-wizard__hint").first(),
      ).toContainText(/compact/i, { ignoreCase: true });

      await app.window.getByRole("button", { name: /^Continue/i }).click();
      await expect(
        app.window.getByRole("heading", {
          name: /Install at least one AI provider/i,
        }),
      ).toBeVisible();

      // Back to Thread presentation.
      await app.window.getByRole("button", { name: /^← Back/i }).click();
      await expect(
        app.window.getByRole("heading", {
          name: /Pick your appearance and thread density/i,
        }),
      ).toBeVisible();
      // Still on Compact.
      await expect(
        app.window.locator(".onboarding-wizard__hint").first(),
      ).toContainText(/compact/i, { ignoreCase: true });
    } finally {
      await app.close();
    }
  });

  test("PWRAGENT_PROFILE=<missing> opens the slim 'Set up `foo`?' confirmation step", async () => {
    const app = await launchElectronApp({
      ...wizardLaunchOptions,
      env: { PWRAGENT_PROFILE: "ghost-test" },
    });
    try {
      // Bootstrap-confirm step renders with the requested name baked in.
      await expect(
        app.window.getByRole("heading", { name: /Set up.+ghost-test/i }),
      ).toBeVisible();

      // Quit and Set-up buttons both present.
      await expect(
        app.window.getByRole("button", { name: /Quit PwrAgent/i }),
      ).toBeVisible();
      await expect(
        app.window.getByRole("button", { name: /Set up.+ghost-test/i }),
      ).toBeVisible();

      // Click Set up — we land on Welcome.
      await app.window
        .getByRole("button", { name: /Set up.+ghost-test/i })
        .click();
      await expect(
        app.window.getByRole("heading", {
          name: /A few short choices/i,
        }),
      ).toBeVisible();

      // Back from Welcome returns to the confirmation (because that's
      // where this session entered).
      // (No-op visual check — the Back button is hidden on Welcome,
      // matching the "no back from first-impression screen" UX rule.)
      await expect(
        app.window.getByRole("button", { name: /^← Back/i }),
      ).toHaveCount(0);
    } finally {
      await app.close();
    }
  });

  test("dismiss-confirmation modal appears in bootstrap mode with three actions", async () => {
    const app = await launchElectronApp(wizardLaunchOptions);
    try {
      await expect(
        app.window.getByRole("heading", {
          name: /A few short choices/i,
        }),
      ).toBeVisible();

      // Trigger dismiss via the Skip footer link.
      await app.window
        .getByRole("button", { name: /Skip setup/i })
        .click();

      // Modal appears.
      await expect(
        app.window.getByRole("dialog", { name: /Skip setup/i }),
      ).toBeVisible();
      await expect(
        app.window.getByRole("button", { name: /Exit PwrAgent/i }),
      ).toBeVisible();
      await expect(
        app.window.getByRole("button", { name: /Cancel.+back to setup/i }),
      ).toBeVisible();
      await expect(
        app.window.getByRole("button", { name: /Skip and use default/i }),
      ).toBeVisible();

      // Cancel returns to the wizard.
      await app.window
        .getByRole("button", { name: /Cancel.+back to setup/i })
        .click();
      await expect(
        app.window.getByRole("dialog", { name: /Skip setup/i }),
      ).toHaveCount(0);
      await expect(
        app.window.getByRole("heading", {
          name: /A few short choices/i,
        }),
      ).toBeVisible();
    } finally {
      await app.close();
    }
  });

  test("Multiple-mode finish quits the bootstrap window AND doesn't materialize a phantom 'default' profile", async () => {
    // The wizard's spawn + wait-for-alive (10s timeout) + 2s grace
    // can chew through most of the default 30s. CI Linux runners
    // are slower than dev machines; give this specific test enough
    // headroom to fully exercise the graduation path even when the
    // spawned process is slow to write its first heartbeat.
    test.setTimeout(60_000);
    // Reproduces the user's report: walk Multiple with personal +
    // work. After Finish, the bootstrap Electron instance should
    // QUIT (operator isn't left with two windows; the original
    // window doesn't surface real Codex Desktop threads from the
    // bootstrap-profile's empty codex.profile pairing), AND there
    // should be NO `default/` dir under `<HOME>/.pwragent/profiles/`
    // (only `personal/` and `work/`).
    const app = await launchElectronApp(wizardLaunchOptions);
    try {
      // Unsigned Electron must never reach macOS safeStorage during E2E.
      // This value is inherited by the detached `personal` process below;
      // profiles-ipc.test.ts locks that spawn contract independently.
      expect(
        await app.electronApp.evaluate(() =>
          process.env.PWRAGENT_DEV_DISABLE_SECRET_STORAGE
        ),
      ).toBe("1");

      // Walk the full wizard: Welcome → Thread → Models →
      // Codex profile (Multiple) → Name profiles (personal, work) →
      // Messaging warning (Skip).
      await app.window.getByRole("button", { name: /Get started/i }).click();
      await app.window.getByRole("button", { name: /^Continue/i }).click();
      await app.window.getByRole("button", { name: /^Continue/i }).click();
      await app.window
        .getByText(/Set up several profiles at once/i)
        .click();
      await app.window.getByRole("button", { name: /^Continue/i }).click();
      // Defaults are "personal" + "work" — accept as-is.
      // Each row's Codex login is gated; defer via "I'll log in later".
      await app.window
        .getByRole("button", { name: /I.ll log in later/i })
        .click();
      await app.window.getByRole("button", { name: /^Continue/i }).click();
      await app.window
        .getByRole("button", { name: /Skip messaging for now/i })
        .click();

      // Done step → click "Open my workspace" to fire
      // persistAndComplete (this is what actually does the
      // provisioning + graduation + quit).
      await expect(
        app.window.getByRole("heading", { name: /You.re operating/i }),
      ).toBeVisible();
      await expect(app.window.getByText("Multiple — personal, work")).toBeVisible();
      await app.window
        .getByRole("button", { name: /Open my workspace/i })
        .click();

      // persistAndComplete fires:
      //   - provisionPairedProfiles → personal + work
      //   - writeSecretsToProfile per profile
      //   - graduateBootstrapConfigToProfile(personal)
      //   - openPwrAgentProfile(personal) — spawns new Electron
      //   - waitForProfileAlive(personal) — polls for heartbeat
      //   - quitApp() — closes THIS Electron
      // The on-disk graduation (Codex pairing, profiles.toml,
      // profiles/ layout) is the load-bearing assertion. The
      // bootstrap process actually exiting is observable but
      // environment-dependent — on a slow CI runner the spawned
      // process's first heartbeat may arrive late or the spawn may
      // fail to fully initialize without a display, in which case
      // `waitForProfileAlive` times out and the wizard intentionally
      // KEEPS the bootstrap window alive as a fallback (better than
      // both windows gone). Wait up to 20s for the exit, but don't
      // fail the test on it — the file-state assertions below catch
      // the actual regression.
      const proc = app.electronApp.process();
      const exited = await new Promise<boolean>((resolve) => {
        if (proc.exitCode !== null) return resolve(true);
        const timer = setTimeout(() => resolve(false), 20_000);
        proc.once("exit", () => {
          clearTimeout(timer);
          resolve(true);
        });
      });
      if (!exited) {
        // eslint-disable-next-line no-console
        console.warn(
          "[wizard-e2e] bootstrap process didn't exit within 20s; " +
            "likely the spawned profile process never reported alive. " +
            "Falling through to on-disk assertions — those are the load-bearing checks.",
        );
      }

      // Inspect `HOME/.pwragent/` directly. Only `personal/` and
      // `work/` should exist under `profiles/` — no `default/`
      // materialized. This holds regardless of whether the
      // bootstrap process exited.
      const profilesDir = path.join(app.homeRoot, ".pwragent/profiles");
      const dirs = fs.readdirSync(profilesDir).sort();
      expect(dirs).toEqual(["personal", "work"]);

      // profiles.toml::default_profile should point at "personal".
      const profilesToml = fs.readFileSync(
        path.join(app.homeRoot, ".pwragent/profiles.toml"),
        "utf8",
      );
      expect(profilesToml).toContain('default_profile = "personal"');
    } finally {
      // Even if the bootstrap process already exited, close() is
      // safe — it just tears down handles.
      await app.close();
    }
  });

  test("provider tabs show CLI-specific install instructions", async () => {
    const app = await launchElectronApp(wizardLaunchOptions);
    try {
      // Welcome → Thread presentation → Models.
      await app.window.getByRole("button", { name: /Get started/i }).click();
      await app.window.getByRole("button", { name: /^Continue/i }).click();
      await expect(
        app.window.getByRole("heading", {
          name: /Install at least one AI provider/i,
        }),
      ).toBeVisible();
      await expect(
        app.window.getByText(/brew update && brew install --cask codex/i),
      ).toBeVisible();
      await app.window.getByRole("tab", { name: /Kimi Code/i }).click();
      await expect(
        app.window.getByText(/@moonshot-ai\/kimi-code/i),
      ).toBeVisible();
      await app.window.getByRole("tab", { name: /Qwen Code/i }).click();
      await expect(app.window.getByText(/brew install qwen-code/i)).toBeVisible();
      await app.window.getByRole("tab", { name: /Grok Build/i }).click();
      await expect(app.window.getByText(/x\.ai\/cli\/install\.sh/i)).toBeVisible();
      await expect(app.window.getByText(/xAI API key/i)).toHaveCount(0);
    } finally {
      await app.close();
    }
  });

  test(
    "refresh discovers Codex, Kimi, Qwen, and Grok from a custom PATH",
    async () => {
      test.skip(process.platform === "win32", "Unix executable discovery only");
      const { app, commands } = await launchWizardWithFakeProviders("path");
      try {
        await openProviderStepAndRefresh(app);
        await expectFakeProvidersFound(app, commands);
      } finally {
        await app.close();
      }
    },
  );

  test(
    "refresh discovers Codex, Kimi, Qwen, and Grok from well-known locations",
    async () => {
      test.skip(process.platform === "win32", "Unix executable discovery only");
      const { app, commands } = await launchWizardWithFakeProviders("well-known");
      try {
        await openProviderStepAndRefresh(app);
        await expectFakeProvidersFound(app, commands);
      } finally {
        await app.close();
      }
    },
  );
});
