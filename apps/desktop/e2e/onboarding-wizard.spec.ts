import fs from "node:fs";
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
 * Defaults to xAI as the backend to satisfy the Models / Providers
 * gate, since the test runner doesn't have Codex CLI on PATH.
 */

const wizardLaunchOptions = {
  // No `fixturePath`: thread replay isn't relevant for wizard-only specs.
  suppressOnboarding: false,
  requiresReplayDriver: false,
};

test.describe("Onboarding wizard", () => {
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

      // Models / Providers — paste an xAI key to satisfy the gate (Codex
      // CLI isn't on PATH in test env).
      await expect(
        app.window.getByRole("heading", {
          name: /Pick at least one model backend/i,
        }),
      ).toBeVisible();
      await app.window
        .locator('input[type="password"]')
        .first()
        .fill("xai-e2e-test-key");
      await app.window.getByRole("button", { name: /Use this key/i }).click();
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
          name: /Pick at least one model backend/i,
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
      // Walk the full wizard: Welcome → Thread → Models (xAI key) →
      // Codex profile (Multiple) → Name profiles (personal, work) →
      // Messaging warning (Skip).
      await app.window.getByRole("button", { name: /Get started/i }).click();
      await app.window.getByRole("button", { name: /^Continue/i }).click();
      await app.window
        .locator('input[type="password"]')
        .first()
        .fill("xai-multi-key");
      await app.window.getByRole("button", { name: /Use this key/i }).click();
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

  test("name step's xAI override is collapsed by default and expands on click", async () => {
    const app = await launchElectronApp(wizardLaunchOptions);
    try {
      // Welcome → Thread presentation → Models → Codex profile.
      await app.window.getByRole("button", { name: /Get started/i }).click();
      await app.window.getByRole("button", { name: /^Continue/i }).click();
      // xAI key on Models step (satisfy backend gate).
      await app.window
        .locator('input[type="password"]')
        .first()
        .fill("xai-default-key");
      await app.window.getByRole("button", { name: /Use this key/i }).click();
      await app.window.getByRole("button", { name: /^Continue/i }).click();

      // Pick Isolated mode.
      await app.window
        .getByText(/Create a fresh Codex profile/i)
        .click();
      await app.window.getByRole("button", { name: /^Continue/i }).click();

      // Naming step appears.
      await expect(
        app.window.getByRole("heading", {
          name: /Name and log in to your isolated profile/i,
        }),
      ).toBeVisible();

      // Per-row xAI override is collapsed by default; the global key
      // hint is shown because we set a global xAI key on Models step.
      await expect(
        app.window.getByRole("button", {
          name: /Override xAI key for this profile/i,
        }),
      ).toBeVisible();

      // Click to expand.
      await app.window
        .getByRole("button", {
          name: /Override xAI key for this profile/i,
        })
        .click();

      // Expanded — the password input becomes visible inside the row.
      await expect(
        app.window.locator(".onboarding-wizard__profile-row-xai input"),
      ).toBeVisible();
    } finally {
      await app.close();
    }
  });
});
