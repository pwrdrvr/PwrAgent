import { mkdtemp, readFile, rm, writeFile as writeFileFs } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { materializeLocalImageInputs } from "../app-server/image-input-files";

describe("image input files", () => {
  it("materializes named PNG data URLs with the pasted filename in the local image path", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pwragent-image-inputs-"));
    const dataUrl = "data:image/png;base64,AQID";
    try {
      const first = await materializeLocalImageInputs(
        [
          { type: "text", text: "Describe it" },
          { type: "image", name: "original-paste.png", url: dataUrl },
        ],
        { resolveRoot: () => tempDir },
      );
      const second = await materializeLocalImageInputs(
        [{ type: "image", url: dataUrl }],
        { resolveRoot: () => tempDir },
      );

      expect(first[0]).toEqual({ type: "text", text: "Describe it" });
      expect(first[1]).toMatchObject({ type: "localImage", name: "original-paste.png" });
      const imagePath = first[1]?.type === "localImage" ? first[1].path : "";
      expect(imagePath).toBe(
        path.join(
          tempDir,
          "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
          "original-paste.png",
        ),
      );
      expect(second[0]).toEqual({
        type: "localImage",
        path: path.join(
          tempDir,
          "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81.png",
        ),
      });
      await expect(readFile(imagePath)).resolves.toEqual(Buffer.from([1, 2, 3]));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("leaves unsupported image URLs untouched", async () => {
    const result = await materializeLocalImageInputs(
      [
        { type: "image", url: "data:image/gif;base64,R0lGODlh" },
        { type: "image", url: "https://example.test/image.png" },
      ],
      { resolveRoot: () => "/tmp/unused-pwragent-image-inputs" },
    );

    expect(result).toEqual([
      { type: "image", url: "data:image/gif;base64,R0lGODlh" },
      { type: "image", url: "https://example.test/image.png" },
    ]);
  });

  it("converts file URLs for supported local image paths", async () => {
    const result = await materializeLocalImageInputs([
      { type: "image", name: "friendly screenshot.jpg", url: "file:///tmp/screenshot%20one.jpg" },
    ]);

    expect(result).toEqual([
      { type: "localImage", name: "friendly screenshot.jpg", path: "/tmp/screenshot one.jpg" },
    ]);
  });

  it("does not delete a reused stale cached image while materializing it", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pwragent-image-inputs-"));
    const unlinkedPaths: string[] = [];
    try {
      const [materialized] = await materializeLocalImageInputs(
        [{ type: "image", url: "data:image/png;base64,AQID" }],
        { resolveRoot: () => tempDir },
      );
      const imagePath = materialized?.type === "localImage" ? materialized.path : "";
      await writeFileFs(imagePath, Buffer.from([9, 9, 9]));

      const [reused] = await materializeLocalImageInputs(
        [{ type: "image", url: "data:image/png;base64,AQID" }],
        {
          now: () => 10 * 24 * 60 * 60 * 1000,
          readdir: async () => [path.basename(imagePath)],
          resolveRoot: () => tempDir,
          stat: async () => ({
            isFile: () => true,
            mtimeMs: 0,
          }),
          unlink: async (filePath) => {
            unlinkedPaths.push(String(filePath));
          },
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(reused).toEqual({ type: "localImage", path: imagePath });
      expect(unlinkedPaths).not.toContain(imagePath);
      await expect(readFile(imagePath)).resolves.toEqual(Buffer.from([1, 2, 3]));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
