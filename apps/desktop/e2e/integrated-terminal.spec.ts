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
  await page.getByTitle("Open integrated terminal").click();
  await expect(page.getByLabel("Integrated terminal")).toBeVisible();
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
    await app.window.getByTitle("Hide integrated terminal").click();
    await expect(app.window.getByLabel("Integrated terminal")).toHaveCount(0);

    await app.window.getByTitle("Open integrated terminal").click();

    await expect(terminalRows(app.window)).toContainText(
      "PWRAGENT_TERMINAL_HIDDEN_DONE",
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

    await expect(app.window.getByLabel("Integrated terminal")).toHaveCount(0, {
      timeout: 10_000,
    });
    await expect(app.window.getByTitle("Open integrated terminal")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  } finally {
    await app.close();
  }
});
