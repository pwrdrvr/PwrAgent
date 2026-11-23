import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, inject, it, onTestFinished, vi } from "vitest";
import { StackGit } from "@pwragent/owner-core/stacks/engine/git";
import type { DesktopBackendRegistry } from "../app-server/backend-registry";
import { acquireNativeFileLock } from "../app-server/maintenance-native-lock";
import { GhStackCatalogStore, stackGitRunner } from "../stacks/stack-engine-ports";
import { StackOperationsService } from "../stacks/stack-operations-service";
import { resetDesktopOverlayStoreForTests, setDesktopOverlayStoreForTests } from "../storage/desktop-overlay-store";
import { SqliteOverlayStore } from "../storage/overlay-store-sqlite";
import { openInMemoryStateDb } from "./sqlite-test-utils";

vi.mock("../native-relay-path", () => ({ nativeRelayPath: () => inject("nativeHelperFixtures").stackEngine!.relay }));

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

it("keeps a carry snapshot through Git GC and can abandon provisioning after restart without losing undo", async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "pwragent-stack-abandon-")));
  const db = openInMemoryStateDb();
  setDesktopOverlayStoreForTests(new SqliteOverlayStore(db));
  onTestFinished(async () => {
    resetDesktopOverlayStoreForTests();
    db.close();
    await rm(cwd, { recursive: true, force: true });
  });
  const git = new StackGit(stackGitRunner, cwd);
  await git.output(["init", "-b", "main"]);
  await git.output(["config", "user.email", "fixture@example.invalid"]);
  await git.output(["config", "user.name", "Fixture"]);
  await git.output(["config", "commit.gpgSign", "false"]);
  await git.output(["commit", "--allow-empty", "-m", "Fixture base"]);
  const head = await git.tip("main");
  await git.output(["switch", "-c", "parent"]);
  const repository = "github.com:fixture/stack";
  await git.output(["remote", "add", "origin", "https://github.com/fixture/stack.git"]);
  const commonDir = join(cwd, ".git");
  await writeFile(join(commonDir, "gh-stack"), JSON.stringify({
    schemaVersion: 1, repository, stacks: [{ trunk: { branch: "main", head }, branches: [{ branch: "parent", head, base: head }] }],
  }));
  await writeFile(join(cwd, "carry.txt"), "Keep these edits");
  const actor = { backend: "codex" as const, threadId: "lead" };
  const publish = vi.fn();
  const start = vi.fn(async () => { throw new Error("Fixture child start refused"); });
  const registry = {
    listThreads: async () => [],
    isIncompleteThreadList: () => false,
    withStackWorktreeMutation: (_dir: string, work: () => unknown) => work(),
    resolveThreadWorkspaceCwd: async () => cwd,
    onEvent: () => () => undefined,
    hasStackNotice: () => false,
    publishStackCompletion: publish,
    startThread: start,
  } as unknown as DesktopBackendRegistry;
  const service = new StackOperationsService();
  const scope = { repository, directories: [cwd], branch: "parent", infer: async () => [] };
  const { opId } = await service.call("apply_stack_operation",
    { operation: "add_branch", name: "child", newThread: true, carryChanges: true }, actor, scope, registry) as { opId: string };
  await expect.poll(async () => await service.call("manage_stack_operation", { action: "status", opId }, actor, scope, registry))
    .toMatchObject({ issue: { code: "post_apply_failed" } });
  const carryRef = `refs/pwragent/stack-carry/${opId}`;
  await git.output(["gc", "--prune=now"]);
  expect((await git.output(["show", `${carryRef}^3:carry.txt`])).trim()).toBe("Keep these edits");
  const restarted = new StackOperationsService();
  await expect(restarted.call("manage_stack_operation", { action: "abort", opId }, actor, scope, registry))
    .resolves.toMatchObject({ status: "done", undo: `refs/pwragent/undo/${opId}` });
  expect(start).toHaveBeenCalledTimes(1);
  expect(publish).toHaveBeenCalledWith(actor, opId, "add_branch", undefined, true);
  expect(await new GhStackCatalogStore().hasJournal(commonDir)).toBe(false);
  expect((await git.run(["show-ref", "--exists", carryRef])).exitCode).toBe(2);
  expect(await git.tip("child")).toBe(head);
  await expect(git.output(["cat-file", "-e", `refs/pwragent/undo/${opId}/receipt`])).resolves.toBe("");
  expect(await readFile(join(cwd, "carry.txt"), "utf8")).toBe("Keep these edits");
});
