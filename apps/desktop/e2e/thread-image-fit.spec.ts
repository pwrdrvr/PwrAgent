import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
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

async function createThreadImageFitFixture(): Promise<{
  cleanup: () => Promise<void>;
  fixturePath: string;
}> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "pwragnt-thread-image-fit-"));
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
                  text: "Small pasted image should not be enlarged.",
                  parts: [
                    {
                      type: "text",
                      text: "Small pasted image should not be enlarged.",
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
                  text: "Small pasted image should not be enlarged.",
                  parts: [
                    {
                      type: "text",
                      text: "Small pasted image should not be enlarged.",
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

test("fits wide pasted transcript images without cropping", async () => {
  const fixture = await createThreadImageFitFixture();
  const app = await launchElectronApp({
    fixturePath: fixture.fixturePath,
    windowSize: {
      width: 1280,
      height: 720,
    },
  });

  try {
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

    const image = app.window.getByAltText("Thread rename focus screenshot");
    await expect(image).toBeVisible();

    const metrics = await image.evaluate((element) => {
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

    const naturalRatio = metrics.naturalWidth / metrics.naturalHeight;
    const renderedRatio = metrics.renderedWidth / metrics.renderedHeight;

    expect(metrics.naturalWidth).toBe(848);
    expect(metrics.naturalHeight).toBe(372);
    expect(Math.abs(renderedRatio - naturalRatio)).toBeLessThan(0.05);
    expect(metrics.renderedWidth).toBeLessThanOrEqual(metrics.buttonWidth);
    expect(metrics.renderedHeight).toBeLessThanOrEqual(metrics.buttonHeight);
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});

test("keeps small pasted transcript images at intrinsic size", async () => {
  const fixture = await createThreadImageFitFixture();
  const app = await launchElectronApp({
    fixturePath: fixture.fixturePath,
    windowSize: {
      width: 1280,
      height: 720,
    },
  });

  try {
    await app.window
      .getByRole("button", { name: /Fix Composer Auto Saves/i })
      .first()
      .click();

    const image = app.window.getByAltText("Small intrinsic screenshot");
    await expect(image).toBeVisible();

    const metrics = await image.evaluate((element) => {
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

    expect(metrics.naturalWidth).toBe(80);
    expect(metrics.naturalHeight).toBe(40);
    expect(metrics.renderedWidth).toBeCloseTo(80, 0);
    expect(metrics.renderedHeight).toBeCloseTo(40, 0);
    expect(metrics.buttonWidth).toBeLessThanOrEqual(100);
    expect(metrics.buttonHeight).toBeLessThanOrEqual(60);
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});

test("keeps tiny pasted transcript image buttons easy to hit", async () => {
  const fixture = await createThreadImageFitFixture();
  const app = await launchElectronApp({
    fixturePath: fixture.fixturePath,
    windowSize: {
      width: 1280,
      height: 720,
    },
  });

  try {
    await app.window
      .getByRole("button", { name: /Fix Composer Auto Saves/i })
      .first()
      .click();

    const image = app.window.getByAltText("Tiny intrinsic screenshot");
    await expect(image).toBeVisible();

    const metrics = await image.evaluate((element) => {
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

    expect(metrics.naturalWidth).toBe(12);
    expect(metrics.naturalHeight).toBe(8);
    expect(metrics.renderedWidth).toBeCloseTo(12, 0);
    expect(metrics.renderedHeight).toBeCloseTo(8, 0);
    expect(metrics.buttonWidth).toBeGreaterThanOrEqual(44);
    expect(metrics.buttonHeight).toBeGreaterThanOrEqual(44);
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});
