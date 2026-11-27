import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findLiveProfileRuntimeMarkers, isProcessAlive } from "../src/main/profile";
import { E2E_ACP_DISCOVERY_ROOT_ENV } from "../src/main/settings/desktop-settings-env";
import { APP_QUIT_CHANNEL, PROFILES_OPEN_CHANNEL } from "../src/shared/ipc";
import { expect, test } from "./fixtures/electron-test";
import {
  graduatedProfileOwnerArg,
  killGraduatedProfileInstances,
} from "./fixtures/detached-profile-instances";
import { launchElectronApp } from "./fixtures/electron-app";

/**
 * Get started E2Es. These specs run the desktop binary against a brand-new
 * `HOME` (no `~/.pwragent/profiles/default/` pre-seeded) so the boot
 * decision returns `no-profile-configured` or `missing-named-profile` and
 * the first-run page opens for real.
 *
 * They cover what one page has to get right: which agents it finds, what
 * Start waits for, the named-profile confirmation, the skip dialog, and the
 * handoff from the bootstrap window to the new profile. They never finish
 * Codex SSO, which needs a network round-trip and a real browser; the
 * sign-in buttons are covered by `GetStarted.test.tsx`.
 *
 * Uses a deterministic fake Codex executable whose version output satisfies
 * discovery and whose `login status` reports no login.
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

async function launchGetStarted(
  env: Record<string, string | undefined> = {},
  { graduatedProfile, isolateAcpDiscovery }: {
    graduatedProfile?: string;
    isolateAcpDiscovery?: boolean;
  } = {},
) {
  const homeRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "pwragent-get-started-e2e-"),
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
    // No `fixturePath`: thread replay isn't relevant to first run.
    suppressOnboarding: false,
    requiresReplayDriver: false,
    ...(graduatedProfile
      ? {
          extraArgs: [graduatedProfileOwnerArg(homeRoot)],
          cleanupDetachedProcesses: (deadline) =>
            killGraduatedProfileInstances(graduatedProfile, homeRoot, deadline),
        }
      : {}),
    env: {
      ...(isolateAcpDiscovery ? absentAcpDiscoveryEnv(homeRoot) : {}),
      PWRAGENT_CODEX_COMMAND: codexCommand,
      ...env,
    },
  });
}

function absentAcpDiscoveryEnv(homeRoot: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  // Drop inherited CLI overrides and all PATH spellings (Windows folds case).
  for (const key of Object.keys(process.env)) {
    if (/^(?:PATH|PWRAGENT_ACP_AGENTS_.*_CLI_PATH)$/i.test(key)) {
      env[key] = undefined;
    }
  }
  env[E2E_ACP_DISCOVERY_ROOT_ENV] = homeRoot;
  if (process.platform === "win32") {
    env.PATH = path.join(homeRoot, ".local", "bin");
  } else {
    env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
    env.SHELL = process.platform === "darwin" ? "/bin/zsh" : "/bin/bash";
    env.ZDOTDIR = homeRoot;
    // Login shells can restore paths through /etc/zprofile (path_helper on
    // macOS) or /etc/profile. Reset PATH after those files run.
    const profile = `export PATH="${env.PATH}"\n`;
    for (const name of [".profile", ".bash_profile", ".zprofile"]) {
      fs.writeFileSync(path.join(homeRoot, name), profile, "utf8");
    }
  }
  return env;
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

async function launchGetStartedWithFakeProviders(
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

type GetStartedApp = Awaited<ReturnType<typeof launchGetStarted>>;

const agentLabels: Record<FakeProviderName, string> = {
  codex: "Codex",
  gemini: "Gemini CLI",
  kimi: "Kimi Code",
  qwen: "Qwen Code",
  grok: "Grok Build",
};

function page(app: GetStartedApp) {
  return app.window.getByRole("dialog", { name: "Get started" });
}

function agentRow(app: GetStartedApp, id: string) {
  return page(app).locator(`li[data-agent="${id}"]`);
}

function checkAgainButton(app: GetStartedApp) {
  return page(app).locator(".get-started__section-head").getByRole("button");
}

/** The page checks every agent when it opens; wait for that to finish. */
async function waitForDiscovery(app: GetStartedApp): Promise<void> {
  await expect(checkAgainButton(app)).toHaveText("Check again", { timeout: 20_000 });
}

