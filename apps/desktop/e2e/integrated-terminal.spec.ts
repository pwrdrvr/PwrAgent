import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const integratedTerminalSpecDir = path.dirname(fileURLToPath(import.meta.url));

async function openSmokeThread(page: Page) {
  await page
    .getByRole("button", { name: /Replay smoke thread/i })
    .first()
    .click();
  await expect(
    page.getByRole("heading", {
      level: 2,
      name: "Replay smoke thread",
    }),
  ).toBeVisible();
}

async function openIntegratedTerminal(page: Page) {
  await page.getByRole("button", { name: "Open integrated terminal" }).click();
  await expect(page.getByLabel("Integrated terminal", { exact: true })).toBeVisible();
  await expect(page.locator(".integrated-terminal .xterm")).toBeVisible();
  await expect(page.locator(".integrated-terminal__status")).not.toHaveText(
    "Starting shell...",
  );
}

async function typeTerminalCommand(page: Page, command: string) {
  await page.locator(".integrated-terminal__viewport").click();
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
}

function terminalRows(page: Page) {
  return page.locator(".integrated-terminal .xterm-rows");
}

/**
 * Regression coverage for two collapsed-session failures: delayed output must
 * remain buffered while the pane is hidden, and createOrAttach must not expand
 * a deliberately collapsed pane when ThreadView remounts.
 */
test("keeps a hidden terminal alive and collapsed across a thread view remount", async () => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      integratedTerminalSpecDir,
      "fixtures/smoke/replay.fixture.json",
    ),
  });

  try {
    await test.step("start delayed output and hide the running terminal", async () => {
      await openSmokeThread(app.window);
      await openIntegratedTerminal(app.window);

      await typeTerminalCommand(
        app.window,
        'node -e "setTimeout(() => console.log(\'PWRAGENT_TERMINAL_HIDDEN_DONE\'), 500)"',
      );
      await app.window
        .getByRole("button", { name: "Hide integrated terminal" })
        .click();
      await expect(
        app.window.getByLabel("Integrated terminal", { exact: true })
      ).toBeHidden();

      // A collapsed-but-running shell advertises itself: the toggle changes
      // its label and wears a live dot, so it cannot go silently invisible.
      await expect(
        app.window.getByRole("button", {
          name: "Show running integrated terminal",
        })
      ).toHaveClass(/is-running/);
    });

    await test.step("remount ThreadView without expanding the terminal", async () => {
      await app.window.getByRole("button", { name: "Search threads" }).click();
      await expect(
        app.window.getByRole("textbox", { name: "Search threads" })
      ).toBeVisible();
      await expect(
        app.window.getByLabel("Integrated terminal", { exact: true })
      ).toHaveCount(0);

      await openSmokeThread(app.window);

      const showToggle = app.window.getByRole("button", {
        name: "Show running integrated terminal",
      });
      await expect(showToggle).toBeVisible();
      await expect(showToggle).toHaveClass(/is-running/);
      await expect(
        app.window.getByLabel("Integrated terminal", { exact: true })
      ).toBeHidden();
    });

    await test.step("show the retained pane and replay its delayed output", async () => {
      await app.window
        .getByRole("button", { name: "Show running integrated terminal" })
        .click();
      await expect(
        app.window.getByLabel("Integrated terminal", { exact: true })
      ).toBeVisible();
      await expect(terminalRows(app.window)).toContainText(
        "PWRAGENT_TERMINAL_HIDDEN_DONE",
        { timeout: 10_000 },
      );
    });
  } finally {
    await app.close();
  }
});

/**
 * Regression: terminal state used to live in ThreadView's `useState`. Opening
 * the search screen unmounts ThreadView, which wiped the renderer's memory of
 * every terminal while the main process happily kept the PTYs running — the
 * shells were still alive, but nothing in the UI could reach them again. Main
 * owns the registry now, so a remount has to rediscover the live session and
 * reattach to it, scrollback and all.
 */
test("recovers a running terminal after the thread view unmounts", async () => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      integratedTerminalSpecDir,
      "fixtures/smoke/replay.fixture.json",
    ),
  });

  try {
    await openSmokeThread(app.window);
    await openIntegratedTerminal(app.window);

    await typeTerminalCommand(app.window, "echo PWRAGENT_TERMINAL_SURVIVES");
    await expect(terminalRows(app.window)).toContainText(
      "PWRAGENT_TERMINAL_SURVIVES",
      { timeout: 10_000 },
    );

    // Unmount ThreadView by switching to the search screen, then come back.
    await app.window.getByRole("button", { name: "Search threads" }).click();
    await expect(
      app.window.getByRole("textbox", { name: "Search threads" }),
    ).toBeVisible();
    await expect(
      app.window.getByLabel("Integrated terminal", { exact: true }),
    ).toHaveCount(0);

    await openSmokeThread(app.window);

    // The pane comes back on its own — no click — because main still has the
    // session, and it replays the scrollback buffer on reattach.
    await expect(
      app.window.getByLabel("Integrated terminal", { exact: true }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(terminalRows(app.window)).toContainText(
      "PWRAGENT_TERMINAL_SURVIVES",
      { timeout: 10_000 },
    );
  } finally {
    await app.close();
  }
});

test("removes the integrated terminal pane when the shell exits", async () => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      integratedTerminalSpecDir,
      "fixtures/smoke/replay.fixture.json",
    ),
  });

  try {
    await openSmokeThread(app.window);
    await openIntegratedTerminal(app.window);

    await typeTerminalCommand(app.window, "echo PWRAGENT_TERMINAL_EXIT_READY");
    await expect(terminalRows(app.window)).toContainText(
      "PWRAGENT_TERMINAL_EXIT_READY",
      { timeout: 10_000 },
    );
    await typeTerminalCommand(app.window, "exit");

    await expect(app.window.getByLabel("Integrated terminal", { exact: true })).toHaveCount(0, {
      timeout: 10_000,
    });
    await expect(app.window.getByRole("button", { name: "Open integrated terminal" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  } finally {
    await app.close();
  }
});
