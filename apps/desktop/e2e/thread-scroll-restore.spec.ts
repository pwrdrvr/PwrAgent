import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const specDir = path.dirname(fileURLToPath(import.meta.url));

test("restores the saved transcript viewport when reselecting a cached thread", async () => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      specDir,
      "fixtures/thread-scroll-restore/replay.fixture.json"
    ),
    windowSize: {
      width: 1280,
      height: 640,
    }
  });

  try {
    await app.window
      .getByRole("button", { name: /First scroll replay thread/i })
      .first()
      .click();

    await expect(
      app.window.getByRole("heading", {
        level: 2,
        name: "First scroll replay thread"
      })
    ).toBeVisible();

    const transcript = app.window.getByRole("region", { name: "Transcript" });
    const list = transcript.getByRole("list");

    await expect(
      transcript.getByText("First thread message 20: cached transcript remains stable.")
    ).toBeVisible();

    await expect
      .poll(async () =>
        await list.evaluate((element) => element.scrollHeight > element.clientHeight)
      )
      .toBe(true);

    await list.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event("scroll", { bubbles: true }));
    });

    await expect
      .poll(async () => await list.evaluate((element) => Math.round(element.scrollTop)))
      .toBeLessThanOrEqual(4);

    const savedViewport = await list.evaluate((element) => ({
      distanceFromBottom: Math.round(
        Math.max(element.scrollHeight - element.clientHeight - element.scrollTop, 0)
      ),
      scrollTop: Math.round(element.scrollTop),
    }));

    await app.window
      .getByRole("button", { name: /Second scroll replay thread/i })
      .first()
      .click();

    await expect(
      app.window.getByRole("heading", {
        level: 2,
        name: "Second scroll replay thread"
      })
    ).toBeVisible();
    await expect(
      transcript.getByText("Second thread message 2: switching away should not wipe cache.")
    ).toBeVisible();

    await app.window
      .getByRole("button", { name: /First scroll replay thread/i })
      .first()
      .click();

    await expect(
      app.window.getByRole("heading", {
        level: 2,
        name: "First scroll replay thread"
      })
    ).toBeVisible();
    await expect(
      transcript.getByText("First thread message 20: cached transcript remains stable.")
    ).toBeVisible();

    await expect
      .poll(async () => await list.evaluate((element) => Math.round(element.scrollTop)))
      .toBeGreaterThanOrEqual(savedViewport.scrollTop - 4);

    const scrollMetrics = await list.evaluate((element) => ({
      distanceFromBottom: Math.round(
        Math.max(element.scrollHeight - element.clientHeight - element.scrollTop, 0)
      ),
      maxScrollTop: Math.round(
        Math.max(element.scrollHeight - element.clientHeight, 0)
      ),
      scrollTop: Math.round(element.scrollTop),
    }));

    expect(scrollMetrics.maxScrollTop).toBeGreaterThan(24);
    expect(Math.abs(scrollMetrics.scrollTop - savedViewport.scrollTop)).toBeLessThanOrEqual(4);
    expect(
      Math.abs(scrollMetrics.distanceFromBottom - savedViewport.distanceFromBottom)
    ).toBeLessThanOrEqual(4);
    expect(savedViewport.distanceFromBottom).toBeGreaterThan(24);
    expect(scrollMetrics.scrollTop).toBeLessThan(scrollMetrics.maxScrollTop - 24);
    await expect(
      transcript.getByText("Second thread message 2: switching away should not wipe cache.")
    ).toHaveCount(0);
  } finally {
    await app.close();
  }
});