/** Check again, then wait for discovery to settle. */
async function checkAgain(app: GetStartedApp): Promise<void> {
  await waitForDiscovery(app);
  await checkAgainButton(app).click();
  await waitForDiscovery(app);
}

/** Expands the agents that are neither primary nor found. */
async function showMoreAgents(app: GetStartedApp): Promise<void> {
  await waitForDiscovery(app);
  const more = page(app).getByRole("button", { name: /^More agents/ });
  if (await more.count()) await more.click();
}

function expectProfilesPersisted(app: GetStartedApp, profiles: string[]): void {
  const root = path.join(app.homeRoot, ".pwragent");
  expect(fs.readdirSync(path.join(root, "profiles")).sort()).toEqual(profiles);
}

async function observeBootstrap(app: GetStartedApp) {
  const child = app.electronApp.process();
  let launcherClosed = false;
  child.once("close", () => { launcherClosed = true; });
  return {
    // On Windows the Playwright child can be a launcher. Capture Electron's
    // own PID before the finish action can dispose its inspector connection.
    pid: await app.electronApp.evaluate(() => process.pid),
    child,
    launcherClosed: () => launcherClosed,
  };
}

async function expectGraduationHandoff(
  app: GetStartedApp,
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

  if (process.platform === "win32") {
    // The OS closes the launcher pipes only after every writer releases them.
    // Check before fixture teardown can kill the replacement and hide a leak.
    await expect.poll(bootstrap.launcherClosed, {
      message: "Bootstrap launcher pipes should close before sweeping the live replacement",
    }).toBe(true);
  }

  // The marker belongs to the isolated home. A detached runtime must still
  // be alive after the launcher check, with its own PID and chosen profile.
  const markers = findLiveProfileRuntimeMarkers(profile, {
    env: { PWRAGENT_HOME: path.join(app.homeRoot, ".pwragent") },
  });
  expect(markers, `Expected a live replacement for "${profile}" after bootstrap exit`).toHaveLength(1);
  expect(markers[0]?.processId).not.toBe(bootstrap.pid);
}

/** Confirms the requested profile, then waits for the agents to load. */
async function confirmRequestedProfile(app: GetStartedApp, profile: string): Promise<void> {
  await page(app).getByRole("button", { name: new RegExp(`Set up.+${profile}`, "i") }).click();
  await expect(
    page(app).getByRole("radio", { name: /A separate Codex login/ }),
  ).toHaveAttribute("aria-checked", "true");
}

