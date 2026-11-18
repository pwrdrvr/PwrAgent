import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findLiveProfileRuntimeMarkers, isProcessAlive } from "../src/main/profile";
import { expect, test } from "./fixtures/electron-test";
import {
  graduatedProfileOwnerArg,
  killGraduatedProfileInstances,
} from "./fixtures/detached-profile-instances";
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
 * Uses a deterministic fake Codex executable whose version output satisfies
 * the provider gate without depending on a real install or external login.
 */

const fakeProviderNames = [
  "codex",
  "gemini",
  "kimi",
  "qwen",
  "grok",
] as const;
type FakeProviderName = (typeof fakeProviderNames)[number];
const fakeProviderVersions: Record<FakeProviderName, string> = {
  codex: "999.0.0",
  gemini: "999.0.0",
  kimi: "0.999.0",
  qwen: "999.0.0",
  grok: "999.0.0",
};

function fakeProviderScript(): string {
  return `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const name = path.basename(process.argv[1]).replace(/\\.(?:cmd|c?js)$/i, "");
const args = process.argv.slice(2);
const execLog = process.env.PWRAGENT_E2E_PROVIDER_EXEC_LOG;
if (execLog) {
  fs.appendFileSync(execLog, JSON.stringify({ name, args }) + "\\n");
}

if (args.includes("--version")) {
  // Current Kimi Code reports a bare 0.x version. Its retired Python
  // predecessor owns the 1.x line, so the shared v999 fixture would
  // intentionally be rejected by PwrAgent's compatibility gate.
  const version = ${JSON.stringify(fakeProviderVersions)}[name];
  console.log(name === "kimi" ? version : name + " " + version);
  process.exit(0);
}

if (name === "codex" && args[0] === "login" && args[1] === "status") {
  console.error("Not logged in");
  process.exit(1);
}

if (name === "qwen") {
  console.log("Qwen Code");
} else if (name === "grok") {
  console.log("Run the agent over stdio");
} else if (name === "kimi") {
  console.log("Agent Client Protocol server over stdio");
} else if (name === "gemini") {
  console.log("--acp");
} else {
  console.log("Codex CLI");
}
`;
}

async function launchWizard(
  env: Record<string, string | undefined> = {},
  graduation?: { profile: string; failBoot?: boolean },
) {
  const homeRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "pwragent-onboarding-wizard-e2e-"),
  );
  const codexCommand = path.join(
    homeRoot,
    ".local",
    "bin",
    process.platform === "win32" ? "codex.cmd" : "codex",
  );
  fs.mkdirSync(path.dirname(codexCommand), { recursive: true });
  if (process.platform === "win32") {
    const scriptPath = path.join(path.dirname(codexCommand), "codex.js");
    fs.writeFileSync(scriptPath, fakeProviderScript(), "utf8");
    fs.writeFileSync(
      codexCommand,
      `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`,
      "utf8",
    );
  } else {
    fs.writeFileSync(codexCommand, fakeProviderScript(), "utf8");
    fs.chmodSync(codexCommand, 0o755);
  }

  return await launchElectronApp({
    homeRoot,
    // No `fixturePath`: thread replay isn't relevant for wizard-only specs.
    suppressOnboarding: false,
    requiresReplayDriver: false,
    ...(graduation
      ? {
          extraArgs: [
            graduatedProfileOwnerArg(homeRoot),
            ...(graduation.failBoot ? ["--pwragent-e2e-fail-profile-boot"] : []),
          ],
          cleanupDetachedProcesses: () =>
            killGraduatedProfileInstances(graduation.profile, homeRoot),
        }
      : {}),
    env: {
      PWRAGENT_CODEX_COMMAND: codexCommand,
      ...env,
    },
  });
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
    gemini: path.join(homeRoot, ".local", "bin", "gemini"),
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
  const execLogPath = path.join(homeRoot, "provider-exec.jsonl");
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
        PWRAGENT_E2E_PROVIDER_EXEC_LOG: execLogPath,
        PWRAGENT_CODEX_COMMAND: undefined,
        SHELL: process.platform === "darwin" ? "/bin/zsh" : "/bin/bash",
      },
    });
    return { app, commands, execLogPath };
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
    gemini: "Gemini CLI",
    kimi: "Kimi Code",
    qwen: "Qwen Code",
    grok: "Grok Build",
  };
  for (const name of fakeProviderNames) {
    await app.window
      .getByRole("tab", { name: new RegExp(providerLabels[name], "i") })
      .click();
    const panel = app.window.getByRole("tabpanel");
    await expect(
      panel.getByText(`✓ Found v${fakeProviderVersions[name]}`),
    ).toBeVisible();
    await expect(panel.getByText(commands[name], { exact: true })).toBeVisible();
  }
}

