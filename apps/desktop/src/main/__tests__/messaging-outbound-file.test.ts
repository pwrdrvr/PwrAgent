import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveMessagingOutboundFile } from "../messaging/core/messaging-outbound-file";
import type {
  MessagingOutboundFileAccess,
  MessagingOutboundFileCapabilities,
  MessagingOutboundFileRequest,
} from "../messaging/core/messaging-outbound-file";

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

function resolveOutbound(
  request: MessagingOutboundFileRequest,
  capabilities: MessagingOutboundFileCapabilities,
  access: MessagingOutboundFileAccess,
) {
  return resolveMessagingOutboundFile(request, capabilities, access);
}

describe("resolveMessagingOutboundFile", () => {
  it("rejects a missing file", async () => {
    const tempDir = await createTempDir();
    await expect(
      resolveOutbound({
        path: path.join(tempDir, "missing.pdf"),
      }, { supportsFileUpload: true, maxUploadBytes: 1024 }, {
        allowedRoots: [tempDir],
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: "not_found",
    });
  });

  it("preserves a trailing space in the requested filename", async () => {
    const tempDir = await createTempDir();
    const spacedPath = path.join(tempDir, "resume.pdf ");
    await writeFile(spacedPath, Buffer.from("%PDF-1.4 spaced"));
    await expect(
      resolveOutbound({
        path: spacedPath,
      }, { supportsFileUpload: true }, {
        allowedRoots: [tempDir],
      }),
    ).resolves.toMatchObject({
      ok: true,
      path: expect.stringMatching(/resume\.pdf $/u),
    });
    await expect(
      resolveOutbound({
        path: path.join(tempDir, "resume.pdf"),
      }, { supportsFileUpload: true }, {
        allowedRoots: [tempDir],
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: "not_found",
    });
  });

  it("rejects a relative path", async () => {
    await expect(
      resolveOutbound({
        path: "relative/resume.pdf",
      }, { supportsFileUpload: true }, {
        allowedRoots: ["/tmp"],
      }),
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
      resolveOutbound({
        path: filePath,
      }, { supportsFileUpload: true, maxUploadBytes: 4 }, {
        allowedRoots: [tempDir],
      }),
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
      resolveOutbound({
        path: pdfPath,
      }, { supportsFileUpload: true, supportsImageUpload: true }, {
        allowedRoots: [tempDir],
      }),
    ).resolves.toMatchObject({
      ok: true,
      filename: "resume.pdf",
      mediaKind: "document",
      mimeType: "application/pdf",
    });
    await expect(
      resolveOutbound({
        path: pngPath,
      }, { supportsFileUpload: true, supportsImageUpload: true }, {
        allowedRoots: [tempDir],
      }),
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
      resolveOutbound({
        path: pngPath,
        mediaKind: "document",
        filename: "screenshot.png",
      }, { supportsFileUpload: true, supportsImageUpload: true }, {
        allowedRoots: [tempDir],
      }),
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
      resolveOutbound({
        path: pdfPath,
        mediaKind: "image",
      }, { supportsFileUpload: true, supportsImageUpload: true }, {
        allowedRoots: [tempDir],
      }),
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
      resolveOutbound({
        path: pngPath,
      }, { supportsFileUpload: true, supportsImageUpload: false }, {
        allowedRoots: [tempDir],
      }),
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
      resolveOutbound({
        path: pdfPath,
      }, { supportsFileUpload: false, supportsImageUpload: false }, {
        allowedRoots: [tempDir],
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: "unsupported_operation",
    });
  });

  it("refuses a file outside the allowed workspace roots", async () => {
    const allowed = await createTempDir();
    const outside = await createTempDir();
    const filePath = path.join(outside, "secret.pdf");
    await writeFile(filePath, Buffer.from("%PDF-1.4 secret"));
    await expect(
      resolveOutbound({
        path: filePath,
      }, { supportsFileUpload: true }, {
        allowedRoots: [allowed],
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: "forbidden",
      message: expect.stringContaining("workspace"),
    });
  });

  it("refuses a symlink that escapes into private storage", async () => {
    const allowed = await createTempDir();
    const privateRoot = await createTempDir();
    const hiddenPath = path.join(privateRoot, "sessions", "hidden.jsonl");
    const linkedPath = path.join(allowed, "notes.jsonl");
    await mkdir(path.dirname(hiddenPath), { recursive: true });
    await writeFile(hiddenPath, "private operator data\n");
    await symlink(hiddenPath, linkedPath);
    await expect(
      resolveOutbound({
        path: linkedPath,
      }, { supportsFileUpload: true }, {
        allowedRoots: [allowed],
        privateStorageRoots: [privateRoot],
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: "forbidden",
    });
  });

  it.skipIf(process.platform === "win32")(
    "maps an unreadable file to a tool error instead of throwing",
    async () => {
      const tempDir = await createTempDir();
      const filePath = path.join(tempDir, "locked.pdf");
      await writeFile(filePath, Buffer.from("%PDF-1.4 locked"));
      await chmod(filePath, 0);
      try {
        await expect(
          resolveOutbound({
            path: filePath,
          }, { supportsFileUpload: true }, {
            allowedRoots: [tempDir],
          }),
        ).resolves.toMatchObject({
          ok: false,
          code: "forbidden",
        });
      } finally {
        await chmod(filePath, 0o644);
      }
    },
  );
});
