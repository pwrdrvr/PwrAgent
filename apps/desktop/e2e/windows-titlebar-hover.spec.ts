import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const specDir = path.dirname(fileURLToPath(import.meta.url));

test("keeps a Windows title-bar flyout open while the pointer crosses into it", async () => {
  test.skip(
    process.platform !== "win32",
    "The custom app title bar is rendered only on Windows.",
  );
  // The lab controller accepts Playwright arguments but deliberately exposes no
  // arbitrary environment-variable or command escape hatch. An explicit
  // `--timeout=0` therefore doubles as the manual-inspection signal: ordinary
  // suite runs retain their bounded timeout and self-close, while an operator
  // can keep this exact scene visible until Electron is closed.
  const inspectionMode = test.info().timeout === 0;

  const app = await launchElectronApp({
    fixturePath: path.resolve(
      specDir,
      "fixtures/smoke/replay.fixture.json",
    ),
  });

  try {
    const trigger = app.window.getByRole("button", { name: "New thread" });
    await trigger.hover();

    const menu = app.window.getByRole("menu", { name: "New thread options" });
    const item = menu.getByRole("menuitem", {
      name: "New chat without a directory",
    });
    await expect(item).toBeVisible();

    const [triggerBox, itemBox] = await Promise.all([
      trigger.boundingBox(),
      item.boundingBox(),
    ]);
    expect(triggerBox).not.toBeNull();
    expect(itemBox).not.toBeNull();
    if (!triggerBox || !itemBox) {
      throw new Error("The title-bar hover targets have no rendered bounds.");
    }

    const pointerX = triggerBox.x + triggerBox.width / 2;
    await app.window.mouse.move(
      pointerX,
      triggerBox.y + triggerBox.height - 1,
    );
    await app.window.mouse.move(
      pointerX,
      itemBox.y + itemBox.height / 2,
      { steps: 12 },
    );

    await expect(menu).toBeVisible();
    await expect(item).toBeVisible();
    await expect(app.window.locator(".new-thread-menu")).toHaveCSS(
      "-webkit-app-region",
      "no-drag",
    );

    if (inspectionMode) {
      console.log(
        [
          "",
          "Windows title-bar hover inspection is ready.",
          "The pointer crossed from New thread into the open flyout.",
          "Close the Electron window or quit the app to finish this command.",
          "",
        ].join("\n"),
      );
      await Promise.race([
        app.window.waitForEvent("close", { timeout: 0 }).then(() => undefined),
        app.electronApp.waitForEvent("close", { timeout: 0 }).then(() => undefined),
      ]);
    }
  } finally {
    if (inspectionMode) {
      await app.close().catch(() => undefined);
    } else {
      await app.close();
    }
  }
});
