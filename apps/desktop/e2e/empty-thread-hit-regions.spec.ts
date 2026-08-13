import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const specDir = path.dirname(fileURLToPath(import.meta.url));

test("keeps menus and Settings clickable over the empty thread pane", async () => {
  test.setTimeout(60_000);
  const app = await launchElectronApp({
    fixturePath: path.resolve(specDir, "fixtures/smoke/replay.fixture.json"),
  });

  try {
    await expect(
      app.window.getByRole("heading", { level: 2, name: "Replay smoke thread" }),
    ).toBeVisible();

    const mainBox = await app.window.locator(".app-main").boundingBox();
    if (!mainBox) {
      throw new Error("Expected the thread detail pane to have layout bounds");
    }
    // The smoke fixture auto-selects its only thread. Paint the production
    // empty-state drag region over the same rectangle so this test stays
    // focused on Electron's native hit map rather than federation setup.
    await app.window.evaluate(({ left }) => {
      const emptyPane = document.createElement("div");
      emptyPane.className = "thread-empty-state";
      emptyPane.setAttribute("aria-hidden", "true");
      Object.assign(emptyPane.style, {
        bottom: "0",
        left: `${left}px`,
        position: "fixed",
        right: "0",
        top: "0",
        zIndex: "0",
      });
      document.body.append(emptyPane);
    }, { left: mainBox.x });

    await app.window
      .getByRole("button", { name: "Replay smoke thread" })
      .hover();
    await app.window
      .getByRole("button", { name: "Open thread actions" })
      .click({ timeout: 5_000 });
    const copyThreadId = app.window.getByRole("menuitem", {
      name: "Copy Thread ID",
    });
    await expect(copyThreadId).toBeVisible();

    const menuItemBox = await copyThreadId.boundingBox();
    if (!menuItemBox) {
      throw new Error("Expected the thread menu item to have layout bounds");
    }
    expect(menuItemBox.x + menuItemBox.width / 2).toBeGreaterThan(mainBox.x);

    await copyThreadId.click({ timeout: 5_000 });
    await expect(copyThreadId).toHaveCount(0);

    await app.window
      .getByRole("button", { name: "Open settings" })
      .click({ timeout: 5_000 });
    await app.window
      .getByRole("button", { name: "Troubleshooting" })
      .click({ timeout: 5_000 });
    const developerMode = app.window.getByRole("switch", {
      name: "Developer Mode",
    });
    const initialDeveloperMode = await developerMode.getAttribute("aria-checked");
    expect(initialDeveloperMode === "true" || initialDeveloperMode === "false")
      .toBe(true);

    const settingsControlBox = await developerMode.boundingBox();
    if (!settingsControlBox) {
      throw new Error("Expected the Settings control to have layout bounds");
    }
    expect(settingsControlBox.x + settingsControlBox.width / 2).toBeGreaterThan(
      mainBox.x,
    );

    await developerMode.click({ timeout: 5_000 });
    await expect(developerMode).toHaveAttribute(
      "aria-checked",
      initialDeveloperMode === "true" ? "false" : "true",
    );
  } finally {
    await app.close();
  }
});