test.describe("Get started", () => {
  test("opens on a fresh PWRAGENT_HOME as one centred page that waits for a ready agent", async () => {
    // The geometry check below is the product's work-area fit, so this
    // launch keeps it.
    const app = await launchGetStarted({ PWRAGENT_E2E_LARGER_THAN_SCREEN: undefined });
    try {
      await expect(
        page(app).getByRole("heading", { name: "Set up an agent to start." }),
      ).toBeVisible();

      const geometry = await app.electronApp.evaluate(
        ({ BrowserWindow, screen }) => {
          const mainWindow = BrowserWindow.getAllWindows()[0];
          if (!mainWindow) {
            throw new Error("Expected the first-run BrowserWindow");
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

      const card = await app.window.locator(".get-started").boundingBox();
      const viewport = await app.window.evaluate(() => ({
        height: globalThis.innerHeight,
        width: globalThis.innerWidth,
      }));
      expect(card).not.toBeNull();
      expect(
        Math.abs((card!.x + card!.width / 2) - viewport.width / 2),
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs((card!.y + card!.height / 2) - viewport.height / 2),
      ).toBeLessThanOrEqual(1);

      // The fake Codex is installed but reports no login. Nothing is ready,
      // so Start says why it waits.
      await expect(agentRow(app, "codex")).toContainText("Needs sign-in", { timeout: 20_000 });
      await expect(agentRow(app, "codex").getByRole("button", { name: "Sign in with ChatGPT" })).toBeVisible();
      const start = page(app).getByRole("button", { name: "Start", exact: true });
      await expect(start).toBeDisabled();
      await expect(start).toHaveAccessibleDescription("Set up one agent to start.");

      // An unnamed launch never asks which Codex login to use, and the
      // optional setup the wizard used to ask for lives in Settings.
      await expect(page(app).getByRole("radiogroup")).toHaveCount(0);
      await expect(page(app).getByText(/Messaging is optional/i)).toHaveCount(0);
      await expect(page(app).getByText(/thread density/i)).toHaveCount(0);
    } finally {
      await app.close();
    }
  });

  test("PWRAGENT_PROFILE=<missing> confirms the name, then asks which Codex login it uses", async () => {
    const app = await launchGetStarted({ PWRAGENT_PROFILE: "ghost-test" });
    try {
      await expect(
        page(app).getByRole("heading", { name: /Set up.+ghost-test/i }),
      ).toBeVisible();
      await expect(page(app).getByRole("button", { name: /Quit PwrAgent/i })).toBeVisible();

      await confirmRequestedProfile(app, "ghost-test");
      await expect(page(app).getByRole("heading", { name: /to start\.$|are ready\.$/ })).toBeVisible();
      // A separate login is made in the new profile after setup, so an
      // installed Codex is enough to start.
      await expect(agentRow(app, "codex")).toContainText("Sign in after setup, in the new profile", {
        timeout: 20_000,
      });
      await expect(page(app).getByRole("button", { name: "Start", exact: true })).toBeEnabled();

      // Sharing this computer's login puts its sign-in state back in charge.
      await page(app).getByRole("radio", { name: /This computer.s Codex login/ }).click();
      await expect(agentRow(app, "codex")).toContainText("Needs sign-in", { timeout: 20_000 });
      await expect(page(app).getByRole("button", { name: "Start", exact: true })).toBeDisabled();
    } finally {
      await app.close();
    }
  });

  test("closing in bootstrap mode asks before creating a profile or quitting", async () => {
    const app = await launchGetStarted();
    try {
      await expect(
        page(app).getByRole("heading", { name: "Set up an agent to start." }),
      ).toBeVisible();

      await page(app).getByRole("button", { name: "Close setup" }).click();
      const dialog = app.window.getByRole("dialog", { name: "Skip setup?" });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Quit PwrAgent" })).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Back to setup" })).toBeFocused();
      await expect(dialog.getByRole("button", { name: "Continue without an agent" })).toBeVisible();

      await dialog.getByRole("button", { name: "Back to setup" }).click();
      await expect(dialog).toHaveCount(0);
      await expect(
        page(app).getByRole("heading", { name: "Set up an agent to start." }),
      ).toBeVisible();
    } finally {
      await app.close();
    }
  });

  test("requested-profile bootstrap relaunches that profile after Start without an agent", async () => {
    test.skip(
      process.platform === "linux",
      "Detached Linux handoff requires a sandbox-enabled CI launch.",
    );
    test.setTimeout(60_000);
    const app = await launchGetStarted({ PWRAGENT_PROFILE: "test2" }, { graduatedProfile: "test2" });
    try {
      await expect(
        page(app).getByRole("heading", { name: /Set up.+test2/i }),
      ).toBeVisible();
      await confirmRequestedProfile(app, "test2");

      const bootstrap = await observeBootstrap(app);
      await page(app).getByRole("button", { name: "Start without an agent" }).click();

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

  test("Start with a separate Codex login hands off from bootstrap to that profile", async () => {
    test.skip(
      process.platform === "linux",
      "Detached Linux handoff requires a sandbox-enabled CI launch.",
    );
    test.setTimeout(60_000);
    const app = await launchGetStarted({ PWRAGENT_PROFILE: "work" }, { graduatedProfile: "work" });
    try {
      // The detached process inherits this harness setting from bootstrap.
      expect(
        await app.electronApp.evaluate(() => process.env.PWRAGENT_DEV_DISABLE_SECRET_STORAGE),
      ).toBe("1");
      await confirmRequestedProfile(app, "work");
      const start = page(app).getByRole("button", { name: "Start", exact: true });
      await expect(start).toBeEnabled({ timeout: 20_000 });
      const bootstrap = await observeBootstrap(app);
      await start.click();

      await expectGraduationHandoff(app, bootstrap, "work", 20_000);
      expectProfilesPersisted(app, ["work"]);
    } finally {
      await app.close();
    }
  });

  test("Start keeps the bootstrap window and the new profile when the replacement never reports ready", async () => {
    test.setTimeout(60_000);
    const app = await launchGetStarted({ PWRAGENT_PROFILE: "work" });
    try {
      await confirmRequestedProfile(app, "work");
      const start = page(app).getByRole("button", { name: "Start", exact: true });
      await expect(start).toBeEnabled({ timeout: 20_000 });
      const bootstrap = await observeBootstrap(app);
      // Model an accepted launch whose process never publishes a heartbeat.
      // Leave the real readiness IPC and the page's fallback in place.
      await app.window.clock.install();
      const requests = await app.electronApp.evaluateHandle(({ ipcMain }, { open, quit }) => {
        const calls = { profiles: [] as string[], quit: 0 };
        ipcMain.removeHandler(quit);
        ipcMain.handle(quit, () => { calls.quit += 1; });
        ipcMain.removeHandler(open);
        ipcMain.handle(open, (_event, { profile }: { profile: string }) => {
          calls.profiles.push(profile);
          return { opened: true, profile };
        });
        return calls;
      }, { open: PROFILES_OPEN_CHANNEL, quit: APP_QUIT_CHANNEL });
      await Promise.all([
        app.window.waitForEvent("console", {
          predicate: (message) =>
            message.type() === "warning"
            && message.text().includes("keeping this window open"),
        }),
        start.click(),
      ]);

      // Flush the post-heartbeat grace timer and round-trip through main IPC
      // before checking that the timeout branch never requested a quit.
      await app.window.clock.runFor(2_500);
      await app.window.evaluate(() => {
        const api = Reflect.get(window, "pwragent") as { getBootInfo(): Promise<unknown> };
        return api.getBootInfo();
      });
      expect(await requests.jsonValue()).toEqual({ profiles: ["work"], quit: 0 });
      expect(await app.electronApp.evaluate(() => process.pid)).toBe(bootstrap.pid);
      await expect(page(app)).toBeHidden();
      expectProfilesPersisted(app, ["work"]);
    } finally {
      await app.close();
    }
  });

  test("Install shows each agent's own install commands", async () => {
    const app = await launchGetStarted({}, { isolateAcpDiscovery: true });
    try {
      await expect(agentRow(app, "codex")).toContainText("Needs sign-in", { timeout: 20_000 });
      await showMoreAgents(app);
      const expected: Array<[string, RegExp]> = [
        ["gemini", /@google\/gemini-cli/i],
        [
          "kimi",
          process.platform === "win32" ? /kimi-code\/install\.ps1/i : /kimi-code\/install\.sh/i,
        ],
        [
          "qwen",
          process.platform === "win32"
            ? /install-qwen-standalone\.ps1/i
            : /install-qwen-standalone\.sh/i,
        ],
        ["grok", process.platform === "win32" ? /x\.ai\/cli\/install\.ps1/i : /x\.ai\/cli\/install\.sh/i],
      ];
      for (const [id, command] of expected) {
        const row = agentRow(app, id);
        await expect(row).toContainText("Not installed");
        await row.getByRole("button", { name: "Install", exact: true }).click();
        await expect(row.getByText(command).first()).toBeVisible();
        await expect(row.getByRole("link", { name: "Official setup guide" })).toBeVisible();
      }
    } finally {
      await app.close();
    }
  });

  test("opening Get started does not launch Gemini in ACP mode", async () => {
    test.skip(process.platform === "win32", "Unix executable discovery only");
    const { app, execLogPath } = await launchGetStartedWithFakeProviders("path");
    try {
      await showMoreAgents(app);
      await expect(agentRow(app, "gemini")).toContainText(/Ready|Installed, off/);

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

  for (const source of ["path", "well-known"] as const) {
    test(`Check again finds Codex, Gemini, Kimi, Qwen, and Grok from ${source === "path" ? "a custom PATH" : "well-known locations"}`, async () => {
      test.skip(process.platform === "win32", "Unix executable discovery only");
      const { app } = await launchGetStartedWithFakeProviders(source);
      try {
        await checkAgain(app);
        await showMoreAgents(app);
        await expect(agentRow(app, "codex")).toContainText("Needs sign-in");
        for (const name of fakeProviderNames.filter((name) => name !== "codex")) {
          const row = agentRow(app, name);
          await expect(row).toContainText(agentLabels[name]);
          // Found agents are either on (Ready, with the version found) or
          // installed and off; never Not installed.
          await expect(row).toContainText(
            new RegExp(`Version ${fakeProviderVersions[name].replace(/\./g, "\\.")}|Installed, off`),
          );
        }
      } finally {
        await app.close();
      }
    });
  }
});
