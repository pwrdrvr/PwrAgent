import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveMessagingOutboundFile } from "../messaging/core/messaging-outbound-file";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (tempDir) => {
      await rm(tempDir, { recursive: true, force: true });
    }),
  );
});

async function createTempDir(): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pwragent-outbound-file-"));
  tempDirs.push(tempDir);
  return tempDir;
}

describe("resolveMessagingOutboundFile", () => {
  it("rejects a missing file", async () => {
    const tempDir = await createTempDir();
    await expect(
      resolveMessagingOutboundFile({
        path: path.join(tempDir, "missing.pdf"),
      }, { supportsFileUpload: true, maxUploadBytes: 1024 }),
    ).resolves.toMatchObject({
      ok: false,
      code: "not_found",
    });
  });

  it("rejects a relative path", async () => {
    await expect(
      resolveMessagingOutboundFile({
        path: "relative/resume.pdf",
      }, { supportsFileUpload: true }),
    ).resolves.toMatchObject({
      ok: false,
      code: "invalid_arguments",
    });
  });

  it("rejects an oversized file before reading it as a document", async () => {
    const tempDir = await createTempDir();
    const filePath = path.join(tempDir, "resume.pdf");
    await writeFile(filePath, Buffer.from("%PDF-1.4 oversized"));
    await expect(
      resolveMessagingOutboundFile({
        path: filePath,
      }, { supportsFileUpload: true, maxUploadBytes: 4 }),
    ).resolves.toMatchObject({
      ok: false,
      code: "invalid_arguments",
      message: expect.stringContaining("upload limit of 4 bytes"),
    });
  });

  it("routes a PDF as a document and a PNG as an image", async () => {
    const tempDir = await createTempDir();
    const pdfPath = path.join(tempDir, "resume.pdf");
    const pngPath = path.join(tempDir, "shot.png");
    await writeFile(pdfPath, Buffer.from("%PDF-1.4 resume"));
    await writeFile(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    await expect(
      resolveMessagingOutboundFile({
        path: pdfPath,
      }, { supportsFileUpload: true, supportsImageUpload: true }),
    ).resolves.toMatchObject({
      ok: true,
      filename: "resume.pdf",
      mediaKind: "document",
      mimeType: "application/pdf",
    });
    await expect(
      resolveMessagingOutboundFile({
        path: pngPath,
      }, { supportsFileUpload: true, supportsImageUpload: true }),
    ).resolves.toMatchObject({
      ok: true,
      filename: "shot.png",
      mediaKind: "image",
      mimeType: "image/png",
    });
  });

  it("honors an explicit document hint for an image file", async () => {
    const tempDir = await createTempDir();
    const pngPath = path.join(tempDir, "shot.png");
    await writeFile(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    await expect(
      resolveMessagingOutboundFile({
        path: pngPath,
        mediaKind: "document",
        filename: "screenshot.png",
      }, { supportsFileUpload: true, supportsImageUpload: true }),
    ).resolves.toMatchObject({
      ok: true,
      filename: "screenshot.png",
      mediaKind: "document",
      mimeType: "image/png",
    });
  });

  it("rejects forcing image routing on a PDF", async () => {
    const tempDir = await createTempDir();
    const pdfPath = path.join(tempDir, "resume.pdf");
    await writeFile(pdfPath, Buffer.from("%PDF-1.4 resume"));
    await expect(
      resolveMessagingOutboundFile({
        path: pdfPath,
        mediaKind: "image",
      }, { supportsFileUpload: true, supportsImageUpload: true }),
    ).resolves.toMatchObject({
      ok: false,
      code: "invalid_arguments",
    });
  });

  it("falls back to a document when image upload is unsupported", async () => {
    const tempDir = await createTempDir();
    const pngPath = path.join(tempDir, "shot.png");
    await writeFile(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    await expect(
      resolveMessagingOutboundFile({
        path: pngPath,
      }, { supportsFileUpload: true, supportsImageUpload: false }),
    ).resolves.toMatchObject({
      ok: true,
      mediaKind: "document",
    });
  });

  it("returns unsupported_operation when the provider cannot send files", async () => {
    const tempDir = await createTempDir();
    const pdfPath = path.join(tempDir, "resume.pdf");
    await writeFile(pdfPath, Buffer.from("%PDF-1.4 resume"));
    await expect(
      resolveMessagingOutboundFile({
        path: pdfPath,
      }, { supportsFileUpload: false, supportsImageUpload: false }),
    ).resolves.toMatchObject({
      ok: false,
      code: "unsupported_operation",
    });
  });
});
