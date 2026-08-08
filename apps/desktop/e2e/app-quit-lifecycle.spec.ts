import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type ElectronApplication } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

/**
 * Quit-path gate.
 *
 * `closeElectronApplication` force-kills the process tree when a graceful
 * close doesn't land, which means a product quit path that never reaches
 * process exit looks green in every other spec. These tests remove that
 * cover: they ask the app to quit exactly the way a user does (`app.quit()`,
 * the same call the macOS Quit menu item and Playwright's own
 * `electronApp.close()` make) and assert the process actually exits.
 *
 * The wizard case is called out separately because it boots into a different
 * app-state mode (`bootstrap`) with no profile on disk, so nothing about the
 * profile-backed path proves it.
 */

const specDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * The product's own shutdown ceiling: renderer window close
 * (`RENDERER_WINDOW_SHUTDOWN_TIMEOUT_MS`, 2s) plus the main-process shutdown
 * barrier (`MAIN_PROCESS_SHUTDOWN_TIMEOUT_MS`, 12s), plus slack for a loaded
 * VM. Every phase inside those is individually bounded, so a run that blows
 * this budget is a quit path that never completes, not a slow one.
 */
const QUIT_BUDGET_MS = 20_000;

type QuitOutcome = {
  elapsedMs: number;
  exited: boolean;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  output: string;
};

/**
 * Ask the app to quit and wait for real process exit.
 *
 * The `evaluate` call is deliberately not awaited for its result: a healthy
 * quit tears the Playwright connection down before the round trip resolves,
 * so the reply is not a signal either way. Process exit is.
 */
async function quitAndAwaitExit(
  electronApp: ElectronApplication,
  captured: () => string,
): Promise<QuitOutcome> {
  const child = electronApp.process();
  const startedAt = Date.now();
  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once("exit", () => resolve());
  });

  void electronApp
    .evaluate(({ app }) => {
      app.quit();
    })
    .catch(() => undefined);

  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    exited,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, QUIT_BUDGET_MS);
    }),
  ]);
  if (timer !== undefined) {
    clearTimeout(timer);
  }

  return {
    elapsedMs: Date.now() - startedAt,
    exited: child.exitCode !== null || child.signalCode !== null,
    exitCode: child.exitCode,
    signalCode: child.signalCode,
    output: captured(),
  };
}

/**
 * Mirror the main process's console transport into a buffer. electron-log
 * keeps its console transport enabled outside Vitest, so every `mainLog` line
 * the quit path emits ("quit in progress", "shutdown barrier completed", …)
 * shows up here — which is what turns a failure into a diagnosis instead of a
 * timeout.
 */
function captureMainProcessOutput(electronApp: ElectronApplication): () => string {
  const chunks: string[] = [];
  const child = electronApp.process();
  child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
  return () => chunks.join("");
}

function describeOutcome(label: string, outcome: QuitOutcome): string {
  return [
    `${label} did not exit within ${QUIT_BUDGET_MS}ms after app.quit().`,
    `elapsedMs=${outcome.elapsedMs} exitCode=${String(outcome.exitCode)} signal=${String(outcome.signalCode)}`,
    "--- main process output ---",
    outcome.output.slice(-16_000),
  ].join("\n");
}

test("exits the process when a profile-backed session is asked to quit", async () => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(specDir, "fixtures/smoke/replay.fixture.json"),
  });
  const captured = captureMainProcessOutput(app.electronApp);

  try {
    const outcome = await quitAndAwaitExit(app.electronApp, captured);
    expect(outcome.exited, describeOutcome("profile-backed app", outcome)).toBe(
      true,
    );
    expect(outcome.signalCode).toBeNull();
  } finally {
    await app.close();
  }
});

test("exits the process when the first-run wizard is asked to quit", async () => {
  // No profile dir, no onboarding seed: the boot decision resolves to
  // `no-profile-configured` and app state comes up in bootstrap mode with the
  // wizard on screen — the state that hung a full E2E run for an hour.
  const app = await launchElectronApp({
    suppressOnboarding: false,
    requiresReplayDriver: false,
  });
  const captured = captureMainProcessOutput(app.electronApp);

  try {
    await expect(
      app.window.getByRole("heading", { name: /A few short choices/i }),
    ).toBeVisible();
    const outcome = await quitAndAwaitExit(app.electronApp, captured);
    expect(outcome.exited, describeOutcome("first-run wizard app", outcome)).toBe(
      true,
    );
    expect(outcome.signalCode).toBeNull();
  } finally {
    await app.close();
  }
});