type WizardApp = Awaited<ReturnType<typeof launchWizard>>;

async function reachMultipleFinish(app: WizardApp): Promise<void> {
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

  await expect(
    app.window.getByRole("heading", { name: /You.re operating/i }),
  ).toBeVisible();
  await expect(app.window.getByText("Multiple — personal, work")).toBeVisible();
}

function expectMultipleProfilesPersisted(app: WizardApp): void {
  const root = path.join(app.homeRoot, ".pwragent");
  expect(fs.readdirSync(path.join(root, "profiles")).sort()).toEqual(["personal", "work"]);
  expect(fs.readFileSync(path.join(root, "profiles.toml"), "utf8"))
    .toContain('default_profile = "personal"');
}

async function observeBootstrap(app: WizardApp) {
  return {
    // On Windows the Playwright child can be a launcher. Capture Electron's
    // own PID before the finish action can dispose its inspector connection.
    pid: await app.electronApp.evaluate(() => process.pid),
    child: app.electronApp.process(),
  };
}

async function expectGraduationHandoff(
  app: WizardApp,
  bootstrap: Awaited<ReturnType<typeof observeBootstrap>>,
  profile: string,
  timeout: number,
): Promise<void> {
  await expect.poll(
    () => ({
      bootstrapAlive: isProcessAlive(bootstrap.pid),
      launcherExitCode: bootstrap.child.exitCode,
      launcherSignal: bootstrap.child.signalCode,
    }),
    { message: `Bootstrap should exit cleanly after handing off to "${profile}"`, timeout },
  ).toEqual({ bootstrapAlive: false, launcherExitCode: 0, launcherSignal: null });

  // The marker belongs to the isolated home. A detached runtime must still
  // be alive after bootstrap exits, with its own PID and chosen profile.
  const markers = findLiveProfileRuntimeMarkers(profile, {
    env: { PWRAGENT_HOME: path.join(app.homeRoot, ".pwragent") },
  });
  expect(markers, `Expected a live replacement for "${profile}" after bootstrap exit`).toHaveLength(1);
  expect(markers[0]?.processId).not.toBe(bootstrap.pid);
}

