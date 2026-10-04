import { mkdtemp, readFile, rm, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  stageTurnInputAttachment,
  stageTurnInputAttachmentsForRetention,
} from "../app-server/turn-input-attachment-files";

const pendingFileOperations = vi.hoisted(() => new Set<Promise<unknown>>());

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: (...args: Parameters<typeof actual.readdir>) => track(actual.readdir(...args)),
    stat: (...args: Parameters<typeof actual.stat>) => track(actual.stat(...args)),
    rm: (...args: Parameters<typeof actual.rm>) => track(actual.rm(...args)),
  };
});

function track<T>(operation: Promise<T>): Promise<T> {
  pendingFileOperations.add(operation);
  void operation.then(
    () => pendingFileOperations.delete(operation),
    () => pendingFileOperations.delete(operation),
  );
  return operation;
}

async function settleFileOperations(): Promise<void> {
  // The old expiry sweep is fire-and-forget. Await its filesystem work before
  // checking retention so a passing assertion cannot race a later deletion.
  while (pendingFileOperations.size > 0) {
    await Promise.allSettled([...pendingFileOperations]);
  }
}

let testRoot: string;

beforeEach(async () => {
  testRoot = await mkdtemp(path.join(os.tmpdir(), "pwragent-attachment-retention-"));
  vi.stubEnv("PWRAGENT_HOME", testRoot);
  vi.stubEnv("PWRAGENT_PROFILE", "test");
});

afterEach(async () => {
  await settleFileOperations();
  vi.unstubAllEnvs();
  await rm(testRoot, { recursive: true, force: true });
});

describe("retained turn input attachments", () => {
  it.each(["localImage", "localFile"] as const)("preserves an old %s for replay and forwarding after another upload", async (type) => {
    const data = Buffer.from([1, 2, 3]);
    const staged = await stageTurnInputAttachment({
      type,
      name: type === "localImage" ? "old.png" : "old.txt",
      data,
    }, { backend: "codex", threadId: "old-thread" });
    await settleFileOperations();
    const staleDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await utimes(staged.path, staleDate, staleDate);
    await utimes(path.dirname(staged.path), staleDate, staleDate);

    await stageTurnInputAttachment({
      type: "localImage",
      name: "new.png",
      data: Buffer.from([4, 5, 6]),
    });
    await settleFileOperations();

    await expect(readFile(staged.path)).resolves.toEqual(data);
    const retained = await stageTurnInputAttachmentsForRetention([staged], { owner: { backend: "codex", threadId: "old-thread" } });
    expect(retained).toEqual([staged]);
    await expect(readFile(staged.path)).resolves.toEqual(data);
  });
});
