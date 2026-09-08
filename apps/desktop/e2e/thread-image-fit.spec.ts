import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const specDir = path.dirname(fileURLToPath(import.meta.url));
const fixtureImagePath = path.resolve(
  specDir,
  "fixtures/thread-image-fit/thread-image.png"
);

function createSvgImageDataUrl(params: {
  color: string;
  height: number;
  label: string;
  width: number;
}): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${params.width}" height="${params.height}" viewBox="0 0 ${params.width} ${params.height}"><rect width="100%" height="100%" fill="${params.color}"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="#ffffff" font-family="sans-serif" font-size="${Math.max(6, Math.min(params.height / 2, 18))}">${params.label}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

async function createThreadImageFitFixture(scrollProbe = false): Promise<{
  cleanup: () => Promise<void>;
  fixturePath: string;
}> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "pwragent-thread-image-fit-"));
  const fixturePath = path.join(rootDir, "thread-image-fit.fixture.json");
  const imageBuffer = await readFile(fixtureImagePath);
  const imageUrl = `data:image/png;base64,${imageBuffer.toString("base64")}`;
  const smallImageUrl = createSvgImageDataUrl({
    color: "#2b6cb0",
    height: 40,
    label: "small",
    width: 80,
  });
  const tinyImageUrl = createSvgImageDataUrl({
    color: "#7c2d12",
    height: 8,
    label: "tiny",
    width: 12,
  });

  const secondMessageText = scrollProbe
    ? Array.from({ length: 60 }, (_, index) => `Scroll probe paragraph ${index + 1}.`).join("\n\n")
    : "Small pasted image should not be enlarged.";
  const offscreenImage = scrollProbe
    ? [{ type: "image", url: imageUrl, alt: "Offscreen scroll probe" }]
    : [];

  await mkdir(rootDir, { recursive: true });
  await writeFile(
    fixturePath,
    JSON.stringify(
      {
        metadata: {
          backend: "codex",
          scenario: "thread-image-fit",
          threadId: "019dd46b-1e50-7463-ab57-0a454b9c31a1",
        },
        steps: [
          {
            id: "initialize-1",
            kind: "response",
            method: "initialize",
            result: {
              serverInfo: { name: "Replay Codex", version: "1.0.0" },
              methods: ["thread/list", "thread/read", "skills/list"],
            },
          },
          {
            id: "thread-list-1",
            kind: "response",
            method: "thread/list",
            result: [
              {
                id: "019dd46b-1e50-7463-ab57-0a454b9c31a1",
                title: "Fix Composer Auto Saves",
                titleSource: "explicit",
                source: "codex",
                executionMode: "default",
                linkedDirectories: [],
                updatedAt: 1777386113422,
              },
            ],
          },
          {
            id: "skills-list-1",
            kind: "response",
            method: "skills/list",
            result: [],
          },
          {
            id: "thread-read-1",
            kind: "response",
            method: "thread/read",
            result: {
              entries: [
                {
                  type: "message",
                  id: "message-image-fit-1",
                  role: "user",
                  text: "Add this: when renaming a thread, the popup should have the text selected by default with focus in the text entry.",
                  parts: [
                    {
                      type: "text",
                      text: "Add this: when renaming a thread, the popup should have the text selected by default with focus in the text entry.",
                    },
                    {
                      type: "image",
                      url: imageUrl,
                      alt: "Thread rename focus screenshot",
                    },
                  ],
                },
                {
                  type: "message",
                  id: "message-image-fit-2",
                  role: "user",
                  text: secondMessageText,
                  parts: [
                    ...offscreenImage,
                    {
                      type: "text",
                      text: secondMessageText,
                    },
                    {
                      type: "image",
                      url: smallImageUrl,
                      alt: "Small intrinsic screenshot",
                    },
                    {
                      type: "image",
                      url: tinyImageUrl,
                      alt: "Tiny intrinsic screenshot",
                    },
                  ],
                },
              ],
              messages: [
                {
                  id: "message-image-fit-1",
                  role: "user",
                  text: "Add this: when renaming a thread, the popup should have the text selected by default with focus in the text entry.",
                  parts: [
                    {
                      type: "text",
                      text: "Add this: when renaming a thread, the popup should have the text selected by default with focus in the text entry.",
                    },
                    {
                      type: "image",
                      url: imageUrl,
                      alt: "Thread rename focus screenshot",
                    },
                  ],
                },
                {
                  id: "message-image-fit-2",
                  role: "user",
                  text: secondMessageText,
                  parts: [
                    ...offscreenImage,
                    {
                      type: "text",
                      text: secondMessageText,
                    },
                    {
                      type: "image",
                      url: smallImageUrl,
                      alt: "Small intrinsic screenshot",
                    },
                    {
                      type: "image",
                      url: tinyImageUrl,
                      alt: "Tiny intrinsic screenshot",
                    },
                  ],
                },
              ],
              lastUserMessage: "Add this: when renaming a thread, the popup should have the text selected by default with focus in the text entry.",
              pagination: {
                supportsPagination: false,
                hasPreviousPage: false,
              },
            },
          },
        ],
      },
      null,
      2
    ),
    "utf8"
  );

  return {
    fixturePath,
    cleanup: async () => {
      await rm(rootDir, { recursive: true, force: true });
    },
  };
}

