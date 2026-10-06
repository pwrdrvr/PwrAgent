import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ownThreadInputAttachments, stageTurnInputAttachmentsForRetention } from "../app-server/turn-input-attachment-files";

const owner = { backend: "codex" as const, threadId: "image-thread" };
let testRoot: string;

beforeEach(async () => {
  testRoot = await mkdtemp(path.join(os.tmpdir(), "pwragent-image-inputs-"));
  vi.stubEnv("PWRAGENT_HOME", testRoot);
  vi.stubEnv("PWRAGENT_PROFILE", "test");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(testRoot, { recursive: true, force: true });
});

describe("thread image inputs", () => {
  it("materializes PNG bytes under the receiving thread while preserving the pasted filename", async () => {
    const input = await ownThreadInputAttachments([
      { type: "text", text: "Describe it" },
      { type: "image", name: "original-paste.png", url: "data:image/png;base64,AQID" },
    ], owner);
    expect(input[0]).toEqual({ type: "text", text: "Describe it" });
    expect(input[1]).toMatchObject({ type: "localImage", name: "original-paste.png" });
    const imagePath = input[1]?.type === "localImage" ? input[1].path : "";
    expect(imagePath).toContain(path.join("thread-assets", "codex", "image-thread"));
    expect(path.basename(imagePath)).toBe("original-paste.png");
    await expect(readFile(imagePath)).resolves.toEqual(Buffer.from([1, 2, 3]));
  });

  it("leaves remote image URLs untouched", async () => {
    await expect(ownThreadInputAttachments([
      { type: "image", url: "https://example.test/image.png" },
    ], owner)).resolves.toEqual([{ type: "image", url: "https://example.test/image.png" }]);
  });

  it.each(["jpeg", "png"])("uses the normalized %s extension while preserving the original WebP label", async (mimeType) => {
    const [image] = await ownThreadInputAttachments([
      { type: "image", name: "large.webp", url: `data:image/${mimeType};base64,AQID` },
    ], owner);
    if (image?.type !== "localImage") throw new Error("Expected an owned normalized image.");
    expect(image.name).toBe("large.webp");
    expect(path.extname(image.path)).toBe(mimeType === "jpeg" ? ".jpg" : ".png");
    await expect(readFile(image.path)).resolves.toEqual(Buffer.from([1, 2, 3]));
  });

  it("preserves the inline GIF provider payload while retaining a thread-owned copy", async () => {
    const image = { type: "image" as const, name: "loop.gif", url: "data:image/gif;base64,R0lGODlh" };
    const input = await ownThreadInputAttachments([image], owner);
    expect(input).toEqual([image]);
    const [retained] = await stageTurnInputAttachmentsForRetention(input, { owner });
    if (retained?.type !== "localImage") throw new Error("Expected an owned retained GIF.");
    expect(retained.path).toContain(path.join("thread-assets", "codex", "image-thread"));
    expect(path.extname(retained.path)).toBe(".gif");
    await expect(readFile(retained.path)).resolves.toEqual(Buffer.from("GIF89a"));
  });

  it("preserves the normalized file extension when forwarding an image with its original label", async () => {
    const [original] = await ownThreadInputAttachments([
      { type: "image", name: "large.webp", url: "data:image/jpeg;base64,AQID" },
    ], owner);
    if (original?.type !== "localImage") throw new Error("Expected an owned normalized image.");
    const [forwarded] = await ownThreadInputAttachments([original], { backend: "codex", threadId: "recipient" });
    if (forwarded?.type !== "localImage") throw new Error("Expected a forwarded normalized image.");
    expect(forwarded.name).toBe("large.webp");
    expect(path.extname(forwarded.path)).toBe(".jpg");
    await expect(readFile(forwarded.path)).resolves.toEqual(Buffer.from([1, 2, 3]));
  });

  it("sanitizes ASCII control characters in owned image filenames", async () => {
    const [image] = await ownThreadInputAttachments([
      { type: "image", name: "unsafe\u0000\u001fname.png", url: "data:image/png;base64,AQID" },
    ], owner);
    expect(image?.type === "localImage" ? path.basename(image.path) : "").toBe("unsafe_name.png");
  });

  it.each(["file-url", "local-image"])("owns a %s input without depending on its mutable original", async (kind) => {
    const sourcePath = path.join(testRoot, "external.jpg");
    await writeFile(sourcePath, Buffer.from([1, 2, 3]));
    const [image] = await ownThreadInputAttachments(kind === "file-url"
      ? [{ type: "image", name: "friendly.jpg", url: pathToFileURL(sourcePath).toString() }]
      : [{ type: "localImage", name: "friendly.jpg", path: sourcePath }], owner);
    if (image?.type !== "localImage") throw new Error("Expected an owned local image.");
    expect(image.path).not.toBe(sourcePath);
    expect(path.basename(image.path)).toBe("friendly.jpg");
    await rm(sourcePath);
    await expect(readFile(image.path)).resolves.toEqual(Buffer.from([1, 2, 3]));
  });

  it.each(["old.png", undefined])("preserves an old image named %s when another image is submitted", async (name) => {
    const [old] = await ownThreadInputAttachments([{ type: "image", name, url: "data:image/png;base64,AQID" }], owner);
    if (old?.type !== "localImage") throw new Error("Expected an owned local image.");
    const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await utimes(old.path, oldDate, oldDate);
    await utimes(path.dirname(old.path), oldDate, oldDate);
    await ownThreadInputAttachments([{ type: "image", name: "new.png", url: "data:image/png;base64,BAUG" }], owner);
    await expect(readFile(old.path)).resolves.toEqual(Buffer.from([1, 2, 3]));
  });
});
