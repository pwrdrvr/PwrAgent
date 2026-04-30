import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const specDir = path.dirname(fileURLToPath(import.meta.url));
const STABILITY_SAMPLE_COUNT = 8;
const STABILITY_SAMPLE_INTERVAL_MS = 125;

async function collectScrollSamples(locator: Locator) {
  const values: number[] = [];

  for (let index = 0; index < STABILITY_SAMPLE_COUNT; index += 1) {
    values.push(
      await locator.evaluate((element) => Math.round(element.scrollTop))
    );

    if (index < STABILITY_SAMPLE_COUNT - 1) {
      await locator.page().waitForTimeout(STABILITY_SAMPLE_INTERVAL_MS);
    }
  }

  return values;
}

function expectStableSeries(values: number[], label: string) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  expect(
    max - min,
    `${label} drifted across samples: ${values.join(", ")}`
  ).toBeLessThanOrEqual(4);
}

test("opens a long transcript at the bottom without downward drift and restores saved scroll on reselect", async () => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      specDir,
      "fixtures/long-thread-scroll-stability/replay.fixture.json"
    ),
    windowSize: {
      width: 1280,
      height: 720,
    }
  });

  try {
    await app.window
      .getByRole("button", { name: /Long scroll stability thread/i })
      .first()
      .click();

    await expect(
      app.window.getByRole("heading", {
        level: 2,
        name: "Long scroll stability thread"
      })
    ).toBeVisible();

    const transcript = app.window.getByRole("region", { name: "Transcript" });
    const list = app.window.locator(".transcript-list__items");

    await expect(
      transcript.getByText("Long thread message 180: final transcript marker.")
    ).toBeVisible();

    await expect
      .poll(async () =>
        await list.evaluate(
          (element) => element.scrollHeight > element.clientHeight + 2000
        )
      )
      .toBe(true);

    const initialMetrics = await list.evaluate((element) => ({
      maxScrollTop: Math.round(
        Math.max(element.scrollHeight - element.clientHeight, 0)
      ),
      scrollTop: Math.round(element.scrollTop),
    }));

    expect(initialMetrics.maxScrollTop).toBeGreaterThan(2000);
    expect(initialMetrics.maxScrollTop - initialMetrics.scrollTop).toBeLessThanOrEqual(4);

    const initialSeries = await collectScrollSamples(list);
    expectStableSeries(initialSeries, "long-thread initial open");

    const savedViewport = await list.evaluate((element) => {
      const maxScrollTop = Math.max(element.scrollHeight - element.clientHeight, 0);
      const targetScrollTop = Math.max(320, Math.floor(maxScrollTop / 3));
      const rect = element.getBoundingClientRect();
      element.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          clientX: rect.right - 2,
          clientY: rect.top + 24,
        })
      );
      element.scrollTop = targetScrollTop;
      element.dispatchEvent(new Event("scroll", { bubbles: true }));
      return {
        distanceFromBottom: Math.round(
          Math.max(element.scrollHeight - element.clientHeight - element.scrollTop, 0)
        ),
        scrollTop: Math.round(element.scrollTop),
      };
    });

    await expect
      .poll(async () => await list.evaluate((element) => Math.round(element.scrollTop)))
      .toBe(savedViewport.scrollTop);

    await app.window
      .getByRole("button", { name: /Short companion thread/i })
      .first()
      .click();

    await expect(
      app.window.getByRole("heading", {
        level: 2,
        name: "Short companion thread"
      })
    ).toBeVisible();
    await expect(
      transcript.getByText("Short companion thread message 2.")
    ).toBeVisible();

    await app.window
      .getByRole("button", { name: /Long scroll stability thread/i })
      .first()
      .click();

    await expect(
      app.window.getByRole("heading", {
        level: 2,
        name: "Long scroll stability thread"
      })
    ).toBeVisible();
    await expect(
      transcript.getByText("Long thread message 180: final transcript marker.")
    ).toBeVisible();

    const restoredSeries = await collectScrollSamples(list);
    expectStableSeries(restoredSeries, "long-thread reselect restore");

    const restoredMetrics = await list.evaluate((element) => ({
      distanceFromBottom: Math.round(
        Math.max(element.scrollHeight - element.clientHeight - element.scrollTop, 0)
      ),
      maxScrollTop: Math.round(
        Math.max(element.scrollHeight - element.clientHeight, 0)
      ),
      scrollTop: Math.round(element.scrollTop),
    }));

    expect(Math.abs(restoredMetrics.scrollTop - savedViewport.scrollTop)).toBeLessThanOrEqual(4);
    expect(
      Math.abs(restoredMetrics.distanceFromBottom - savedViewport.distanceFromBottom)
    ).toBeLessThanOrEqual(4);
    expect(restoredMetrics.scrollTop).toBeLessThan(restoredMetrics.maxScrollTop - 24);
    await expect(
      transcript.getByText("Short companion thread message 2.")
    ).toHaveCount(0);
  } finally {
    await app.close();
  }
});
