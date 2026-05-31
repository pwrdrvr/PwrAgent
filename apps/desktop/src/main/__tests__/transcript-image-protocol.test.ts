import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const protocolHandleMock = vi.fn();
const protocolRegisterSchemesAsPrivilegedMock = vi.fn();

vi.mock("electron", () => ({
  protocol: {
    handle: protocolHandleMock,
    registerSchemesAsPrivileged: protocolRegisterSchemesAsPrivilegedMock,
  },
}));

describe("transcript image protocol", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pwragent-transcript-images-"));
    protocolHandleMock.mockReset();
    protocolRegisterSchemesAsPrivilegedMock.mockReset();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("registers a secure custom image protocol", async () => {
    const { registerTranscriptImageProtocolScheme } = await import(
      "../transcript-image-protocol"
    );

    registerTranscriptImageProtocolScheme();

    expect(protocolRegisterSchemesAsPrivilegedMock).toHaveBeenCalledWith([
      {
        scheme: "pwragent-image",
        privileges: {
          standard: true,
          secure: true,
          supportFetchAPI: true,
        },
      },
    ]);
  });

  it("resolves raster images from any PwrAgent profile under the configured root", async () => {
    const { resolveTranscriptImageProtocolRequest } = await import(
      "../transcript-image-protocol"
    );
    const pwragentHome = path.join(tempDir, "pwragent-home");
    const imagePath = path.join(
      pwragentHome,
      "profiles",
      "test-profile",
      "state",
      "image-inputs",
      "image.png"
    );
    await mkdir(path.dirname(imagePath), { recursive: true });
    await writeFile(imagePath, Buffer.from([1, 2, 3]));

    const result = await resolveTranscriptImageProtocolRequest(
      toProtocolUrl(imagePath),
      {
        env: { PWRAGENT_HOME: pwragentHome } as NodeJS.ProcessEnv,
        homeDir: path.join(tempDir, "home"),
      }
    );

    expect(result).toEqual({
      ok: true,
      path: await realpath(imagePath),
      mimeType: "image/png",
    });
  });

  it("rewrites file image URLs in thread/read responses before they reach the renderer", async () => {
    const { rewriteTranscriptImageUrlsForRenderer } = await import(
      "../transcript-image-protocol"
    );
    const fileUrl = "file:///Users/test/.pwragent/profiles/dev/state/image-inputs/image.png";
    const dataUrl = "data:image/png;base64,AQID";

    const response = rewriteTranscriptImageUrlsForRenderer({
      backend: "codex",
      fetchedAt: 1,
      threadId: "thread-images",
      replay: {
        entries: [
          {
            type: "message",
            id: "entry-1",
            role: "user",
            text: "what's in this?",
            parts: [
              { type: "text", text: "what's in this?" },
              { type: "image", url: fileUrl },
            ],
          },
        ],
        messages: [
          {
            id: "message-1",
            role: "user",
            text: "what's in this?",
            parts: [
              { type: "image", url: fileUrl },
              { type: "image", url: dataUrl },
            ],
          },
        ],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
      },
    });

    expect(response.replay.entries[0]).toMatchObject({
      parts: [
        { type: "text", text: "what's in this?" },
        { type: "image", url: `pwragent-image://file/${encodeURIComponent(fileUrl)}` },
      ],
    });
    expect(response.replay.messages[0]).toMatchObject({
      parts: [
        { type: "image", url: `pwragent-image://file/${encodeURIComponent(fileUrl)}` },
        { type: "image", url: dataUrl },
      ],
    });
  });

  it("resolves raster images from the default Codex home", async () => {
    const { resolveTranscriptImageProtocolRequest } = await import(
      "../transcript-image-protocol"
    );
    const homeDir = path.join(tempDir, "home");
    const imagePath = path.join(homeDir, ".codex", "sessions", "image.webp");
    await mkdir(path.dirname(imagePath), { recursive: true });
    await writeFile(imagePath, Buffer.from([1, 2, 3]));

    const result = await resolveTranscriptImageProtocolRequest(toProtocolUrl(imagePath), {
      env: {} as NodeJS.ProcessEnv,
      homeDir,
    });

    expect(result).toEqual({
      ok: true,
      path: await realpath(imagePath),
      mimeType: "image/webp",
    });
  });

  it("rejects non-image files under allowed roots", async () => {
    const { resolveTranscriptImageProtocolRequest } = await import(
      "../transcript-image-protocol"
    );
    const pwragentHome = path.join(tempDir, "pwragent-home");
    const textPath = path.join(pwragentHome, "profiles", "dev", "state.db");
    await mkdir(path.dirname(textPath), { recursive: true });
    await writeFile(textPath, "not an image");

    await expect(
      resolveTranscriptImageProtocolRequest(toProtocolUrl(textPath), {
        env: { PWRAGENT_HOME: pwragentHome } as NodeJS.ProcessEnv,
        homeDir: path.join(tempDir, "home"),
      })
    ).resolves.toMatchObject({
      ok: false,
      status: 415,
    });
  });

  it("rejects image files outside PwrAgent and Codex roots", async () => {
    const { resolveTranscriptImageProtocolRequest } = await import(
      "../transcript-image-protocol"
    );
    const imagePath = path.join(tempDir, "outside", "image.png");
    await mkdir(path.dirname(imagePath), { recursive: true });
    await writeFile(imagePath, Buffer.from([1, 2, 3]));

    await expect(
      resolveTranscriptImageProtocolRequest(toProtocolUrl(imagePath), {
        env: {} as NodeJS.ProcessEnv,
        homeDir: path.join(tempDir, "home"),
      })
    ).resolves.toMatchObject({
      ok: false,
      status: 403,
    });
  });
});

function toProtocolUrl(filePath: string): string {
  return `pwragent-image://file/${encodeURIComponent(pathToFileURL(filePath).toString())}`;
}
