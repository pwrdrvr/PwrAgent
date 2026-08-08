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
 * Ask the app to quit, the same call the macOS Quit menu item makes.
 *
 * Deliberately not awaited for its result: a healthy quit tears the Playwright
 * connection down before the round trip resolves, and a quit that stops at the
 * confirmation prompt does not resolve either. Process exit is the signal.
 */
function requestQuit(electronApp: ElectronApplication): void {
  void electronApp
    .evaluate(({ app }) => {
      app.quit();
    })
    .catch(() => undefined);
}

/** Wait for real process exit, bounded by the product's own shutdown ceiling. */
async function awaitExit(
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
    requestQuit(app.electronApp);
    const outcome = await awaitExit(app.electronApp, captured);
    expect(outcome.exited, describeOutcome("profile-backed app", outcome)).toBe(
      true,
    );
    expect(outcome.signalCode).toBeNull();
  } finally {
    await app.close();
  }
});

/**
 * The path a real operator hits, and the one every other spec seeds away:
 * quit confirmation ON, with work running. The prompt's countdown is cancelled
 * for good by any deliberate keystroke — and an impatient second Cmd+Q *is*
 * that keystroke once the dialog has focus. From there the dialog is the only
 * thing that can settle the quit, so a repeat request has to reach it rather
 * than collapse silently onto the pending prompt.
 */
test("acknowledges a repeat quit request and exits once the prompt is answered", async () => {
  // Spawning a real login shell plus a second BrowserWindow outruns the default.
  test.setTimeout(120_000);

  const app = await launchElectronApp({
    fixturePath: path.resolve(specDir, "fixtures/smoke/replay.fixture.json"),
  });
  const captured = captureMainProcessOutput(app.electronApp);

  try {
    // The shared harness seeds confirmation OFF so specs close cleanly. This
    // spec is about the confirmation, so turn it back on the way the app does.
    await app.window.evaluate(async () => {
      await (
        window as unknown as {
          pwragent: {
            writeSettingsConfig: (request: unknown) => Promise<unknown>;
          };
        }
      ).pwragent.writeSettingsConfig({
        patch: { general: { confirmQuitWithInProgressThreads: true } },
      });
    });

    await app.window
      .getByRole("button", { name: /Replay smoke thread/i })
      .first()
      .click();
    await expect(
      app.window.getByRole("heading", { level: 2, name: "Replay smoke thread" }),
    ).toBeVisible();

    // An idle shell is not a quit blocker; a foreground command is.
    await app.window
      .getByRole("button", { name: "Open integrated terminal" })
      .click();
    await expect(
      app.window.getByLabel("Integrated terminal", { exact: true }),
    ).toBeVisible();
    await expect(app.window.locator(".integrated-terminal__status")).not.toHaveText(
      "Starting shell...",
    );
    await app.window.locator(".integrated-terminal__viewport").click();
    await app.window.keyboard.type("echo PWRAGENT_QUIT_BLOCKER_READY; sleep 120");
    await app.window.keyboard.press("Enter");
    await expect(
      app.window.locator(".integrated-terminal .xterm-rows"),
    ).toContainText("PWRAGENT_QUIT_BLOCKER_READY");

    const dialogPromise = app.electronApp.waitForEvent("window");
    requestQuit(app.electronApp);
    const dialog = await dialogPromise;
    await expect(
      dialog.getByRole("heading", { name: "Quit PwrAgent?" }),
    ).toBeVisible();

    // Stand in for the impatient operator's second Cmd+Q: a keystroke on the
    // dialog cancels the auto-quit permanently, so nothing but the dialog will
    // ever settle this request.
    await dialog.keyboard.press("ArrowDown");
    await expect
      .poll(async () => await dialog.locator("#countdown").innerText())
      .toBe("Auto-quit cancelled. Choose an option below.");

    requestQuit(app.electronApp);
    await expect
      .poll(() => captured())
      .toContain("quit requested while confirmation is open");
    // The repeat request raises the existing prompt; it must not stack a second
    // dialog on top of it.
    expect(
      app.electronApp.windows().filter((page) => page !== app.window).length,
    ).toBe(1);

    // Answering it has to actually reach process exit — the countdown is gone,
    // so this is the only remaining path out.
    await dialog.locator("#quit").dispatchEvent("click");
    const outcome = await awaitExit(app.electronApp, captured);
    expect(
      outcome.exited,
      describeOutcome("app with quit confirmation answered", outcome),
    ).toBe(true);
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
    requestQuit(app.electronApp);
    const outcome = await awaitExit(app.electronApp, captured);
    expect(outcome.exited, describeOutcome("first-run wizard app", outcome)).toBe(
      true,
    );
    expect(outcome.signalCode).toBeNull();
  } finally {
    await app.close();
  }
});
