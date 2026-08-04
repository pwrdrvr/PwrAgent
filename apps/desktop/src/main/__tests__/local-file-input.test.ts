import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  enrichLocalFileInputs,
  MAX_LOCAL_TEXT_FILE_BYTES,
  MAX_LOCAL_TEXT_PREVIEW_BYTES,
  MAX_TURN_LOCAL_TEXT_PREVIEW_BYTES,
} from "../app-server/local-file-input";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (root) => {
      await rm(root, { force: true, recursive: true });
    }),
  );
});

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-local-files-"));
  tempRoots.push(root);
  return root;
}

describe("enrichLocalFileInputs", () => {
  it("adds stat and inferred MIME metadata without reading large binary files", async () => {
    const root = await makeTempRoot();
    const isoPath = path.join(root, "windows-11.iso");
    const tiffPath = path.join(root, "large-scan.tiff");
    await writeFile(isoPath, "CD001-not-a-pdf");
    await writeFile(tiffPath, new Uint8Array([73, 73, 42, 0]));
    await truncate(tiffPath, 400 * 1024 * 1024);

    await expect(
      enrichLocalFileInputs([
        { type: "localFile", name: "windows-11.iso", path: isoPath },
        { type: "localFile", name: "large-scan.tiff", path: tiffPath },
      ]),
    ).resolves.toEqual([
      {
        type: "localFile",
        name: "windows-11.iso",
        path: isoPath,
        mimeType: "application/x-iso9660-image",
        sizeBytes: 15,
      },
      {
        type: "localFile",
        name: "large-scan.tiff",
        path: tiffPath,
        mimeType: "image/tiff",
        sizeBytes: 400 * 1024 * 1024,
      },
    ]);
  });

  it("includes a bounded preview for a validated small UTF-8 text file", async () => {
    const root = await makeTempRoot();
    const notesPath = path.join(root, "notes.md");
    const text = "# Notes\n\nInspect the attached ISO only if needed.\n";
    await writeFile(notesPath, text);

    await expect(
      enrichLocalFileInputs([
        { type: "localFile", name: "notes.md", path: notesPath },
      ]),
    ).resolves.toEqual([
      {
        type: "localFile",
        name: "notes.md",
        path: notesPath,
        mimeType: "text/markdown",
        sizeBytes: Buffer.byteLength(text),
        textPreview: text,
      },
    ]);
  });

  it("truncates previews independently from the small-file eligibility limit", async () => {
    const root = await makeTempRoot();
    const notesPath = path.join(root, "notes.txt");
    await writeFile(notesPath, "a".repeat(MAX_LOCAL_TEXT_PREVIEW_BYTES + 100));

    const [result] = await enrichLocalFileInputs([
      { type: "localFile", name: "notes.txt", path: notesPath },
    ]);

    expect(result).toMatchObject({
      mimeType: "text/plain",
      sizeBytes: MAX_LOCAL_TEXT_PREVIEW_BYTES + 100,
      textPreview: "a".repeat(MAX_LOCAL_TEXT_PREVIEW_BYTES),
      textPreviewTruncated: true,
    });
  });

  it("does not preview known text files above 10 KiB", async () => {
    const root = await makeTempRoot();
    const logPath = path.join(root, "large.log");
    await writeFile(logPath, "a".repeat(MAX_LOCAL_TEXT_FILE_BYTES + 1));

    await expect(
      enrichLocalFileInputs([
        { type: "localFile", name: "large.log", path: logPath },
      ]),
    ).resolves.toEqual([
      {
        type: "localFile",
        name: "large.log",
        path: logPath,
        mimeType: "text/plain",
        sizeBytes: MAX_LOCAL_TEXT_FILE_BYTES + 1,
      },
    ]);
  });

  it("does not preview invalid UTF-8 even when the extension is textual", async () => {
    const root = await makeTempRoot();
    const textPath = path.join(root, "not-really-text.txt");
    await writeFile(textPath, new Uint8Array([0xff, 0xfe, 0x00, 0x01]));

    await expect(
      enrichLocalFileInputs([
        { type: "localFile", name: "not-really-text.txt", path: textPath },
      ]),
    ).resolves.toEqual([
      {
        type: "localFile",
        name: "not-really-text.txt",
        path: textPath,
        mimeType: "text/plain",
        sizeBytes: 4,
      },
    ]);
  });

  it("caps the combined text preview budget for one turn", async () => {
    const root = await makeTempRoot();
    const paths = await Promise.all(
      Array.from({ length: 5 }, async (_, index) => {
        const filePath = path.join(root, `notes-${index}.txt`);
        await writeFile(filePath, String(index).repeat(MAX_LOCAL_TEXT_PREVIEW_BYTES));
        return filePath;
      }),
    );

    const results = await enrichLocalFileInputs(
      paths.map((filePath, index) => ({
        type: "localFile" as const,
        name: `notes-${index}.txt`,
        path: filePath,
      })),
    );

    expect(MAX_TURN_LOCAL_TEXT_PREVIEW_BYTES).toBe(
      4 * MAX_LOCAL_TEXT_PREVIEW_BYTES,
    );
    for (const result of results.slice(0, 4)) {
      expect(result).toEqual(
        expect.objectContaining({
          textPreview: expect.stringMatching(/^\d+$/u),
        }),
      );
      expect((result as { textPreview: string }).textPreview).toHaveLength(
        MAX_LOCAL_TEXT_PREVIEW_BYTES,
      );
    }
    expect(results[4]).not.toHaveProperty("textPreview");
  });
});
