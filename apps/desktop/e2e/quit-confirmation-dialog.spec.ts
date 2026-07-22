import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const specDir = path.dirname(fileURLToPath(import.meta.url));

async function openSmokeThread(page: Page) {
  await page
    .getByRole("button", { name: /Replay smoke thread/i })
    .first()
    .click();
  await expect(
    page.getByRole("heading", { level: 2, name: "Replay smoke thread" }),
  ).toBeVisible();
}

async function setQuitConfirmation(page: Page, enabled: boolean) {
  await page.evaluate(async (nextEnabled) => {
    await (
      window as unknown as {
        pwragent: {
          writeSettingsConfig: (request: unknown) => Promise<unknown>;
        };
      }
    ).pwragent.writeSettingsConfig({
      patch: { general: { confirmQuitWithInProgressThreads: nextEnabled } },
    });
  }, enabled);
}

async function openIntegratedTerminal(page: Page) {
  await page
    .getByRole("button", { name: "Open integrated terminal" })
    .click();
  await expect(
    page.getByLabel("Integrated terminal", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".integrated-terminal__status")).not.toHaveText(
    "Starting shell...",
  );
}

/**
 * The quit dialog is a standalone `data:` HTML window with no preload: it talks
 * to main by navigating to a fake scheme that `will-navigate` intercepts. That
 * makes it easy to break invisibly — a Content-Security-Policy, a stray
 * `preventDefault`, or a renamed action string all leave a dialog that renders
 * perfectly and whose controls do nothing. Nothing covered it, so drive it.
 *
 * Interactions go through `dispatchEvent` rather than `click()`/`hover()`:
 * Playwright's actionability hit-testing can't drive a frameless modal child
 * window, and times out. The events it dispatches are the ones the dialog's own
 * listeners are bound to, so the fake-scheme round trip is still exercised
 * end to end — which is the part that actually breaks.
 */
test("lists running terminals, cancels auto-quit, and stays open", async () => {
  // Spawning a real login shell, then standing up a second BrowserWindow, is
  // slower than the 30s default.
  test.setTimeout(90_000);

  const app = await launchElectronApp({
    fixturePath: path.resolve(specDir, "fixtures/smoke/replay.fixture.json"),
  });

  try {
    // The shared harness seeds quit confirmation OFF so specs can close cleanly
    // (and it does so after `preLaunchHook`). This spec is about the
    // confirmation, so turn it back on through the app's own settings IPC.
    await setQuitConfirmation(app.window, true);

    await openSmokeThread(app.window);

    // An idle shell is not a quit blocker. Start a foreground command so this
    // spec still exercises the dialog and its terminal-row navigation.
    await openIntegratedTerminal(app.window);
    await app.window.locator(".integrated-terminal__viewport").click();
    await app.window.keyboard.type("echo PWRAGENT_QUIT_BLOCKER_READY; sleep 60");
    await app.window.keyboard.press("Enter");
    await expect(
      app.window.locator(".integrated-terminal .xterm-rows"),
    ).toContainText("PWRAGENT_QUIT_BLOCKER_READY");

    const dialogPromise = app.electronApp.waitForEvent("window");
    // Not awaited: the modal holds the main process, so this round trip does
    // not resolve until the prompt is answered.
    void app.electronApp
      .evaluate(({ app: electronApp }) => {
        electronApp.quit();
      })
      .catch(() => undefined);
    const dialog = await dialogPromise;

    await expect(
      dialog.getByRole("heading", { name: "Quit PwrAgent?" }),
    ).toBeVisible();

    // Every blocker is a link, not merely a number. Read the DOM directly:
    // Playwright's locator hit-testing can't reach into this frameless modal.
    const rendered = await dialog.evaluate(() => ({
      summary: document.querySelector("main.content p")?.textContent ?? "",
      groups: [...document.querySelectorAll(".group")].map(
        (group) => group.textContent ?? "",
      ),
      rowCount: document.querySelectorAll("a.row").length,
      firstHref: document.querySelector("a.row")?.getAttribute("href") ?? "",
      countdown: document.getElementById("countdown")?.textContent ?? "",
    }));

    expect(rendered.summary).toBe("1 integrated terminal is running.");
    expect(rendered.groups).toEqual(["Integrated terminals"]);
    expect(rendered.rowCount).toBe(1);
    expect(rendered.firstHref).toMatch(/\/show-thread\/codex%3A.+\/terminal$/);

    // The countdown must still be RUNNING here. Things that merely LOOK like
    // engagement must not stop it: the Quit button's `autofocus` fires a
    // focusin, and the window appearing under a stationary cursor fires a
    // pointermove. Either would cancel the clock before anyone read a word,
    // leaving an unattended shutdown waiting forever for a human who isn't
    // there. Both used to.
    expect(rendered.countdown).toMatch(/^Auto-quitting in \d+ seconds?\.\.\.$/);

    // A deliberate interaction does stop it — and that signal has to reach main
    // through the fake scheme, which the CSP must not block.
    // A real keystroke: keyboard input doesn't need the hit-testing that
    // `click()`/`hover()` can't do on this window. ArrowDown is neither Escape
    // nor Enter, so it only trips the countdown cancel.
    await dialog.keyboard.press("ArrowDown");
    await expect
      .poll(async () => await dialog.locator("#countdown").innerText())
      .toBe("Auto-quit cancelled. Choose an option below.");

    // "Stay Open" has to actually reach main too. If the navigation were
    // blocked, the button would look fine and the app would die anyway.
    // `#stay`, not a role query: the titlebar close button is also labelled
    // "Stay open", so a by-name lookup is ambiguous.
    await dialog.locator("#stay").dispatchEvent("click");
    await dialog.waitForEvent("close");

    // Still alive, still on the thread, terminal still running.
    await expect(
      app.window.getByRole("heading", { level: 2, name: "Replay smoke thread" }),
    ).toBeVisible();
    await expect(
      app.window.getByLabel("Integrated terminal", { exact: true }),
    ).toBeVisible();
  } finally {
    // Disarm the confirmation before teardown. The terminal is still running,
    // so `app.close()` would trip the quit path again and hang on a second
    // dialog that nobody is there to answer.
    await setQuitConfirmation(app.window, false).catch(() => undefined);
    await app.close();
  }
});

test("does not confirm quit for a terminal sitting at its prompt", async () => {
  test.setTimeout(90_000);

  const app = await launchElectronApp({
    fixturePath: path.resolve(specDir, "fixtures/smoke/replay.fixture.json"),
  });

  try {
    await setQuitConfirmation(app.window, true);
    await openSmokeThread(app.window);
    await openIntegratedTerminal(app.window);

    const closedPromise = app.electronApp.waitForEvent("close").then(() => ({
      kind: "closed" as const,
    }));
    const dialogPromise = app.electronApp
      .waitForEvent("window")
      .then((dialog) => ({
        kind: "dialog" as const,
        dialog,
      }));
    void app.electronApp
      .evaluate(({ app: electronApp }) => {
        electronApp.quit();
      })
      .catch(() => undefined);

    const outcome = await Promise.race([closedPromise, dialogPromise]);
    if (outcome.kind === "dialog") {
      // Clean up a regressed run before surfacing the assertion failure.
      await outcome.dialog.locator("#quit").dispatchEvent("click");
      await closedPromise;
    }
    expect(outcome.kind).toBe("closed");
  } finally {
    await app.close().catch(() => undefined);
  }
});