async function readImageMetrics(image: Locator) {
  return await image.evaluate((element) => {
    const img = element as HTMLImageElement;
    const rect = img.getBoundingClientRect();
    const buttonRect = img
      .closest(".transcript-message__image-button")
      ?.getBoundingClientRect();

    return {
      buttonHeight: buttonRect?.height ?? 0,
      buttonWidth: buttonRect?.width ?? 0,
      naturalHeight: img.naturalHeight,
      naturalWidth: img.naturalWidth,
      renderedHeight: rect.height,
      renderedWidth: rect.width,
    };
  });
}

test("fits wide, small, and tiny pasted transcript images", async () => {
  const fixture = await createThreadImageFitFixture();
  const app = await launchElectronApp({
    fixturePath: fixture.fixturePath,
    windowSize: {
      width: 1280,
      height: 720,
    },
  });

  try {
    await test.step("open the replay-backed image thread", async () => {
      await app.window
        .getByRole("button", { name: /Fix Composer Auto Saves/i })
        .first()
        .click();

      await expect(
        app.window.getByRole("heading", {
          level: 2,
          name: "Fix Composer Auto Saves",
        })
      ).toBeVisible();
    });

    await test.step("fit the wide image without cropping", async () => {
      const image = app.window.getByAltText("Thread rename focus screenshot");
      await expect(image).toBeVisible();

      const metrics = await readImageMetrics(image);
      const naturalRatio = metrics.naturalWidth / metrics.naturalHeight;
      const renderedRatio = metrics.renderedWidth / metrics.renderedHeight;

      expect(metrics.naturalWidth).toBe(848);
      expect(metrics.naturalHeight).toBe(372);
      expect(Math.abs(renderedRatio - naturalRatio)).toBeLessThan(0.05);
      expect(metrics.renderedWidth).toBeLessThanOrEqual(metrics.buttonWidth);
      expect(metrics.renderedHeight).toBeLessThanOrEqual(metrics.buttonHeight);
    });

    await test.step("keep the small image at intrinsic size", async () => {
      const image = app.window.getByAltText("Small intrinsic screenshot");
      await expect(image).toBeVisible();

      const metrics = await readImageMetrics(image);
      expect(metrics.naturalWidth).toBe(80);
      expect(metrics.naturalHeight).toBe(40);
      expect(metrics.renderedWidth).toBeCloseTo(80, 0);
      expect(metrics.renderedHeight).toBeCloseTo(40, 0);
      expect(metrics.buttonWidth).toBeLessThanOrEqual(100);
      expect(metrics.buttonHeight).toBeLessThanOrEqual(60);
    });

    await test.step("keep the tiny image intrinsic with an accessible hit target", async () => {
      const image = app.window.getByAltText("Tiny intrinsic screenshot");
      await expect(image).toBeVisible();

      const metrics = await readImageMetrics(image);
      expect(metrics.naturalWidth).toBe(12);
      expect(metrics.naturalHeight).toBe(8);
      expect(metrics.renderedWidth).toBeCloseTo(12, 0);
      expect(metrics.renderedHeight).toBeCloseTo(8, 0);
      expect(metrics.buttonWidth).toBeGreaterThanOrEqual(44);
      expect(metrics.buttonHeight).toBeGreaterThanOrEqual(44);
    });
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});

test("loads an offscreen transcript image only after scrolling it into view", async () => {
  const fixture = await createThreadImageFitFixture(true);
  const app = await launchElectronApp({
    fixturePath: fixture.fixturePath,
    windowSize: { width: 1280, height: 720 },
  });

  try {
    await app.window.getByRole("button", { name: /Fix Composer Auto Saves/i }).first().click();
    const bottomImage = app.window.getByAltText("Tiny intrinsic screenshot");
    await expect.poll(async () => (await readImageMetrics(bottomImage)).naturalWidth).toBe(12);

    const offscreenImage = app.window.getByAltText("Offscreen scroll probe");
    await expect(offscreenImage).toBeAttached();
    await expect(offscreenImage).not.toBeInViewport();
    expect(await offscreenImage.getAttribute("src")).toBeNull();
    expect((await readImageMetrics(offscreenImage)).naturalWidth).toBe(0);

    await offscreenImage.scrollIntoViewIfNeeded();
    await expect(offscreenImage).toBeInViewport();
    await expect.poll(async () => (await readImageMetrics(offscreenImage)).naturalWidth).toBe(848);
    await expect(offscreenImage).toHaveAttribute("src", /^pwragent-image:/);
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});

// Contrived mixed media, held active until both real browser decodes complete.
// This distinguishes missing parts from lazy images without a source or box.
test("shows GIF and PNG thumbnails before turn completion and keeps them after refresh", async () => {
  const fixture = await createThreadImageFitFixture();
  const script = JSON.parse(await readFile(fixture.fixturePath, "utf8"));
  const read = script.steps.find((step: { method: string }) => step.method === "thread/read");
  const threadId = script.metadata.threadId;
  const png = read.result.entries[0].parts[1];
  const parts = [
    { type: "text", text: "Inspect both attachments" },
    { type: "image", url: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", alt: "Mixed GIF" },
    { ...png, alt: "Mixed PNG" },
  ];
  const entry = { type: "message", id: "mixed-input", role: "user", text: "Inspect both attachments", parts,
    turn: { id: "mixed-turn", status: "inProgress" } };
  read.result = { entries: [entry], messages: [entry], pagination: { supportsPagination: false, hasPreviousPage: false } };
  // The mixed fixture does not exercise skill discovery; an unconsumed
  // optional response must not block manual turn notifications.
  script.steps = script.steps.filter((step: { method?: string }) => step.method !== "skills/list");
  script.steps.push(
    { id: "mixed-start", kind: "notification", notification: { method: "turn/started", params: { threadId, turn: { id: "mixed-turn", status: "inProgress" } } } },
    { id: "mixed-complete", kind: "notification", notification: { method: "turn/completed", params: { threadId, turnId: "mixed-turn", turn: { id: "mixed-turn", status: "completed", output: [] } } } },
  );
  await writeFile(fixture.fixturePath, JSON.stringify(script));
  const app = await launchElectronApp({ fixturePath: fixture.fixturePath, windowSize: { width: 1280, height: 900 } });
  try {
    await app.window.getByRole("button", { name: /Fix Composer Auto Saves/i }).first().click();
    await expect(app.window.getByAltText("Mixed PNG", { exact: true })).toBeVisible();
    await app.advance({ stepId: "mixed-start" });
    await expect(app.window.getByTestId("composer-stop-turn")).toBeVisible();
    const verify = async () => {
      for (const alt of ["Mixed GIF", "Mixed PNG"]) {
        const image = app.window.getByAltText(alt, { exact: true });
        await expect(image).toBeVisible();
        await expect.poll(() => image.evaluate((element) => {
          const img = element as HTMLImageElement;
          const rect = img.getBoundingClientRect();
          return Boolean(img.src && img.complete && img.naturalWidth > 0 && rect.width > 0 && rect.height > 0);
        })).toBe(true);
      }
    };
    await verify();
    await app.advance({ stepId: "mixed-complete" });
    await expect(app.window.getByTestId("composer-stop-turn")).toHaveCount(0);
    await verify();
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});
