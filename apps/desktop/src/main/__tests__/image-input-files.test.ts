import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ownThreadInputAttachments } from "../app-server/turn-input-attachment-files";

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
