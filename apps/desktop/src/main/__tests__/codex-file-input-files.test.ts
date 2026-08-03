import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { persistCodexFileInput } from "../codex-app-server/codex-file-input-files";

describe("Codex file input files", () => {
  it("content-addresses persisted files and preserves a safe attachment name", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pwragent-codex-files-"));
    const data = Buffer.from([1, 2, 3]);
    try {
      const first = await persistCodexFileInput(
        {
          type: "file",
          name: "../Jeep: sticker.pdf",
          mimeType: "application/pdf",
          data: data.toString("base64"),
          sizeBytes: data.byteLength,
        },
        { resolveRoot: () => tempDir },
      );
      const second = await persistCodexFileInput(
        {
          type: "file",
          name: "../Jeep: sticker.pdf",
          mimeType: "application/pdf",
          data: data.toString("base64"),
          sizeBytes: data.byteLength,
        },
        { resolveRoot: () => tempDir },
      );

      expect(first).toBe(
        path.join(
          tempDir,
          "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
          "Jeep_ sticker.pdf",
        ),
      );
      expect(second).toBe(first);
      await expect(readFile(first)).resolves.toEqual(data);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("prunes stale entries without removing the file persisted by this request", async () => {
    const root = "/tmp/pwragent-codex-attachments";
    const currentDigest =
      "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81";
    const removedPaths: string[] = [];
    const currentPath = path.join(root, currentDigest, "current.pdf");
    const stalePath = path.join(root, "old-thread");

    const result = await persistCodexFileInput(
      {
        type: "file",
        name: "current.pdf",
        mimeType: "application/pdf",
        data: Buffer.from([1, 2, 3]).toString("base64"),
        sizeBytes: 3,
      },
      {
        now: () => 10 * 24 * 60 * 60 * 1000,
        resolveRoot: () => root,
        mkdir: async () => undefined,
        writeFile: async () => undefined,
        readdir: async (dirPath) =>
          dirPath === root
            ? ["old-thread", currentDigest]
            : [],
        stat: async () => ({
          isFile: () => false,
          isDirectory: () => true,
          mtimeMs: 0,
        }),
        rm: async (filePath) => {
          removedPaths.push(filePath);
        },
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result).toBe(currentPath);
    expect(removedPaths).toEqual([stalePath]);
  });
});
