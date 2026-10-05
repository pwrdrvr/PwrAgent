import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
    vi.unstubAllEnvs();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("promotes legacy image references and resolves them after the shared source is removed", async () => {
    vi.stubEnv("PWRAGENT_HOME", tempDir);
    vi.stubEnv("PWRAGENT_PROFILE", "test");
    const { materializeTranscriptImageUrlsForRenderer } = await import("../transcript-image-protocol");
    const bytes = Buffer.from([1, 2, 3]);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const legacyPath = path.join(tempDir, "profiles", "test", "state", "turn-input-attachments", digest, "image.png");
    await mkdir(path.dirname(legacyPath), { recursive: true });
    await writeFile(legacyPath, bytes);
    const input = {
      backend: "codex" as const, threadId: "legacy-thread", fetchedAt: 0,
      replay: {
        entries: [],
        messages: [{ id: "legacy", role: "user" as const, text: "Image", parts: [{ type: "image" as const, url: toProtocolUrl(legacyPath) }] }],
        pagination: { supportsPagination: false, hasPreviousPage: false },
      },
    };
    const first = await materializeTranscriptImageUrlsForRenderer(input);
    const part = first.replay.messages[0]?.parts?.[0];
    if (part?.type !== "image") throw new Error("Expected retained image.");
    const ownedPath = filePathFromProtocolUrl(part.url);
    expect(ownedPath).toContain(path.join("thread-assets", "codex", "legacy-thread"));
    await expect(readFile(ownedPath)).resolves.toEqual(bytes);
    await rm(legacyPath);
    const second = await materializeTranscriptImageUrlsForRenderer(input);
    expect(second.replay.messages[0]?.parts).toEqual(first.replay.messages[0]?.parts);
  });

  it("does no retention work for images already owned by the displayed thread", async () => {
    vi.stubEnv("PWRAGENT_HOME", tempDir);
    vi.stubEnv("PWRAGENT_PROFILE", "test");
    const { materializeTranscriptImageUrlsForRenderer } = await import("../transcript-image-protocol");
    const retainLocalImage = vi.fn(async () => { throw new Error("Unexpected retention work"); });
    const url = pathToFileURL(path.join(tempDir, "profiles", "test", "state", "thread-assets", "codex", "fast-thread", "digest", "image.png")).toString();
    const input = {
      backend: "codex" as const, threadId: "fast-thread", fetchedAt: 0,
      replay: {
        entries: [],
        messages: [{ id: "owned", role: "user" as const, text: "Image", parts: [{ type: "image" as const, url }] }],
        pagination: { supportsPagination: false, hasPreviousPage: false },
      },
    };
    await materializeTranscriptImageUrlsForRenderer(input, { retainLocalImage });
    await materializeTranscriptImageUrlsForRenderer(input, { retainLocalImage });
    expect(retainLocalImage).not.toHaveBeenCalled();
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

  it("reads approved cached and direct-file SVG bytes for the renderer", async () => {
    const { readTranscriptImageForRenderer } = await import(
      "../transcript-image-protocol"
    );
    const pwragentHome = path.join(tempDir, "pwragent-home");
    const homeDir = path.join(tempDir, "home");
    const imagePath = path.join(
      pwragentHome, "profiles", "dev", "state", "thread-images", "codex", "thread", "graph.svg",
    );
    const directFilePath = path.join(homeDir, ".codex", "worktrees", "image.svg");
    const unrelatedPath = path.join(tempDir, "other.svg");
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
    await mkdir(path.dirname(imagePath), { recursive: true });
    await mkdir(path.dirname(directFilePath), { recursive: true });
    await writeFile(imagePath, svg);
    await writeFile(directFilePath, svg);
    await writeFile(unrelatedPath, svg);
    const options = {
      env: { PWRAGENT_HOME: pwragentHome } as NodeJS.ProcessEnv,
      homeDir,
    };

    await expect(readTranscriptImageForRenderer(toProtocolUrl(imagePath), options))
      .resolves.toEqual({ dataBase64: svg.toString("base64"), mimeType: "image/svg+xml" });
    await expect(readTranscriptImageForRenderer(toProtocolUrl(directFilePath), options))
      .resolves.toEqual({ dataBase64: svg.toString("base64"), mimeType: "image/svg+xml" });
    await expect(readTranscriptImageForRenderer(toProtocolUrl(unrelatedPath), options))
      .rejects.toThrow("transcript image path is not allowed");
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

  it("rewrites owner-local image URLs into lazy federation protocol URLs", async () => {
    const {
      rewriteFederatedTranscriptImageUrlsForRenderer,
      toFederatedTranscriptImageProtocolUrl,
    } = await import("../transcript-image-protocol");
    const ownerUrl = toProtocolUrl(
      "/Users/owner/.pwragent/profiles/default/state/image-inputs/image.png",
    );
    const signedPwrSnapUrl =
      "http://127.0.0.1:51729/media?grant=read-once-grant&signature=valid-signature";

    const response = rewriteFederatedTranscriptImageUrlsForRenderer({
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
              { type: "image", url: ownerUrl },
              { type: "image", url: signedPwrSnapUrl },
            ],
          },
        ],
        messages: [
          {
            id: "message-1",
            role: "user",
            text: "what's in this?",
            parts: [
              { type: "image", url: ownerUrl },
              { type: "image", url: signedPwrSnapUrl },
            ],
          },
        ],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
      },
    }, "owner_one");

    const expectedUrl = toFederatedTranscriptImageProtocolUrl(
      "owner_one",
      ownerUrl,
    );
    const expectedPwrSnapUrl = toFederatedTranscriptImageProtocolUrl(
      "owner_one",
      signedPwrSnapUrl,
    );
    expect(response.replay.entries[0]).toMatchObject({
      parts: [
        { type: "image", url: expectedUrl },
        { type: "image", url: expectedPwrSnapUrl },
      ],
    });
    expect(response.replay.messages[0]).toMatchObject({
      parts: [
        { type: "image", url: expectedUrl },
        { type: "image", url: expectedPwrSnapUrl },
      ],
    });
  });

  it("serves federation protocol URLs through the remote image resolver", async () => {
    const {
      installTranscriptImageProtocol,
      toFederatedTranscriptImageProtocolUrl,
    } = await import("../transcript-image-protocol");
    const ownerUrl = toProtocolUrl(
      "/Users/owner/.pwragent/profiles/default/state/image-inputs/image.png",
    );
    const resolveFederatedImage = vi.fn(async () => ({
      dataBase64: Buffer.from([1, 2, 3]).toString("base64"),
      mimeType: "image/png",
    }));

    installTranscriptImageProtocol({ resolveFederatedImage });
    const handler = protocolHandleMock.mock.calls[0]?.[1] as (
      request: { url: string },
    ) => Promise<Response>;
    const response = await handler({
      url: toFederatedTranscriptImageProtocolUrl("owner_one", ownerUrl),
    });

    expect(resolveFederatedImage).toHaveBeenCalledWith({
      instanceId: "owner_one",
      url: ownerUrl,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );

    const signedPwrSnapUrl =
      "http://127.0.0.1:51729/media?grant=read-once-grant&signature=valid-signature";
    resolveFederatedImage.mockClear();
    await handler({
      url: toFederatedTranscriptImageProtocolUrl(
        "owner_one",
        signedPwrSnapUrl,
      ),
    });
    expect(resolveFederatedImage).toHaveBeenCalledWith({
      instanceId: "owner_one",
      url: signedPwrSnapUrl,
    });
  });

  it("serves SVG images with a restrictive content policy", async () => {
    const {
      installTranscriptImageProtocol,
      toFederatedTranscriptImageProtocolUrl,
    } = await import("../transcript-image-protocol");
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>');
    installTranscriptImageProtocol({
      resolveFederatedImage: async () => ({
        dataBase64: svg.toString("base64"),
        mimeType: "image/svg+xml",
      }),
    });
    const handler = protocolHandleMock.mock.calls[0]?.[1] as (
      request: { url: string },
    ) => Promise<Response>;
    const response = await handler({
      url: toFederatedTranscriptImageProtocolUrl("owner", toProtocolUrl("/image.svg")),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    );
    expect(Buffer.from(await response.arrayBuffer())).toEqual(svg);
  });

  it("materializes data image URLs into thread-scoped files before renderer IPC", async () => {
    const { materializeTranscriptImageUrlsForRenderer } = await import(
      "../transcript-image-protocol"
    );
    const dataUrl = "data:image/png;base64,AQID";
    const writes: string[] = [];

    const response = await materializeTranscriptImageUrlsForRenderer(
      {
        backend: "codex",
        fetchedAt: 1,
        threadId: "codex:thread/images",
        replay: {
          entries: [
            { type: "activity", id: "tool", summary: "Screenshot", details: [
              { id: "image", kind: "read", label: "Screenshot", images: [{ type: "image", url: dataUrl }] },
            ] },
            {
              type: "message",
              id: "entry-1",
              role: "user",
              text: "what's in this?",
              parts: [
                { type: "text", text: "what's in this?" },
                { type: "image", url: dataUrl },
              ],
            },
          ],
          messages: [
            {
              id: "message-1",
              role: "user",
              text: "what's in this?",
              parts: [{ type: "image", url: dataUrl }],
            },
          ],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      },
      {
        resolveRoot: ({ backend, threadId }) =>
          path.join(
            tempDir,
            "thread-images",
            backend,
            encodeURIComponent(threadId),
          ),
        writeFile: async (filePath, data) => {
          writes.push(filePath);
          await writeFile(filePath, data);
        },
      }
    );

    const entryPart = response.replay.entries[1]?.type === "message"
      ? response.replay.entries[1].parts?.[1]
      : undefined;
    const messagePart = response.replay.messages[0]?.parts?.[0];
    expect(entryPart).toMatchObject({
      type: "image",
      url: expect.stringMatching(/^pwragent-image:\/\/file\//),
    });
    expect(messagePart).toEqual(entryPart);
    expect(response.replay.entries[0]?.type === "activity"
      ? response.replay.entries[0].details[0]?.images?.[0] : undefined).toEqual(entryPart);
    expect(JSON.stringify(response)).not.toContain("data:image/");
    const { rewriteFederatedTranscriptImageUrlsForRenderer } = await import("../transcript-image-protocol");
    const remote = rewriteFederatedTranscriptImageUrlsForRenderer(response, "owner");
    expect(remote.replay.entries[0]?.type === "activity"
      ? remote.replay.entries[0].details[0]?.images?.[0]?.url : undefined).toMatch(/^pwragent-image:\/\/federation\/owner\//);
    expect(writes).toHaveLength(1);
    const materializedPath =
      entryPart?.type === "image" ? filePathFromProtocolUrl(entryPart.url) : "";
    expect(materializedPath).toContain(
      path.join("thread-images", "codex", "codex%3Athread%2Fimages")
    );
    expect(path.basename(materializedPath)).toMatch(/^[a-f0-9]{64}\.png$/);
    await expect(readFile(materializedPath)).resolves.toEqual(Buffer.from([1, 2, 3]));
  });

  it("materializes signed PwrSnap loopback images into thread-scoped files", async () => {
    const { materializeTranscriptImageUrlsForRenderer } = await import(
      "../transcript-image-protocol"
    );
    const signedUrl =
      "http://127.0.0.1:51729/media?grant=read-once-grant&signature=valid-signature";
    const bytes = new Uint8Array([4, 5, 6]);
    const fetch = vi.fn(async () => ({
      ok: true,
      headers: {
        get: (name: string) => {
          if (name === "content-type") {
            return "image/jpeg";
          }
          if (name === "content-length") {
            return String(bytes.byteLength);
          }
          return null;
        },
      },
      arrayBuffer: async () => bytes.buffer,
    }));

    const response = await materializeTranscriptImageUrlsForRenderer(
      {
        backend: "codex",
        fetchedAt: 1,
        threadId: "codex:thread/signed-image",
        replay: {
          entries: [
            {
              type: "message",
              id: "entry-1",
              role: "assistant",
              text: "Shown.",
              parts: [
                { type: "text", text: "Shown." },
                { type: "image", url: signedUrl },
              ],
            },
          ],
          messages: [
            {
              id: "message-1",
              role: "assistant",
              text: "Shown.",
              parts: [{ type: "image", url: signedUrl }],
            },
          ],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      },
      {
        fetch,
        resolveRoot: () => path.join(tempDir, "thread-images"),
      }
    );

    const entryPart = response.replay.entries[0]?.type === "message"
      ? response.replay.entries[0].parts?.[1]
      : undefined;
    const messagePart = response.replay.messages[0]?.parts?.[0];
    expect(entryPart).toMatchObject({
      type: "image",
      url: expect.stringMatching(/^pwragent-image:\/\/file\//),
    });
    expect(messagePart).toEqual(entryPart);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      signedUrl,
      expect.objectContaining({
        redirect: "error",
        signal: expect.any(AbortSignal),
      }),
    );
    const materializedPath =
      entryPart?.type === "image" ? filePathFromProtocolUrl(entryPart.url) : "";
    expect(path.basename(materializedPath)).toMatch(/^[a-f0-9]{64}\.jpg$/);
    await expect(readFile(materializedPath)).resolves.toEqual(Buffer.from([4, 5, 6]));
  });

  it("reads signed PwrSnap loopback images for federation transport", async () => {
    const { readTranscriptImageProtocolRequest } = await import(
      "../transcript-image-protocol"
    );
    const signedUrl =
      "http://127.0.0.1:51729/media?grant=read-once-grant&signature=valid-signature";
    const bytes = new Uint8Array([7, 8, 9]);
    const fetch = vi.fn(async () => ({
      ok: true,
      headers: {
        get: (name: string) => {
          if (name === "content-type") {
            return "image/png";
          }
          if (name === "content-length") {
            return String(bytes.byteLength);
          }
          return null;
        },
      },
      arrayBuffer: async () => bytes.buffer,
    }));

    await expect(
      readTranscriptImageProtocolRequest(
        signedUrl,
        undefined,
        { fetch },
      ),
    ).resolves.toEqual({
      dataBase64: Buffer.from(bytes).toString("base64"),
      mimeType: "image/png",
    });
    expect(fetch).toHaveBeenCalledWith(
      signedUrl,
      expect.objectContaining({ redirect: "error" }),
    );
  });

  it("does not fetch arbitrary HTTP image URLs", async () => {
    const { materializeTranscriptImageUrlsForRenderer } = await import(
      "../transcript-image-protocol"
    );
    const externalUrl = "https://example.com/untrusted-image.png";
    const fetch = vi.fn();

    const response = await materializeTranscriptImageUrlsForRenderer(
      {
        backend: "codex",
        fetchedAt: 1,
        threadId: "thread-external-image",
        replay: {
          entries: [],
          messages: [
            {
              id: "message-1",
              role: "assistant",
              text: "Image.",
              parts: [{ type: "image", url: externalUrl }],
            },
          ],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      },
      { fetch },
    );

    expect(response.replay.messages[0]?.parts).toEqual([
      { type: "image", url: externalUrl },
    ]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not fetch unsigned or untrusted loopback image URLs", async () => {
    const { materializeTranscriptImageUrlsForRenderer } = await import(
      "../transcript-image-protocol"
    );
    const imageUrls = [
      "http://127.0.0.1:51729/media?grant=missing-signature",
      "http://127.0.0.1:51730/media?grant=other-service&signature=signature",
      "http://localhost:51729/media?grant=wrong-origin&signature=signature",
    ];
    const fetch = vi.fn();

    const response = await materializeTranscriptImageUrlsForRenderer(
      {
        backend: "codex",
        fetchedAt: 1,
        threadId: "thread-untrusted-loopback-image",
        replay: {
          entries: [],
          messages: [
            {
              id: "message-1",
              role: "assistant",
              text: "Images.",
              parts: imageUrls.map((url) => ({ type: "image" as const, url })),
            },
          ],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      },
      { fetch },
    );

    expect(response.replay.messages[0]?.parts).toEqual(
      imageUrls.map((url) => ({ type: "image", url })),
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["png", "svg"])("snapshots approved worktree Markdown %s links into transcript galleries", async (extension) => {
    const { materializeTranscriptImageUrlsForRenderer } = await import(
      "../transcript-image-protocol"
    );
    const imageName = `dmg-background.${extension}`;
    const imagePath = path.join(tempDir, "worktree", imageName);
    const linkedImagePath = imagePath;
    const sourceUrl = pathToFileURL(linkedImagePath).toString();
    await mkdir(path.dirname(imagePath), { recursive: true });
    const imageBytes = extension === "svg"
      ? Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>')
      : Buffer.from([7, 8, 9]);
    await writeFile(imagePath, imageBytes);
    const resolveApprovedLocalImageRoots = vi.fn(async () => [
      path.join(tempDir, "worktree"),
    ]);
    const message = {
      id: "message-image-link",
      role: "assistant" as const,
      text: `The background is [${imageName}](${linkedImagePath}).`,
    };

    const response = await materializeTranscriptImageUrlsForRenderer(
      {
        backend: "codex",
        fetchedAt: 1,
        threadId: "thread-image-link",
        replay: {
          entries: [{ type: "message", ...message }],
          messages: [message],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      },
      {
        resolveRoot: () => path.join(tempDir, "thread-images"),
      },
      {
        resolveApprovedLocalImageRoots,
      },
    );

    expect(resolveApprovedLocalImageRoots).toHaveBeenCalledTimes(1);
    const expectedImagePart = expect.objectContaining({
      type: "image",
      url: expect.stringMatching(/^pwragent-image:\/\/file\//),
      sourceUrl,
      alt: imageName,
    });
    expect(response.replay.entries[0]).toMatchObject({
      type: "message",
      parts: [
        { type: "text", text: message.text },
        expectedImagePart,
      ],
    });
    expect(response.replay.messages[0]).toMatchObject({
      parts: [
        { type: "text", text: message.text },
        expectedImagePart,
      ],
    });
    const entryPart = response.replay.entries[0]?.type === "message"
      ? response.replay.entries[0].parts?.[1]
      : undefined;
    const materializedPath =
      entryPart?.type === "image" ? filePathFromProtocolUrl(entryPart.url) : "";
    expect(materializedPath).toContain(path.join("thread-images"));
    expect(materializedPath).toMatch(new RegExp(`\\.${extension}$`));
    await expect(readFile(materializedPath)).resolves.toEqual(imageBytes);
  });

  it("snapshots Markdown image links from agent temporary directories", async () => {
    const { materializeTranscriptImageUrlsForRenderer } = await import(
      "../transcript-image-protocol"
    );
    const temporaryRoot = path.sep === "/" ? "/tmp" : os.tmpdir();
    const agentTempDir = await mkdtemp(
      path.join(temporaryRoot, "pwragent-markdown-image-")
    );
    const imagePath = path.join(agentTempDir, "pwrgit-ui-qa-overview.png");
    const sourceUrl = pathToFileURL(imagePath).toString();
    await writeFile(imagePath, Buffer.from([10, 11, 12]));

    try {
      const message = {
        id: "message-temporary-image-link",
        role: "assistant" as const,
        text: `Open [Worktrees overview](${imagePath}).`,
      };
      const rawResponse = {
        backend: "codex" as const,
        fetchedAt: 1,
        threadId: "thread-temporary-image-link",
        replay: {
          entries: [{ type: "message" as const, ...message }],
          messages: [message],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      };
      const snapshotRoot = path.join(tempDir, "thread-images");
      const dependencies = {
        resolveRoot: () => snapshotRoot,
      };
      const options = {
        includeTemporaryImageRoots: true,
      };
      const response = await materializeTranscriptImageUrlsForRenderer(
        rawResponse,
        dependencies,
        options,
      );

      const expectedImagePart = expect.objectContaining({
        type: "image",
        url: expect.stringMatching(/^pwragent-image:\/\/file\//),
        sourceUrl,
        alt: "Worktrees overview",
      });
      expect(response.replay.messages[0]).toMatchObject({
        parts: [
          { type: "text", text: message.text },
          expectedImagePart,
        ],
      });
      const firstImagePart = response.replay.messages[0]?.parts?.[1];
      const firstSnapshotUrl = firstImagePart?.type === "image"
        ? firstImagePart.url
        : "";
      const firstSnapshotPath = filePathFromProtocolUrl(firstSnapshotUrl);
      expect(path.basename(firstSnapshotPath)).toMatch(/^markdown-[a-f0-9]{64}\.png$/);
      await expect(readFile(firstSnapshotPath)).resolves.toEqual(Buffer.from([10, 11, 12]));

      await rm(agentTempDir, { recursive: true, force: true });

      const rehydrated = await materializeTranscriptImageUrlsForRenderer(
        rawResponse,
        dependencies,
        options,
      );

      expect(rehydrated.replay.messages[0]).toMatchObject({
        parts: [
          { type: "text", text: message.text },
          expectedImagePart,
        ],
      });
      const rehydratedImagePart = rehydrated.replay.messages[0]?.parts?.[1];
      expect(rehydratedImagePart).toMatchObject({
        type: "image",
        url: firstSnapshotUrl,
        sourceUrl,
      });
    } finally {
      await rm(agentTempDir, { recursive: true, force: true });
    }
  });

  it("adopts another profile's snapshot once the linked source is gone", async () => {
    const { materializeTranscriptImageUrlsForRenderer } = await import(
      "../transcript-image-protocol"
    );
    // The source never exists here: macOS swept it out of /tmp after the
    // other profile snapshotted it.
    const imagePath = path.join(tempDir, "swept", "original-on-flamegraph.svg");
    const sourceUrl = pathToFileURL(imagePath).toString();
    const message = {
      id: "message-swept-image-link",
      role: "assistant" as const,
      text: `[Original](${imagePath})`,
    };
    const rawResponse = {
      backend: "codex" as const,
      fetchedAt: 1,
      threadId: "thread-swept-image-link",
      replay: {
        entries: [{ type: "message" as const, ...message }],
        messages: [message],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
      },
    };
    const cacheName = `markdown-${createHash("sha256")
      .update(`${message.id}\0${sourceUrl}`)
      .digest("hex")}.svg`;
    const otherProfileRoot = path.join(tempDir, "other-profile-thread-images");
    const unrelatedProfileRoot = path.join(tempDir, "unrelated-profile-thread-images");
    await mkdir(otherProfileRoot, { recursive: true });
    await mkdir(unrelatedProfileRoot, { recursive: true });
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
    await writeFile(path.join(otherProfileRoot, cacheName), svg);
    await writeFile(path.join(unrelatedProfileRoot, `markdown-${"0".repeat(64)}.svg`), svg);
    const activeRoot = path.join(tempDir, "active-profile-thread-images");

    const response = await materializeTranscriptImageUrlsForRenderer(
      rawResponse,
      {
        resolveRoot: () => activeRoot,
        resolveSiblingRoots: async () => [unrelatedProfileRoot, otherProfileRoot],
      },
      { includeTemporaryImageRoots: true },
    );

    const imagePart = response.replay.messages[0]?.parts?.[1];
    expect(imagePart).toMatchObject({ type: "image", sourceUrl, alt: "Original" });
    const adoptedPath = filePathFromProtocolUrl(imagePart?.type === "image" ? imagePart.url : "");
    // Copied, not referenced: it survives the other profile's removal.
    expect(adoptedPath).toBe(path.join(activeRoot, cacheName));
    await expect(readFile(adoptedPath)).resolves.toEqual(svg);
  });

  it("refuses a symlinked sibling snapshot and scans profiles once per read", async () => {
    const { materializeTranscriptImageUrlsForRenderer } = await import(
      "../transcript-image-protocol"
    );
    const secretPath = path.join(tempDir, "outside-any-root.svg");
    await writeFile(secretPath, '<svg xmlns="http://www.w3.org/2000/svg"><text>secret</text></svg>');
    const message = {
      id: "message-symlinked-snapshot",
      role: "assistant" as const,
      text: [
        `[One](${path.join(tempDir, "swept", "one.svg")})`,
        `[Two](${path.join(tempDir, "swept", "two.svg")})`,
      ].join(" "),
    };
    const otherProfileRoot = path.join(tempDir, "symlinking-profile-thread-images");
    await mkdir(otherProfileRoot, { recursive: true });
    const cacheName = `markdown-${createHash("sha256")
      .update(`${message.id}\0${pathToFileURL(path.join(tempDir, "swept", "one.svg")).toString()}`)
      .digest("hex")}.svg`;
    await symlink(secretPath, path.join(otherProfileRoot, cacheName));
    const resolveSiblingRoots = vi.fn(async () => [otherProfileRoot]);

    const response = await materializeTranscriptImageUrlsForRenderer(
      {
        backend: "codex" as const,
        fetchedAt: 1,
        threadId: "thread-symlinked-snapshot",
        replay: {
          entries: [{ type: "message" as const, ...message }],
          messages: [message],
          pagination: { supportsPagination: false, hasPreviousPage: false },
        },
      },
      {
        resolveRoot: () => path.join(tempDir, "active-profile-thread-images"),
        resolveSiblingRoots,
      },
      { includeTemporaryImageRoots: true },
    );

    expect((response.replay.messages[0]?.parts ?? []).some((part) => part.type === "image")).toBe(false);
    expect(resolveSiblingRoots).toHaveBeenCalledTimes(1);
  });

  it("does not adopt a snapshot taken for a different message", async () => {
    const { materializeTranscriptImageUrlsForRenderer } = await import(
      "../transcript-image-protocol"
    );
    const imagePath = path.join(tempDir, "swept", "combined-on-flamegraph.svg");
    const message = {
      id: "message-without-snapshot",
      role: "assistant" as const,
      text: `[On](${imagePath})`,
    };
    const otherProfileRoot = path.join(tempDir, "other-profile-thread-images");
    await mkdir(otherProfileRoot, { recursive: true });
    const otherMessageCache = `markdown-${createHash("sha256")
      .update(`another-message\0${pathToFileURL(imagePath).toString()}`)
      .digest("hex")}.svg`;
    await writeFile(
      path.join(otherProfileRoot, otherMessageCache),
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    );

    const response = await materializeTranscriptImageUrlsForRenderer(
      {
        backend: "codex" as const,
        fetchedAt: 1,
        threadId: "thread-without-snapshot",
        replay: {
          entries: [{ type: "message" as const, ...message }],
          messages: [message],
          pagination: { supportsPagination: false, hasPreviousPage: false },
        },
      },
      {
        resolveRoot: () => path.join(tempDir, "active-profile-thread-images"),
        resolveSiblingRoots: async () => [otherProfileRoot],
      },
      { includeTemporaryImageRoots: true },
    );

    expect((response.replay.messages[0]?.parts ?? []).some((part) => part.type === "image")).toBe(false);
  });

  it("returns durable data images for messaging after temporary source cleanup", async () => {
    const { materializeTranscriptMessageImagesForMessaging } = await import(
      "../transcript-image-protocol"
    );
    const agentTempDir = await mkdtemp(
      path.join(os.tmpdir(), "pwragent-messaging-image-")
    );
    const imagePath = path.join(agentTempDir, "final-overview.png");
    const imageBytes = Buffer.from([20, 21, 22, 23]);
    await writeFile(imagePath, imageBytes);

    try {
      const message = {
        id: "assistant-final-image",
        role: "assistant" as const,
        text: `See [Final overview](${imagePath}).`,
      };
      const response = {
        backend: "codex" as const,
        fetchedAt: 1,
        threadId: "thread-messaging-image",
        replay: {
          entries: [],
          messages: [message],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      };
      const dependencies = {
        resolveRoot: () => path.join(tempDir, "thread-images"),
      };
      const options = {
        includeTemporaryImageRoots: true,
      };

      const first = await materializeTranscriptMessageImagesForMessaging(
        response,
        message,
        dependencies,
        options,
      );
      expect(first).toEqual([
        {
          type: "image",
          url: `data:image/png;base64,${imageBytes.toString("base64")}`,
          sourceUrl: pathToFileURL(imagePath).toString(),
          alt: "Final overview",
        },
      ]);

      await rm(agentTempDir, { recursive: true, force: true });

      await expect(
        materializeTranscriptMessageImagesForMessaging(
          response,
          message,
          dependencies,
          options,
        ),
      ).resolves.toEqual(first);
    } finally {
      await rm(agentTempDir, { recursive: true, force: true });
    }
  });

  it("keeps data image URLs when materialization writes fail", async () => {
    const { materializeTranscriptImageUrlsForRenderer } = await import(
      "../transcript-image-protocol"
    );
    const dataUrl = "data:image/png;base64,AQID";

    const response = await materializeTranscriptImageUrlsForRenderer(
      {
        backend: "codex",
        fetchedAt: 1,
        threadId: "thread-images",
        replay: {
          entries: [],
          messages: [
            {
              id: "message-1",
              role: "user",
              text: "what's in this?",
              parts: [{ type: "image", url: dataUrl }],
            },
          ],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      },
      {
        resolveRoot: () => path.join(tempDir, "thread-images"),
        writeFile: async () => {
          throw new Error("disk full");
        },
      }
    );

    expect(response.replay.messages[0]?.parts).toEqual([
      { type: "image", url: dataUrl },
    ]);
  });

  it("leaves unsupported and malformed data image URLs unchanged", async () => {
    const { materializeTranscriptImageUrlsForRenderer } = await import(
      "../transcript-image-protocol"
    );
    const unsupportedDataUrl = "data:image/heic;base64,AQID";
    const malformedDataUrl = "data:image/png;base64,!!!!";

    const response = await materializeTranscriptImageUrlsForRenderer(
      {
        backend: "codex",
        fetchedAt: 1,
        threadId: "thread-images",
        replay: {
          entries: [],
          messages: [
            {
              id: "message-1",
              role: "user",
              text: "images",
              parts: [
                { type: "image", url: unsupportedDataUrl },
                { type: "image", url: malformedDataUrl },
              ],
            },
          ],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      },
      {
        resolveRoot: () => path.join(tempDir, "unused"),
      }
    );

    expect(response.replay.messages[0]?.parts).toEqual([
      { type: "image", url: unsupportedDataUrl },
      { type: "image", url: malformedDataUrl },
    ]);
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

function filePathFromProtocolUrl(protocolUrl: string): string {
  const parsed = new URL(protocolUrl);
  const encodedSource = parsed.pathname.replace(/^\//, "");
  return fileURLToPath(decodeURIComponent(encodedSource));
}
