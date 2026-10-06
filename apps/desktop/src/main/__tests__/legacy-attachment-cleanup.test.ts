import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveActiveProfilePath } from "../profile";
import { stageLocalTurnInputAttachment, stageTurnInputAttachment } from "../app-server/turn-input-attachment-files";
import * as legacyCleanup from "../app-server/legacy-attachment-cleanup";

const pendingOperations = vi.hoisted(() => new Set<Promise<unknown>>());
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 6);
let testRoot: string;

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: vi.fn((...args: Parameters<typeof actual.readdir>) => track(actual.readdir(...args))),
    lstat: (...args: Parameters<typeof actual.lstat>) => track(actual.lstat(...args)),
    unlink: (...args: Parameters<typeof actual.unlink>) => track(actual.unlink(...args)),
    rmdir: (...args: Parameters<typeof actual.rmdir>) => track(actual.rmdir(...args)),
    stat: (...args: Parameters<typeof actual.stat>) => track(actual.stat(...args)),
    rm: (...args: Parameters<typeof actual.rm>) => track(actual.rm(...args)),
  };
});

function track<T>(operation: Promise<T>): Promise<T> {
  pendingOperations.add(operation);
  void operation.then(() => pendingOperations.delete(operation), () => pendingOperations.delete(operation));
  return operation;
}

async function settleCleanup(): Promise<void> {
  // Await the actual upload-scheduled work, including gaps between I/O calls.
  const scheduled = vi.mocked(legacyCleanup.scheduleLegacyAttachmentCleanup).mock.results;
  await Promise.allSettled(scheduled.flatMap((result) => result.type === "return" ? [result.value] : []));
  while (pendingOperations.size > 0) await Promise.allSettled([...pendingOperations]);
}

async function writeAgedFile(relativePath: string, ageDays: number): Promise<string> {
  const filePath = resolveActiveProfilePath(relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, "retained bytes");
  const written = new Date(NOW - ageDays * DAY);
  await utimes(filePath, written, written);
  return filePath;
}

async function upload(): Promise<void> {
  await stageTurnInputAttachment({ type: "localImage", name: "new.png", data: Buffer.from([1]) });
  await settleCleanup();
}

beforeEach(async () => {
  testRoot = await mkdtemp(path.join(os.tmpdir(), "pwragent-legacy-expiry-"));
  vi.stubEnv("PWRAGENT_HOME", testRoot);
  vi.stubEnv("PWRAGENT_PROFILE", "test");
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  vi.spyOn(legacyCleanup, "scheduleLegacyAttachmentCleanup");
});

afterEach(async () => {
  await settleCleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(testRoot, { recursive: true, force: true });
});

describe("legacy attachment expiry", () => {
  it.each(["staging", "owned", "local-file"])("expires both legacy stores after a %s upload without removing thread-owned assets", async (kind) => {
    const image = await writeAgedFile("state/image-inputs/digest/old.png", 31);
    const file = await writeAgedFile("state/turn-input-attachments/digest/old.pdf", 31);
    const owned = await writeAgedFile("state/thread-assets/codex/thread/digest/owned.png", 90);
    const owner = { backend: "codex" as const, threadId: "new-thread" };
    if (kind === "local-file") {
      const original = path.join(testRoot, "external.txt");
      await writeFile(original, "source");
      await stageLocalTurnInputAttachment({ type: "localFile", path: original }, { owner });
    } else {
      await stageTurnInputAttachment({ type: "localImage", name: "new.png", data: Buffer.from([1]) }, kind === "owned" ? owner : undefined);
    }
    await settleCleanup();
    expect(legacyCleanup.scheduleLegacyAttachmentCleanup).toHaveBeenCalledOnce();
    for (const expired of [image, file]) await expect(lstat(expired)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(owned, "utf8")).resolves.toBe("retained bytes");
  });

  it.each(["image-inputs", "turn-input-attachments"])("uses file write age in %s, preserving the 30-day boundary and newer neighbors", async (store) => {
    const old = await writeAgedFile(`state/${store}/digest/old.png`, 31);
    const boundary = await writeAgedFile(`state/${store}/digest/boundary.png`, 30);
    const recent = await writeAgedFile(`state/${store}/digest/recent.png`, 29);
    const flat = await writeAgedFile(`state/${store}/flat.png`, 31);
    // Directory age neither protects an expired file nor expires a fresh one.
    const oldDate = new Date(NOW - 60 * DAY);
    await utimes(path.dirname(old), oldDate, oldDate);
    await upload();
    for (const expired of [old, flat]) await expect(lstat(expired)).rejects.toMatchObject({ code: "ENOENT" });
    for (const kept of [boundary, recent]) await expect(readFile(kept, "utf8")).resolves.toBe("retained bytes");
  });

  it("removes empty legacy buckets while preserving unread files in another profile", async () => {
    const old = await writeAgedFile("state/image-inputs/old-bucket/old.png", 31);
    const other = path.join(testRoot, "profiles", "other", "state", "image-inputs", "other.png");
    await mkdir(path.dirname(other), { recursive: true });
    await writeFile(other, "other profile");
    const oldDate = new Date(NOW - 60 * DAY);
    await utimes(other, oldDate, oldDate);
    await upload();
    await expect(lstat(path.dirname(old))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(other, "utf8")).resolves.toBe("other profile");
  });

  it("does not follow a legacy bucket symlink outside the store", async () => {
    const external = path.join(testRoot, "external-bucket");
    await mkdir(external);
    const file = path.join(external, "old.png");
    await writeFile(file, "external bytes");
    const oldDate = new Date(NOW - 60 * DAY);
    await utimes(file, oldDate, oldDate);
    const root = resolveActiveProfilePath("state/image-inputs");
    await mkdir(root, { recursive: true });
    await symlink(external, path.join(root, "linked-bucket"), process.platform === "win32" ? "junction" : "dir");
    await upload();
    await expect(readFile(file, "utf8")).resolves.toBe("external bytes");
  });

  it("throttles repeated upload cleanup to once per hour", async () => {
    const first = await writeAgedFile("state/image-inputs/first/old.png", 31);
    await upload();
    await expect(lstat(first)).rejects.toMatchObject({ code: "ENOENT" });
    const second = await writeAgedFile("state/image-inputs/second/old.png", 31);
    await Promise.all(Array.from({ length: 5 }, () => upload()));
    await expect(readFile(second, "utf8")).resolves.toBe("retained bytes");
    const root = resolveActiveProfilePath("state/image-inputs");
    expect(vi.mocked(readdir).mock.calls.filter(([directory]) => directory === root)).toHaveLength(1);
    vi.mocked(Date.now).mockReturnValue(NOW + 60 * 60 * 1000);
    await upload();
    await expect(lstat(second)).rejects.toMatchObject({ code: "ENOENT" });
    expect(vi.mocked(readdir).mock.calls.filter(([directory]) => directory === root)).toHaveLength(2);
  });
});
