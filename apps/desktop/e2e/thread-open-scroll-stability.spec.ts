import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
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

async function distanceFromTranscriptBottom(locator: Locator) {
  return await locator.evaluate((element) => {
    const maxScrollTop = Math.max(element.scrollHeight - element.clientHeight, 0);
    return Math.round(maxScrollTop - element.scrollTop);
  });
}

async function readScrollMetrics(locator: Locator) {
  return await locator.evaluate((element) => ({
    distanceFromBottom: Math.round(
      Math.max(element.scrollHeight - element.clientHeight - element.scrollTop, 0)
    ),
    maxScrollTop: Math.round(
      Math.max(element.scrollHeight - element.clientHeight, 0)
    ),
    scrollTop: Math.round(element.scrollTop),
  }));
}

async function setTranscriptScrollTop(locator: Locator, targetScrollTop: number) {
  return await locator.evaluate((element, target) => {
    const rect = element.getBoundingClientRect();
    element.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        clientX: rect.right - 2,
        clientY: rect.top + 24,
      })
    );
    element.scrollTop = target;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));

    return {
      distanceFromBottom: Math.round(
        Math.max(element.scrollHeight - element.clientHeight - element.scrollTop, 0)
      ),
      scrollTop: Math.round(element.scrollTop),
    };
  }, targetScrollTop);
}

async function reselectLongThread(page: Page, transcript: Locator) {
  await page
    .getByRole("button", { name: /Short companion thread/i })
    .first()
    .click();
  await expect(
    page.getByRole("heading", {
      level: 2,
      name: "Short companion thread"
    })
  ).toBeVisible();
  await expect(
    transcript.getByText("Short companion thread message 2.")
  ).toBeVisible();

  await page
    .getByRole("button", { name: /Long scroll stability thread/i })
    .first()
    .click();
  await expect(
    page.getByRole("heading", {
      level: 2,
      name: "Long scroll stability thread"
    })
  ).toBeVisible();
  await expect(
    transcript.getByText("Long thread message 180: final transcript marker.")
  ).toBeVisible();
  await expect(
    transcript.getByText("Short companion thread message 2.")
  ).toHaveCount(0);
}

function expectStableSeries(values: number[], label: string) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  expect(
    max - min,
    `${label} drifted across samples: ${values.join(", ")}`
  ).toBeLessThanOrEqual(4);
}

test("opens a long transcript without drift and restores saved scroll positions on reselect", async () => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      specDir,
      "fixtures/long-thread-scroll-stability/replay.fixture.json"
    ),
    windowSize: {
      width: 1280,
      height: 720,
    },
  });

  try {
    const transcript = app.window.getByRole("region", { name: "Transcript" });
    const list = app.window.locator(".transcript-list__items");

    await test.step("open the long transcript at a stable bottom position", async () => {
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

      await expect
        .poll(async () =>
          await list.evaluate(
            (element) => element.scrollHeight > element.clientHeight + 2000
          )
        )
        .toBe(true);

      const initialMetrics = await readScrollMetrics(list);
      expect(initialMetrics.maxScrollTop).toBeGreaterThan(2000);
      expect(
        initialMetrics.maxScrollTop - initialMetrics.scrollTop
      ).toBeLessThanOrEqual(4);

      const initialSeries = await collectScrollSamples(list);
      expectStableSeries(initialSeries, "long-thread initial open");
    });

    await test.step("restore a saved middle viewport after reselect", async () => {
      const currentMetrics = await readScrollMetrics(list);
      const targetScrollTop = Math.max(
        320,
        Math.floor(currentMetrics.maxScrollTop / 3)
      );
      const savedViewport = await setTranscriptScrollTop(list, targetScrollTop);

      await expect
        .poll(async () => await list.evaluate((element) => Math.round(element.scrollTop)))
        .toBe(savedViewport.scrollTop);
      await reselectLongThread(app.window, transcript);

      const restoredSeries = await collectScrollSamples(list);
      expectStableSeries(restoredSeries, "long-thread middle viewport restore");

      const restoredMetrics = await readScrollMetrics(list);
      expect(
        Math.abs(restoredMetrics.scrollTop - savedViewport.scrollTop)
      ).toBeLessThanOrEqual(4);
      expect(
        Math.abs(
          restoredMetrics.distanceFromBottom - savedViewport.distanceFromBottom
        )
      ).toBeLessThanOrEqual(4);
      expect(restoredMetrics.scrollTop).toBeLessThan(
        restoredMetrics.maxScrollTop - 24
      );
    });

    await test.step("restore an exact scrollTop of zero after reselect", async () => {
      const savedViewport = await setTranscriptScrollTop(list, 0);
      expect(savedViewport.scrollTop).toBe(0);

      const savedSeries = await collectScrollSamples(list);
      expectStableSeries(savedSeries, "long-thread saved top viewport");
      expect(Math.max(...savedSeries)).toBeLessThanOrEqual(4);

      await reselectLongThread(app.window, transcript);

      const restoredSeries = await collectScrollSamples(list);
      expectStableSeries(restoredSeries, "long-thread top viewport restore");
      expect(Math.max(...restoredSeries)).toBeLessThanOrEqual(4);

      const restoredMetrics = await readScrollMetrics(list);
      expect(restoredMetrics.maxScrollTop).toBeGreaterThan(2000);
      expect(restoredMetrics.scrollTop).toBeLessThanOrEqual(4);
      expect(
        Math.abs(
          restoredMetrics.distanceFromBottom - savedViewport.distanceFromBottom
        )
      ).toBeLessThanOrEqual(4);
    });
  } finally {
    await app.close();
  }
});