test.describe("Onboarding wizard", () => {
  test("fires on a fresh PWRAGENT_HOME and walks Welcome → Done in Shared mode", async () => {
    // The geometry check below is the product's work-area fit, so this
    // launch keeps it.
    const app = await launchWizard({ PWRAGENT_E2E_LARGER_THAN_SCREEN: undefined });
    try {
      // Welcome screen visible.
      await expect(
        app.window.getByRole("heading", {
          name: /A few short choices/i,
        }),
      ).toBeVisible();

      const geometry = await app.electronApp.evaluate(
        ({ BrowserWindow, screen }) => {
          const mainWindow = BrowserWindow.getAllWindows()[0];
          if (!mainWindow) {
            throw new Error("Expected the onboarding BrowserWindow");
          }
          const bounds = mainWindow.getBounds();
          return {
            bounds,
            workArea: screen.getDisplayMatching(bounds).workArea,
          };
        },
      );
      expect(geometry.bounds.x).toBeGreaterThanOrEqual(geometry.workArea.x);
      expect(geometry.bounds.y).toBeGreaterThanOrEqual(geometry.workArea.y);
      expect(geometry.bounds.x + geometry.bounds.width).toBeLessThanOrEqual(
        geometry.workArea.x + geometry.workArea.width,
      );
      expect(geometry.bounds.y + geometry.bounds.height).toBeLessThanOrEqual(
        geometry.workArea.y + geometry.workArea.height,
      );

      const wizard = await app.window.locator(".onboarding-wizard").boundingBox();
      const viewport = await app.window.evaluate(() => ({
        height: globalThis.innerHeight,
        width: globalThis.innerWidth,
      }));
      expect(wizard).not.toBeNull();
      expect(
        Math.abs((wizard!.x + wizard!.width / 2) - viewport.width / 2),
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs((wizard!.y + wizard!.height / 2) - viewport.height / 2),
      ).toBeLessThanOrEqual(1);

      // Get started → Thread presentation.
      await app.window.getByRole("button", { name: /Get started/i }).click();
      await expect(
        app.window.getByRole("heading", {
          name: /Pick your appearance and thread density/i,
        }),
      ).toBeVisible();

      // Pick Compact density (so we can later assert back-nav preserved it).
      await app.window.getByRole("radio", { name: /^Compact/ }).click();
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

  test("messaging-safety gate flashes once, resets on re-entry, and unlocks after acknowledgement", async () => {
    const app = await launchWizard();
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

      // Leaving and returning clears the one-shot attention ring without
      // replaying it. The acknowledgement remains unchecked and the gate
      // remains locked until the operator acts again.
      await app.window.getByRole("button", { name: /^← Back/i }).click();
      await app.window.getByRole("button", { name: /^Continue/i }).click();
      await expect(
        app.window.getByRole("heading", { name: /Messaging is optional/i }),
      ).toBeVisible();
      await expect(flash).toHaveCount(0);
      await expect(continueBtn).toHaveAttribute("aria-disabled", "true");

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

  test("back navigation preserves the Welcome round trip and density selection across Thread presentation ↔ Models", async () => {
    const app = await launchWizard();
    try {
      // Welcome → Thread presentation.
      await app.window.getByRole("button", { name: /Get started/i }).click();
      await expect(
        app.window.getByRole("heading", {
          name: /Pick your appearance and thread density/i,
        }),
      ).toBeVisible();

      // The first Back round trip returns to Welcome and can re-enter the
      // presentation step without losing the navigation path.
      await app.window.getByRole("button", { name: /^← Back/i }).click();
      await expect(
        app.window.getByRole("heading", {
          name: /A few short choices/i,
        }),
      ).toBeVisible();
      await app.window.getByRole("button", { name: /Get started/i }).click();
      await expect(
        app.window.getByRole("heading", {
          name: /Pick your appearance and thread density/i,
        }),
      ).toBeVisible();

      // Pick Compact (default is Mission Control).
      await app.window.getByRole("radio", { name: /^Compact/ }).click();
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
    const app = await launchWizard({ PWRAGENT_PROFILE: "ghost-test" });
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
    } finally {
      await app.close();
    }
  });

  test("dismiss-confirmation modal appears in bootstrap mode with three actions", async () => {
    const app = await launchWizard();
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

  test("requested-profile bootstrap relaunches that profile after Skip", async () => {
    test.skip(
      process.platform === "linux",
      "Native detached profile handoff is covered on macOS and Windows.",
    );
    test.setTimeout(60_000);
    const app = await launchWizard({ PWRAGENT_PROFILE: "test2" }, { profile: "test2" });
    try {
      await expect(
        app.window.getByRole("heading", { name: /Set up.+test2/i }),
      ).toBeVisible();
      await app.window
        .getByRole("button", { name: /Set up.+test2/i })
        .click();
      await app.window
        .getByRole("button", { name: /Skip setup/i })
        .click();

      const bootstrap = await observeBootstrap(app);
      await app.window
        .getByRole("button", { name: /Skip and use default/i })
        .click();

      await expectGraduationHandoff(app, bootstrap, "test2", 30_000);
      const profileConfig = fs.readFileSync(
        path.join(app.homeRoot, ".pwragent", "profiles", "test2", "config.toml"),
        "utf8",
      );
      expect(profileConfig).toContain("completed = true");
    } finally {
      await app.close();
    }
  });

  test("Multiple-mode finish hands off from bootstrap to the first profile", async () => {
    test.skip(
      process.platform === "linux",
      "Native detached profile handoff is covered on macOS and Windows.",
    );
    test.setTimeout(60_000);
    const app = await launchWizard({}, { profile: "personal" });
    try {
      // The detached process inherits this harness setting from bootstrap.
      expect(
        await app.electronApp.evaluate(() => process.env.PWRAGENT_DEV_DISABLE_SECRET_STORAGE),
      ).toBe("1");
      await reachMultipleFinish(app);
      const bootstrap = await observeBootstrap(app);
      await app.window.getByRole("button", { name: /Open my workspace/i }).click();

      await expectGraduationHandoff(app, bootstrap, "personal", 20_000);
      expectMultipleProfilesPersisted(app);
    } finally {
      await app.close();
    }
  });

  test("Multiple-mode finish preserves bootstrap and both profiles when the replacement fails to start", async () => {
    test.setTimeout(60_000);
    const app = await launchWizard({}, { profile: "personal", failBoot: true });
    try {
      await reachMultipleFinish(app);
      const bootstrap = await observeBootstrap(app);
      await Promise.all([
        app.window.waitForEvent("console", {
          predicate: (message) =>
            message.type() === "warning"
            && message.text().includes("keeping bootstrap window open"),
        }),
        app.window.getByRole("button", { name: /Open my workspace/i }).click(),
      ]);

      // The detached Electron reached the E2E entry, which exited it before
      // application initialization. The real readiness poll took the fallback.
      const launchedPids = fs.readdirSync(path.join(app.homeRoot, "chromium"))
        .map(Number).filter((pid) => pid !== bootstrap.pid);
      expect(launchedPids).toHaveLength(1);
      expect(isProcessAlive(launchedPids[0]!)).toBe(false);
      expect(await app.electronApp.evaluate(() => process.pid)).toBe(bootstrap.pid);
      await expect(app.window.getByRole("dialog", { name: "First-run setup" })).toBeHidden();
      expectMultipleProfilesPersisted(app);
    } finally {
      await app.close();
    }
  });

  test("provider tabs show CLI-specific install instructions", async () => {
    const app = await launchWizard();
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
        app.window.getByText(
          process.platform === "win32"
            ? /chatgpt\.com\/codex\/install\.ps1/i
            : /chatgpt\.com\/codex\/install\.sh/i,
        ),
      ).toBeVisible();
      await app.window.getByRole("tab", { name: /Gemini CLI/i }).click();
      await expect(
        app.window.getByText(/@google\/gemini-cli/i),
      ).toBeVisible();
      await app.window.getByRole("tab", { name: /Kimi Code/i }).click();
      await expect(
        app.window.getByText(
          process.platform === "win32"
            ? /kimi-code\/install\.ps1/i
            : /kimi-code\/install\.sh/i,
        ),
      ).toBeVisible();
      await app.window.getByRole("tab", { name: /Qwen Code/i }).click();
      await expect(
        app.window.getByText(
          process.platform === "win32"
            ? /install-qwen-standalone\.ps1/i
            : /install-qwen-standalone\.sh/i,
        ),
      ).toBeVisible();
      await app.window.getByRole("tab", { name: /Grok Build/i }).click();
      await expect(
        app.window.getByText(
          process.platform === "win32"
            ? /x\.ai\/cli\/install\.ps1/i
            : /x\.ai\/cli\/install\.sh/i,
        ),
      ).toBeVisible();
    } finally {
      await app.close();
    }
  });

  test("entering AI Providers does not launch Gemini before explicit login", async () => {
    test.skip(process.platform === "win32", "Unix executable discovery only");
    const { app, execLogPath } = await launchWizardWithFakeProviders("path");
    try {
      await app.window.getByRole("button", { name: /Get started/i }).click();
      await app.window.getByRole("button", { name: /^Continue/i }).click();
      await expect(
        app.window.getByRole("tab", { name: /Gemini CLI Installed/i }),
      ).toBeVisible({ timeout: 20_000 });

      const executions = fs
        .readFileSync(execLogPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as {
          name: string;
          args: string[];
        });
      expect(executions.some((execution) => execution.name === "gemini")).toBe(true);
      expect(
        executions.some(
          (execution) =>
            execution.name === "gemini" && execution.args.includes("--acp"),
        ),
      ).toBe(false);
    } finally {
      await app.close();
    }
  });

  test(
    "refresh discovers Codex, Gemini, Kimi, Qwen, and Grok from a custom PATH",
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
    "refresh discovers Codex, Gemini, Kimi, Qwen, and Grok from well-known locations",
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
