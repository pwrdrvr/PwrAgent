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

test("keeps a per-thread integrated terminal alive while hidden", async () => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      integratedTerminalSpecDir,
      "fixtures/smoke/replay.fixture.json",
    ),
  });

  try {
    await openSmokeThread(app.window);
    await openIntegratedTerminal(app.window);

    await typeTerminalCommand(
      app.window,
      'node -e "setTimeout(() => console.log(\'PWRAGENT_TERMINAL_HIDDEN_DONE\'), 500)"',
    );
    await app.window.getByRole("button", { name: "Hide integrated terminal" }).click();
    await expect(app.window.getByLabel("Integrated terminal", { exact: true })).toBeHidden();

    // A collapsed-but-running shell advertises itself: the toggle changes its
    // label and wears a live dot, so the terminal can't go silently invisible.
    const showToggle = app.window.getByRole("button", {
      name: "Show running integrated terminal",
    });
    await expect(showToggle).toHaveClass(/is-running/);
    await showToggle.click();

    await expect(terminalRows(app.window)).toContainText(
      "PWRAGENT_TERMINAL_HIDDEN_DONE",
      { timeout: 10_000 },
    );
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

/**
 * Regression: `createOrAttach` used to un-hide the panel on every attach, on the
 * theory that the renderer only attaches when it is showing the pane. It isn't —
 * a pane is mounted (and therefore attaches) for every live session, collapsed
 * ones included. So a deliberate collapse was destroyed by the next remount, and
 * because every session gets a pane, one remount re-opened every collapsed
 * terminal in the app at once.
 */
test("keeps a collapsed terminal collapsed across a thread view unmount", async () => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      integratedTerminalSpecDir,
      "fixtures/smoke/replay.fixture.json",
    ),
  });

  try {
    await openSmokeThread(app.window);
    await openIntegratedTerminal(app.window);

    await app.window.getByRole("button", { name: "Hide integrated terminal" }).click();
    await expect(
      app.window.getByLabel("Integrated terminal", { exact: true }),
    ).toBeHidden();

    // Unmount ThreadView via the search screen, then come back.
    await app.window.getByRole("button", { name: "Search threads" }).click();
    await expect(
      app.window.getByRole("textbox", { name: "Search threads" }),
    ).toBeVisible();
    await openSmokeThread(app.window);

    // Still collapsed, still advertising the running shell.
    const showToggle = app.window.getByRole("button", {
      name: "Show running integrated terminal",
    });
    await expect(showToggle).toBeVisible();
    await expect(showToggle).toHaveClass(/is-running/);
    await expect(
      app.window.getByLabel("Integrated terminal", { exact: true }),
    ).toBeHidden();

    // And it still reattaches to the same live shell when asked.
    await showToggle.click();
    await expect(
      app.window.getByLabel("Integrated terminal", { exact: true }),
    ).toBeVisible();
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
