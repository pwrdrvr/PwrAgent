import { copyFile, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveActiveProfilePath } from "../profile";
import {
  stageLocalTurnInputAttachment,
  stageTurnInputAttachment,
  turnInputAttachmentRoot,
} from "../app-server/turn-input-attachment-files";
import { deleteThreadAssets, existingThreadAssetAlias, storeThreadAsset, threadAssetRoot } from "../app-server/thread-assets";

let testRoot: string;
const source = { backend: "codex" as const, threadId: "source" };
const recipient = { backend: "codex" as const, threadId: "recipient" };

beforeEach(async () => {
  testRoot = await mkdtemp(path.join(os.tmpdir(), "pwragent-thread-assets-"));
  vi.stubEnv("PWRAGENT_HOME", testRoot);
  vi.stubEnv("PWRAGENT_PROFILE", "test");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(testRoot, { recursive: true, force: true });
});

describe("thread-owned attachments", () => {
  it.each(["localImage", "localFile"] as const)("keeps forwarded %s bytes after the source thread is deleted", async (type) => {
    const bytes = Buffer.from([1, 2, 3]);
    const original = await stageTurnInputAttachment({ type, name: "shared.png", data: bytes }, source);
    const forwarded = await stageLocalTurnInputAttachment(original, { owner: recipient });
    expect(forwarded.path).not.toBe(original.path);
    expect(original.path.startsWith(resolveActiveProfilePath("state/thread-assets/codex/source/"))).toBe(true);
    const originalStat = await stat(original.path);
    const forwardedStat = await stat(forwarded.path);
    expect(forwardedStat.ino).toBe(originalStat.ino);
    expect(forwardedStat.nlink).toBeGreaterThanOrEqual(2);

    await rm(resolveActiveProfilePath("state/thread-assets/codex/source"), { recursive: true, force: true });
    await expect(readFile(forwarded.path)).resolves.toEqual(bytes);
    await rm(resolveActiveProfilePath("state/thread-assets/codex/recipient"), { recursive: true, force: true });
    await expect(stat(forwarded.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("isolates mutable external files before sharing them", async () => {
    const externalPath = path.join(testRoot, "external.png");
    await writeFile(externalPath, Buffer.from([1, 2, 3]));
    const owned = await stageLocalTurnInputAttachment({ type: "localImage", path: externalPath }, { owner: source });
    await writeFile(externalPath, Buffer.from([4, 5, 6]));
    await expect(readFile(owned.path)).resolves.toEqual(Buffer.from([1, 2, 3]));
    expect((await stat(owned.path)).ino).not.toBe((await stat(externalPath)).ino);
  });

  it("shares immutable assets across profiles without making the recipient depend on the source profile", async () => {
    vi.stubEnv("PWRAGENT_PROFILE", "source-profile");
    const original = await stageTurnInputAttachment({ type: "localImage", name: "image.png", data: Buffer.from([1, 2, 3]) }, source);
    vi.stubEnv("PWRAGENT_PROFILE", "recipient-profile");
    const forwarded = await stageLocalTurnInputAttachment(original, { owner: recipient });
    expect((await stat(forwarded.path)).ino).toBe((await stat(original.path)).ino);
    await rm(path.join(testRoot, "profiles", "source-profile"), { recursive: true, force: true });
    await expect(readFile(forwarded.path)).resolves.toEqual(Buffer.from([1, 2, 3]));
  });

  it.each(["EXDEV", "EPERM", "EMLINK"])("falls back to a clone/copy when hardlinking fails with %s", async (code) => {
    const bytes = Buffer.from([1, 2, 3]);
    const original = await stageTurnInputAttachment({ type: "localImage", name: "image.png", data: bytes }, source);
    const copy = vi.fn(copyFile);
    const forwarded = await storeThreadAsset(recipient, bytes, "image.png", original.path, {
      link: vi.fn(async () => { throw Object.assign(new Error("No hardlinks"), { code }); }),
      copyFile: copy,
    });
    expect(copy).toHaveBeenCalledWith(original.path, expect.any(String), constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    expect((await stat(forwarded)).ino).not.toBe((await stat(original.path)).ino);
    await deleteThreadAssets(source);
    await expect(readFile(forwarded)).resolves.toEqual(bytes);
  });

  it("atomically repairs one owned path without rewriting another thread's inode", async () => {
    const bytes = Buffer.from([1, 2, 3]);
    const original = await stageTurnInputAttachment({ type: "localImage", name: "image.png", data: bytes }, source);
    const forwarded = await stageLocalTurnInputAttachment(original, { owner: recipient });
    await writeFile(original.path, Buffer.from([9, 9, 9]));
    await stageTurnInputAttachment({ type: "localImage", name: "image.png", data: bytes }, source);
    await expect(readFile(original.path)).resolves.toEqual(bytes);
    await expect(readFile(forwarded.path)).resolves.toEqual(Buffer.from([9, 9, 9]));
    expect((await stat(original.path)).ino).not.toBe((await stat(forwarded.path)).ino);
  });

  it("expires unowned staging uploads while preserving old thread-owned assets", async () => {
    const root = turnInputAttachmentRoot();
    const stagedPath = path.join(root, "old", "unused.png");
    await mkdir(path.dirname(stagedPath), { recursive: true });
    await writeFile(stagedPath, Buffer.from([1]));
    const owned = await stageTurnInputAttachment({ type: "localImage", data: Buffer.from([2]), name: "owned.png" }, source);
    const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await utimes(path.dirname(stagedPath), oldDate, oldDate);
    await utimes(path.dirname(owned.path), oldDate, oldDate);
    await stageTurnInputAttachment({ type: "localImage", name: "new.png", data: Buffer.from([3]) });
    await vi.waitFor(async () => {
      await expect(stat(stagedPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
    await expect(readFile(owned.path)).resolves.toEqual(Buffer.from([2]));
  });

  it("reuses promoted legacy content after the original cache path disappears", async () => {
    const bytes = Buffer.from([1, 2, 3]);
    const digest = "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81";
    const legacyPath = resolveActiveProfilePath(`state/turn-input-attachments/${digest}/image.png`);
    await mkdir(path.dirname(legacyPath), { recursive: true });
    await writeFile(legacyPath, bytes);
    const owned = await stageLocalTurnInputAttachment({ type: "localImage", path: legacyPath }, { owner: source });
    await rm(legacyPath);
    await expect(existingThreadAssetAlias(source, legacyPath)).resolves.toBe(owned.path);
    await expect(readFile(owned.path)).resolves.toEqual(bytes);
  });

  it("removes a permanently deleted thread's previews using the existing cache encoding", async () => {
    const owner = { backend: "acp:test" as const, threadId: "session.with.dots" };
    const previewPath = resolveActiveProfilePath("state/thread-images/acp%3Atest/session.with.dots/preview.png");
    await mkdir(path.dirname(previewPath), { recursive: true });
    await writeFile(previewPath, Buffer.from([1, 2, 3]));
    const owned = await stageTurnInputAttachment({ type: "localImage", data: Buffer.from([1, 2, 3]) }, owner);
    await deleteThreadAssets(owner);
    await expect(stat(owned.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(previewPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("isolates identical thread IDs belonging to different providers and encodes unsafe path segments", async () => {
    expect(threadAssetRoot({ backend: "acp:test", threadId: "source" })).not.toBe(threadAssetRoot(source));
    const unsafe = threadAssetRoot({ backend: "codex", threadId: "../CON" });
    expect(unsafe.startsWith(`${threadAssetRoot()}${path.sep}`)).toBe(true);
    expect(unsafe).toContain("%2E%2E%2FCON");
    expect(threadAssetRoot({ backend: "codex", threadId: "CON" })).toContain("%43ON");
  });
});