test("keeps a bottom-pinned long transcript glued when a reply image preview resizes the composer", async () => {
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
    const jumpToLatest = app.window.getByRole("button", {
      name: "Jump to latest message",
    });

    await expect(
      transcript.getByText("Long thread message 180: final transcript marker.")
    ).toBeVisible();

    await expect
      .poll(async () =>
        await list.evaluate((element) =>
          Math.round(Math.max(element.scrollHeight - element.clientHeight, 0))
        )
      )
      .toBeGreaterThan(2000);

    await expect
      .poll(async () => await distanceFromTranscriptBottom(list))
      .toBeLessThanOrEqual(4);
    await expect(jumpToLatest).toHaveCount(0);

    await app.window
      .getByLabel("Reply")
      .fill("Here is the screenshot that explains it.");
    await app.window.evaluate(async () => {
      const textarea = document.querySelector<HTMLTextAreaElement>("#thread-composer");
      if (!textarea) {
        throw new Error("Reply textarea not found");
      }

      const canvas = document.createElement("canvas");
      canvas.width = 900;
      canvas.height = 500;
      const context = canvas.getContext("2d");
      if (!context) {
        throw new Error("Canvas context not available");
      }
      context.fillStyle = "#1f6f78";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "#ffffff";
      context.font = "48px sans-serif";
      context.fillText("composer resize regression", 64, 120);

      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((value) => {
          if (!value) {
            reject(new Error("Could not create pasted image blob"));
            return;
          }
          resolve(value);
        }, "image/png");
      });
      const file = new File([blob], "bottom-glue-regression.png", {
        type: "image/png",
      });
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      textarea.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: dataTransfer,
        })
      );
    });

    await expect(app.window.getByAltText("bottom-glue-regression.png")).toBeVisible();

    await expect
      .poll(async () => await distanceFromTranscriptBottom(list))
      .toBeLessThanOrEqual(4);
    await expect(jumpToLatest).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test("clicking jump-to-latest reaches the bottom in a single click", async () => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      specDir,
      "fixtures/long-thread-scroll-stability/replay.fixture.json"
    ),
    windowSize: {
      width: 1280,
      height: 720,
    },
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

    const list = app.window.locator(".transcript-list__items");
    const jumpToLatest = app.window.getByRole("button", {
      name: "Jump to latest message",
    });

    await expect
      .poll(async () =>
        await list.evaluate((element) =>
          Math.round(Math.max(element.scrollHeight - element.clientHeight, 0))
        )
      )
      .toBeGreaterThan(2000);

    await expect
      .poll(async () => await distanceFromTranscriptBottom(list))
      .toBeLessThanOrEqual(4);

    // Scroll well away from both edges so the jump-to-latest button is
    // exposed without crossing the near-top threshold that intentionally
    // starts loading an older history page.
    await list.evaluate((element) => {
      const maxScrollTop = Math.max(
        element.scrollHeight - element.clientHeight,
        0
      );
      element.scrollTop = Math.round(maxScrollTop / 2);
      element.dispatchEvent(new Event("scroll", { bubbles: true }));
    });

    await expect(jumpToLatest).toBeVisible();
    await expect
      .poll(async () => await distanceFromTranscriptBottom(list))
      .toBeGreaterThan(500);

    // A single click must take the user all the way to the bottom — not 90%,
    // then 95%, then 100% across three clicks. The window for the scroll to
    // settle is intentionally tight so smooth-scroll regressions that need
    // multiple clicks (or content growth that outraces a smooth-scroll
    // target captured at click time) fail the assertion.
    await jumpToLatest.click();

    await expect
      .poll(async () => await distanceFromTranscriptBottom(list), {
        timeout: 600,
      })
      .toBeLessThanOrEqual(4);
    await expect(jumpToLatest).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test("jump-to-latest re-enters glue mode so later content stays pinned", async () => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      specDir,
      "fixtures/long-thread-scroll-stability/replay.fixture.json"
    ),
    windowSize: {
      width: 1280,
      height: 720,
    },
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

    const list = app.window.locator(".transcript-list__items");
    const jumpToLatest = app.window.getByRole("button", {
      name: "Jump to latest message",
    });

    await expect
      .poll(async () => await distanceFromTranscriptBottom(list))
      .toBeLessThanOrEqual(4);

    // Scroll to the top, then click jump-to-latest to re-enter glue mode.
    await list.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await expect(jumpToLatest).toBeVisible();
    await jumpToLatest.click();

    // Wait for the scroll to settle and the button to hide.
    await expect
      .poll(async () => await distanceFromTranscriptBottom(list), {
        timeout: 600,
      })
      .toBeLessThanOrEqual(4);
    await expect(jumpToLatest).toHaveCount(0);

    // Simulate content growing after we re-glued (mimics images / code
    // blocks finishing their layout after the click landed). Glue should
    // keep us pinned to the new bottom; if a stale smooth-scroll target
    // left us unglued, we'd drift away from the bottom and the button
    // would reappear.
    await list.evaluate((element) => {
      const content = element.querySelector<HTMLDivElement>(
        ".transcript-list__content"
      );
      if (!content) {
        throw new Error("transcript content not found");
      }
      const spacer = document.createElement("div");
      spacer.style.height = "1200px";
      spacer.dataset.testid = "post-jump-growth-spacer";
      content.appendChild(spacer);
    });

    await expect
      .poll(async () => await distanceFromTranscriptBottom(list), {
        timeout: 1000,
      })
      .toBeLessThanOrEqual(4);
    await expect(jumpToLatest).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test("opens at the bottom and stays glued when content grows after first paint", async () => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      specDir,
      "fixtures/long-thread-scroll-stability/replay.fixture.json"
    ),
    windowSize: {
      width: 1280,
      height: 720,
    },
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

    const list = app.window.locator(".transcript-list__items");
    const jumpToLatest = app.window.getByRole("button", {
      name: "Jump to latest message",
    });

    await expect
      .poll(async () => await distanceFromTranscriptBottom(list))
      .toBeLessThanOrEqual(4);
    await expect(jumpToLatest).toHaveCount(0);

    // Simulate post-initial-paint layout growth (e.g. an image finishing
    // load, a code block finishing syntax highlighting). The transcript
    // should re-anchor to the new bottom — opening a thread should leave
    // the user looking at the latest message, not stranded above it.
    await list.evaluate((element) => {
      const content = element.querySelector<HTMLDivElement>(
        ".transcript-list__content"
      );
      if (!content) {
        throw new Error("transcript content not found");
      }
      const spacer = document.createElement("div");
      spacer.style.height = "1800px";
      spacer.dataset.testid = "post-open-growth-spacer";
      content.appendChild(spacer);
    });

    await expect
      .poll(async () => await distanceFromTranscriptBottom(list), {
        timeout: 1000,
      })
      .toBeLessThanOrEqual(4);
    await expect(jumpToLatest).toHaveCount(0);
  } finally {
    await app.close();
  }
});
