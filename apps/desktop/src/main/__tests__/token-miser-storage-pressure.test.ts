import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { TestTokenMiserStore as TokenMiserStore } from "./token-miser-test-store";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "miser-migration-pressure-"));
  roots.push(root);
  const store = new TokenMiserStore(root);
  for (let index = 0; index < 40; index += 1) {
    const objectId = randomUUID();
    await fs.writeFile(path.join(root, `${objectId}.json`), JSON.stringify({
      version: 1, objectId, threadId: `owner-${index % 2}`, turnId: "turn", toolUseId: objectId,
      toolName: "Code Mode", createdAt: index, originalCharacters: 100,
      baselineParentTokens: 25, replacementCharacters: 10, retrievedCharacters: 0, replayTrackingVersion: 2,
      summary: { summary: "PRIVATE_SUMMARY", usefulDetails: [] },
    }));
    await fs.writeFile(path.join(root, `${objectId}.txt`), "PRIVATE_OUTPUT");
  }
  return { root, store };
}
it("bounds migration reads and never scans files after successful migration", async () => {
  const { store, root } = await fixture();
  let active = 0;
  let peak = 0;
  const readFile = fs.readFile.bind(fs);
  const read = vi.spyOn(fs, "readFile").mockImplementation(async (file, options) => {
    active += 1; peak = Math.max(peak, active);
    try { return await readFile(file, options); } finally { active -= 1; }
  });
  await store.prune({ maxAgeMs: 0, maxBytes: 0 });
  expect(peak).toBeLessThanOrEqual(16);
  expect(read).toHaveBeenCalledTimes(40);
  await expect(fs.stat(root)).rejects.toMatchObject({ code: "ENOENT" });
  read.mockClear();
  const list = vi.spyOn(fs, "readdir");
  const restarted = new TokenMiserStore(root);
  await restarted.prune({ maxAgeMs: 0, maxBytes: 0 });
  const usage = await restarted.summarizeThreadUsage("owner-0");
  expect(usage.interceptionCount).toBe(20);
  expect(read).not.toHaveBeenCalled();
  expect(list).not.toHaveBeenCalled();
});
it("retains every legacy file when the import transaction fails and retries atomically", async () => {
  const { store, root } = await fixture();
  store.stateDb.raw.exec("CREATE TRIGGER fail_import BEFORE INSERT ON token_miser_objects WHEN NEW.thread_id = 'owner-1' BEGIN SELECT RAISE(ABORT, 'fixture import failure'); END");
  await expect(store.prune({ maxAgeMs: 0, maxBytes: 0 })).rejects.toThrow("fixture import failure");
  expect(await fs.readdir(root)).toHaveLength(80);
  expect(await store.listMetadata()).toHaveLength(0);
  store.stateDb.raw.exec("DROP TRIGGER fail_import");
  await store.prune({ maxAgeMs: 0, maxBytes: 0 });
  expect(await store.listMetadata()).toHaveLength(40);
});
it("retries interrupted deletion without replacing newer SQLite counters", async () => {
  const { store, root } = await fixture();
  const remove = vi.spyOn(fs, "rm").mockRejectedValue(new Error("fixture unlink failure"));
  await expect(store.prune({ maxAgeMs: 0, maxBytes: 0 })).rejects.toThrow("fixture unlink failure");
  remove.mockRestore();
  const [entry] = await store.listMetadata();
  await store.stopReplayTracking({ objectId: entry!.objectId, stoppedAt: 1234 });
  await new TokenMiserStore(root).prune({ maxAgeMs: 0, maxBytes: 0 });
  expect((await store.readMetadata(entry!.objectId))?.replayTrackingStoppedAt).toBe(1234);
  expect(await store.listMetadata()).toHaveLength(40);
});

it("allows concurrent processes to import and clean up the same legacy directory", async () => {
  const { store, root } = await fixture();
  const second = new TokenMiserStore(root);
  await Promise.all([
    store.prune({ maxAgeMs: 0, maxBytes: 0 }),
    second.prune({ maxAgeMs: 0, maxBytes: 0 }),
  ]);
  expect(await store.listMetadata()).toHaveLength(40);
  expect(await second.listMetadata()).toHaveLength(40);
  await expect(fs.stat(root)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each([true, false])("accepts Windows cleanup EPERM only when the directory is gone (removed=%s)", async (removed) => {
  const { store, root } = await fixture();
  const rmdir = fs.rmdir.bind(fs);
  vi.spyOn(fs, "rmdir").mockImplementation(async (directory, options) => {
    if (directory !== root) return await rmdir(directory, options);
    if (removed) await rmdir(directory, options);
    throw Object.assign(new Error("fixture concurrent Windows removal"), { code: "EPERM" });
  });
  if (removed) {
    await store.prune({ maxAgeMs: 0, maxBytes: 0 });
    expect(await store.listMetadata()).toHaveLength(40);
    await expect(fs.stat(root)).rejects.toMatchObject({ code: "ENOENT" });
  } else {
    await expect(store.prune({ maxAgeMs: 0, maxBytes: 0 })).rejects.toMatchObject({ code: "EPERM" });
    expect((await fs.stat(root)).isDirectory()).toBe(true);
  }
});
