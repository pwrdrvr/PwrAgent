import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

async function createComposerImageFixture(): Promise<{
  cleanup: () => Promise<void>;
  fixturePath: string;
}> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "pwragnt-composer-image-"));
  const fixturePath = path.join(rootDir, "composer-image-normalization.fixture.json");
  await mkdir(rootDir, { recursive: true });
  await writeFile(
    fixturePath,
    JSON.stringify(
      {
        metadata: {
          backend: "codex",
          scenario: "composer-image-normalization",
        },
        steps: [
          {
            id: "initialize-1",
            kind: "response",
            method: "initialize",
            result: {
              serverInfo: { name: "Replay Codex", version: "1.0.0" },
              methods: ["thread/list", "thread/read", "skills/list", "turn/start"],
            },
          },
          {
            id: "thread-list-1",
            kind: "response",
            method: "thread/list",
            result: [
              {
                id: "thread-image-normalization",
                title: "Image normalization",
                titleSource: "explicit",
                source: "codex",
                executionMode: "default",
                linkedDirectories: [],
                updatedAt: 1760000000001,
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
              entries: [],
              messages: [],
              pagination: {
                supportsPagination: false,
                hasPreviousPage: false,
              },
            },
          },
          {
            id: "turn-start-1",
            kind: "response",
            method: "turn/start",
            result: {
              threadId: "thread-image-normalization",
              runId: "turn-image-normalization",
            },
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );

  return {
    fixturePath,
    cleanup: async () => {
      await rm(rootDir, { recursive: true, force: true });
    },
  };
}

test("pasted WebP image is uploaded as bounded JPEG or PNG", async () => {
  const fixture = await createComposerImageFixture();
  const app = await launchElectronApp({ fixturePath: fixture.fixturePath });

  try {
    await app.window.getByRole("button", { name: "Image normalization" }).first().click();
    await expect(
      app.window.getByRole("heading", {
        level: 2,
        name: "Image normalization",
      }),
    ).toBeVisible();
    await app.window.getByLabel("Reply").waitFor();

    await app.window.evaluate(async () => {
      const textarea = document.querySelector<HTMLTextAreaElement>("#thread-composer");
      if (!textarea) {
        throw new Error("Reply textarea not found");
      }
      const canvas = document.createElement("canvas");
      canvas.width = 3000;
      canvas.height = 2000;
      const context = canvas.getContext("2d");
      if (!context) {
        throw new Error("Canvas context not available");
      }
      context.fillStyle = "#3478f6";
      context.fillRect(0, 0, 3000, 2000);
      context.fillStyle = "#ffffff";
      context.font = "120px sans-serif";
      context.fillText("large webp", 160, 220);
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((value) => {
          if (!value) {
            reject(new Error("Could not create WebP blob"));
            return;
          }
          resolve(value);
        }, "image/webp");
      });
      const file = new File([blob], "large.webp", { type: "image/webp" });
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      textarea.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: dataTransfer,
        }),
      );
    });

    await expect(app.window.getByAltText("large.webp")).toBeVisible();
    await app.window.getByLabel("Reply").fill("Describe the pasted image");
    await app.window.getByRole("button", { name: "Send" }).click();

    await expect.poll(async () => await app.getLastStartTurn()).not.toBeNull();
    const request = await app.getLastStartTurn();
    const imageItem = (request as { input: Array<{ type: string; url?: string }> }).input.find(
      (item) => item.type === "image",
    );
    const imageUrl = imageItem?.url;
    if (!imageUrl) {
      throw new Error("Expected turn/start payload to include an image data URL");
    }
    expect(imageUrl).toMatch(/^data:image\/(jpeg|png);base64,/);

    const dimensions = await app.window.evaluate(async (dataUrl) => {
      const image = new Image();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("Could not decode normalized upload"));
        image.src = dataUrl;
      });
      return {
        height: image.naturalHeight,
        width: image.naturalWidth,
      };
    }, imageUrl);
    expect(dimensions).toEqual({ width: 1536, height: 1024 });
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});
