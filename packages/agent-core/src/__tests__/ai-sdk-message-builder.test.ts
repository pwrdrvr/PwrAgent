import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildAiSdkMessages } from "../providers/ai-sdk-message-builder.js";

describe("buildAiSdkMessages", () => {
  it("builds multimodal messages with history and data URL images", async () => {
    await expect(
      buildAiSdkMessages({
        history: [
          { role: "user", text: "Earlier question" },
          { role: "assistant", text: "Earlier answer" },
        ],
        input: [
          { type: "text", text: "Describe this." },
          { type: "image", url: "data:image/png;base64,AQID" },
        ],
      }),
    ).resolves.toEqual([
      { role: "user", content: "Earlier question" },
      { role: "assistant", content: "Earlier answer" },
      {
        role: "user",
        content: [
          { type: "text", text: "Describe this." },
          {
            type: "image",
            image: new URL("data:image/png;base64,AQID"),
            mediaType: "image/png",
          },
        ],
      },
    ]);
  });

  it("reads local images as bytes and media type", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-sdk-message-"));
    const imagePath = path.join(tempDir, "image.jpg");
    await writeFile(imagePath, Buffer.from([9, 8, 7]));
    try {
      const messages = await buildAiSdkMessages({
        input: [
          { type: "text", text: "Describe this." },
          { type: "localImage", path: imagePath },
        ],
      });
      expect(messages).toEqual([
        {
          role: "user",
          content: [
            { type: "text", text: "Describe this." },
            {
              type: "image",
              image: Buffer.from([9, 8, 7]),
              mediaType: "image/jpeg",
            },
          ],
        },
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects file URLs because remote xAI cannot access them", async () => {
    await expect(
      buildAiSdkMessages({
        input: [{ type: "image", url: "file:///tmp/screenshot.png" }],
      }),
    ).rejects.toThrow("file:// image URLs are not accessible to xAI");
  });

  it("rejects unsupported local image types", async () => {
    await expect(
      buildAiSdkMessages({
        input: [{ type: "localImage", path: "/tmp/not-an-image.txt" }],
      }),
    ).rejects.toThrow("Unsupported local image type");
  });

  it("rejects image data URLs that are not JPEG or PNG", async () => {
    await expect(
      buildAiSdkMessages({
        input: [{ type: "image", url: "data:image/webp;base64,AQID" }],
      }),
    ).rejects.toThrow("normalized to image/jpeg or image/png");

    await expect(
      buildAiSdkMessages({
        input: [{ type: "image", url: "data:image/heic;base64,AQID" }],
      }),
    ).rejects.toThrow("normalized to image/jpeg or image/png");
  });

  it("rejects local images that are not JPEG or PNG", async () => {
    await expect(
      buildAiSdkMessages({
        input: [{ type: "localImage", path: "/tmp/image.webp" }],
      }),
    ).rejects.toThrow("normalize images to JPEG or PNG");

    await expect(
      buildAiSdkMessages({
        input: [{ type: "localImage", path: "/tmp/image.heic" }],
      }),
    ).rejects.toThrow("normalize images to JPEG or PNG");
  });
});
