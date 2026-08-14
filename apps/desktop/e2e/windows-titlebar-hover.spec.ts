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
  } finally {
    await app.close();
  }
});
