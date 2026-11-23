import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, inject, it, onTestFinished } from "vitest";
import { acquireNativeFileLock } from "../app-server/maintenance-native-lock";
import { GhStackCatalogStore } from "../stacks/stack-engine-ports";

it("keeps gh stack lock inodes, rejects foreign journals and compares catalog bytes before replacing them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pwragent-stack-ports-"));
  onTestFinished(async () => await rm(dir, { recursive: true, force: true }));
  const operationPath = join(dir, "gh-stack-operation.lock");
  const relay = inject("nativeHelperFixtures").stackEngine!.relay;
  const store = new GhStackCatalogStore(relay);
  const first = await acquireNativeFileLock("--stack-lock", operationPath, relay);
  expect(first).toBeDefined();
  try {
    await expect(acquireNativeFileLock("--stack-lock", operationPath, relay)).resolves.toBeUndefined();
  } finally {
    await first?.release();
  }
  await expect(readFile(operationPath, "utf8")).resolves.toBe("");
  const journal = join(dir, "pwrgit-stack-op.json");
  await writeFile(journal, "{}");
  await expect(store.withOperationLock(dir, async () => undefined)).rejects.toMatchObject({
    code: "gh_stack_busy", message: expect.stringContaining("PwrGit"),
  });
  await rm(journal);
  await store.withOperationLock(dir, async () => {
    const { catalog, sha256 } = await store.read(dir);
    const next = { ...catalog, repository: "github.com:fixture/stack" };
    await store.writeIfUnchanged(dir, next, sha256);
    await expect(store.writeIfUnchanged(dir, catalog, sha256)).rejects.toMatchObject({ code: "stale_plan" });
    await expect(store.read(dir)).resolves.toMatchObject({ catalog: next });
  });
});

it("retains an already-committed journal through a failed completion and clears it on acknowledgment", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pwragent-stack-ack-"));
  onTestFinished(async () => await rm(dir, { recursive: true, force: true }));
  const store = new GhStackCatalogStore(inject("nativeHelperFixtures").stackEngine!.relay);
  const catalog = { schemaVersion: 1 as const, repository: "", stacks: [] };
  const notice = { opId: "fixture", actor: { backend: "codex" as const, threadId: "lead" }, kind: "add_branch" as const, participants: [] };
  const journal = { direction: "apply" as const, worktrees: [], receipt: { id: "fixture", when: 1, before: catalog, after: catalog, moves: [] } };
  await store.withOperationLock(dir, async () => {
    await store.journalHooks(dir, notice).begin?.(journal);
    await store.markJournalCommitted(dir, journal, notice);
  });
  await store.recover(dir, async (entry) => {
    expect(entry.committed).toBe(true);
    return "retain";
  });
  await expect(store.withOperationLock(dir, async () => undefined)).rejects.toMatchObject({ code: "gh_stack_busy" });
  await expect(store.recover(dir, async () => { throw new Error("provider offline"); })).rejects.toThrow("provider offline");
  expect(await store.hasJournal(dir)).toBe(true);
  await store.recover(dir, async (entry) => expect(entry.notification.opId).toBe(notice.opId));
  expect(await store.hasJournal(dir)).toBe(false);
});
