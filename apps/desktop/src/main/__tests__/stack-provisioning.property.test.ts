import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, inject, it, onTestFinished, vi } from "vitest";
import { StackGit } from "@pwragent/owner-core/stacks/engine/git";
import type { DesktopBackendRegistry } from "../app-server/backend-registry";
import { GitDirectoryService } from "../app-server/git-directory-service";
import { GhStackCatalogStore, stackGitRunner, type RuntimeJournal } from "../stacks/stack-engine-ports";
import { StackOperationsService } from "../stacks/stack-operations-service";
import { resetDesktopOverlayStoreForTests, setDesktopOverlayStoreForTests } from "../storage/desktop-overlay-store";
import { SqliteOverlayStore } from "../storage/overlay-store-sqlite";
import { openInMemoryStateDb } from "./sqlite-test-utils";

vi.mock("../native-relay-path", () => ({ nativeRelayPath: () => inject("nativeHelperFixtures").stackEngine!.relay }));
vi.mock("../app-server/subthread-order-actions", () => ({ updateLocalSubthreadOrder: vi.fn() }));

const actor = { backend: "codex" as const, threadId: "lead" };
const child = { backend: "codex" as const, threadId: "accepted" };
type Fault = "before checkout" | "after checkout" | "after carry" | "lost acceptance" | "after acceptance";
const crashed = () => new Error("Injected host crash");

async function setupProvisioning(fault: Fault) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pwragent-stack-provision-")));
  const cwd = join(root, "repo");
  const db = openInMemoryStateDb();
  const storage = new SqliteOverlayStore(db);
  setDesktopOverlayStoreForTests(storage);
  onTestFinished(async () => {
    resetDesktopOverlayStoreForTests();
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  const git = new StackGit(stackGitRunner, root);
  await git.output(["init", "-b", "main", cwd]);
  const repo = new StackGit(stackGitRunner, cwd);
  await repo.output(["config", "user.email", "fixture@example.invalid"]);
  await repo.output(["config", "user.name", "Fixture"]);
  await repo.output(["config", "commit.gpgSign", "false"]);
  await writeFile(join(cwd, "tracked.txt"), "base\n");
  await repo.output(["add", "tracked.txt"]);
  await repo.output(["commit", "-m", "Fixture"]);
  const tip = (await repo.tip("main"))!;
  await repo.output(["switch", "-c", "parent"]);
  await writeFile(join(cwd, "tracked.txt"), "staged\n");
  await repo.output(["add", "tracked.txt"]);
  await writeFile(join(cwd, "tracked.txt"), "unstaged\n");
  await writeFile(join(cwd, "carry.txt"), "untracked\n");
  const unrelated = join(root, "unrelated");
  await repo.output(["worktree", "add", unrelated, "main"]);
  await writeFile(join(unrelated, "keep.txt"), "unrelated edit\n");
  const repository = "github.com:fixture/stack";
  await repo.output(["remote", "add", "origin", "https://github.com/fixture/stack.git"]);
  const commonDir = join(cwd, ".git");
  const journalPath = join(commonDir, "pwragent-stack-op.json");
  const readJournal = async () => JSON.parse(await readFile(journalPath, "utf8")) as RuntimeJournal;
  await writeFile(join(commonDir, "gh-stack"), JSON.stringify({
    schemaVersion: 1, repository, stacks: [{ trunk: { branch: "main", head: tip }, branches: [{ branch: "parent", head: tip, base: tip }] }],
  }));
  const directoryService = new GitDirectoryService({ resolveWorktreeStorage: () => "in-repo" });
  const workspaces = new Map<string, string>();
  const notices = new Map<string, string>();
  let shouldCrash = true;
  let checkout: string | undefined;
  let workspaceWrites = 0;
  const register = vi.fn(async (thread: typeof child, lead: typeof actor, path: string) => {
    await storage.setThreadParent({ ...thread, parentThreadId: lead.threadId, parentThreadBackend: lead.backend });
    await directoryService.recordCodexWorktreeOwnerThread({ worktreePath: path, threadId: thread.threadId, preserveExisting: true });
  });
  const accept = vi.fn(async () => {
    // The provider retains this thread even if the owner crashes before it
    // can publish a parent or worktree association.
    expect((await readJournal()).provisioning?.stage).toBe("admitting");
    workspaces.set(child.threadId, checkout!);
    if (shouldCrash && fault === "lost acceptance") throw crashed();
    return { threadId: child.threadId };
  });
  const start = vi.fn(async ({ stackWorktree }: Parameters<DesktopBackendRegistry["startThread"]>[0]) => {
    const workspace = await stackWorktree!.prepare();
    checkout = workspace.cwd!;
    if (shouldCrash && fault === "after carry") throw crashed();
    await stackWorktree!.admit(accept);
    if (shouldCrash && fault === "after acceptance") throw crashed();
    return child;
  });
  const registry = {
    listThreads: async () => [...workspaces].map(([id, path]) => ({ id, source: "codex", title: id, linkedDirectories: [{ path }] })),
    isIncompleteThreadList: () => false,
    stackThreadActive: () => false,
    withStackWorktreeMutation: <T>(dir: string, work: () => Promise<T>) => directoryService.withStackWorktreeMutation(dir, work),
    reserveStackWorktree: (...args: Parameters<GitDirectoryService["reserveStackWorktree"]>) => directoryService.reserveStackWorktree(...args),
    prepareStackWorktree: async (...args: Parameters<GitDirectoryService["prepareStackWorktree"]>) => {
      const [, reservation, options] = args;
      if (options.create) {
        expect((await readJournal()).provisioning).toMatchObject({ stage: "reserved", worktree: reservation });
        if (!(await lstat(join(reservation.path, ".git")).catch(() => undefined))) {
          if (shouldCrash && fault === "before checkout") throw crashed();
          workspaceWrites += 1;
        }
      }
      const workspace = await directoryService.prepareStackWorktree(...args);
      if (options.create && shouldCrash && fault === "after checkout") throw crashed();
      return workspace;
    },
    registerStackLayerThread: register,
    resolveThreadWorkspaceCwd: async () => cwd,
    onEvent: () => () => undefined,
    hasStackNotice: (_thread: typeof actor, id: string, branch = "") => notices.has(`${id}:${branch}`),
    publishStackNotice: vi.fn(async (_thread: typeof actor, notice: { opId: string; branch: string; completion?: { provisioningIssue?: string } }) => {
      notices.set(`${notice.opId}:${notice.branch}`, notice.completion?.provisioningIssue ?? "");
    }),
    publishStackCompletion: vi.fn(async (_thread: typeof actor, id: string) => { notices.set(`${id}:`, "done"); }),
    startThread: start,
    renameThread: vi.fn(),
  } as unknown as DesktopBackendRegistry;
  const service = new StackOperationsService();
  const scope = { repository, directories: [cwd], branch: "parent", infer: async () => [] };
  const { opId } = await service.call("apply_stack_operation",
    { operation: "add_branch", name: "child", newThread: true, carryChanges: true }, actor, scope, registry) as { opId: string };
  await expect.poll(() => service.call("manage_stack_operation", { action: "status", opId }, actor, scope, registry), { timeout: 5_000 })
    .toMatchObject({ status: "paused" });
  const beforeRestart = (await readJournal()).provisioning;
  expect(beforeRestart?.stage).not.toBe("pending");
  const reservation = beforeRestart && "worktree" in beforeRestart ? beforeRestart.worktree : undefined;
  expect(reservation).toBeDefined();
  const checkoutPath = reservation!.path;
  return {
    accept, checkoutPath, commonDir, cwd, notices, opId, register, registry, repo, scope, tip, unrelated,
    workspaceWrites: () => workspaceWrites,
    restart: async () => {
      shouldCrash = false;
      return await new StackOperationsService().resumeInterrupted([cwd], registry);
    },
  };
}

// Crash model: restart may repeat pre-admission work, but the committed
// operation may create at most one checkout and admit at most one provider.
it.each<Fault>(["before checkout", "after checkout", "after carry", "lost acceptance", "after acceptance"])(
  "reconciles an interrupted start %s against Git and provider state", async (fault) => {
    const fixture = await setupProvisioning(fault);
    const { accept, checkoutPath, commonDir, cwd, opId, notices, register, registry, repo, scope, tip, unrelated } = fixture;
    const checkoutBefore = await lstat(checkoutPath, { bigint: true });
    const pointerBefore = await lstat(join(checkoutPath, ".git")).catch(() => undefined);
    expect(Boolean(pointerBefore)).toBe(fault !== "before checkout");
    expect(register).not.toHaveBeenCalled();
    const errors = await fixture.restart();
    const admitted = fault === "lost acceptance" || fault === "after acceptance";
    expect(registry.startThread).toHaveBeenCalledTimes(admitted ? 1 : 2);
    expect(accept).toHaveBeenCalledTimes(1);
    expect(fixture.workspaceWrites()).toBe(1);
    const checkoutAfter = await lstat(checkoutPath, { bigint: true });
    expect(checkoutAfter.ino).toBe(checkoutBefore.ino);
    expect((await repo.output(["symbolic-ref", "HEAD"], undefined, checkoutPath)).trim()).toBe("refs/heads/child");
    expect((await repo.output(["rev-parse", "HEAD"], undefined, checkoutPath)).trim()).toBe(tip);
    const list = await repo.output(["worktree", "list", "--porcelain", "-z"]);
    expect(list.match(/branch refs\/heads\/child\0/g)).toHaveLength(1);
    for (const path of [cwd, checkoutPath]) {
      expect((await repo.output(["show", ":tracked.txt"], undefined, path)).trim()).toBe("staged");
      expect((await readFile(join(path, "tracked.txt"), "utf8")).trim()).toBe("unstaged");
      expect((await readFile(join(path, "carry.txt"), "utf8")).trim()).toBe("untracked");
    }
    expect((await readFile(join(unrelated, "keep.txt"), "utf8")).trim()).toBe("unrelated edit");
    const store = new GhStackCatalogStore();
    if (fault === "lost acceptance") {
      expect(errors).toEqual([expect.stringContaining("could not confirm the provider start")]);
      expect(register).not.toHaveBeenCalled();
      expect(notices.get(`${opId}::provisioning`)).toContain(checkoutPath);
      expect(await store.hasJournal(commonDir)).toBe(true);
      const restarted = new StackOperationsService();
      await expect(restarted.call("manage_stack_operation", { action: "continue", opId }, actor, scope, registry))
        .rejects.toMatchObject({ code: "stack_provisioning_uncertain" });
      expect(accept).toHaveBeenCalledTimes(1);
      await expect(restarted.call("manage_stack_operation", { action: "abort", opId }, actor, scope, registry))
        .resolves.toMatchObject({ status: "done" });
      expect((await repo.output(["show", `refs/pwragent/stack-carry/${opId}^3:carry.txt`])).trim()).toBe("untracked");
      expect((await lstat(checkoutPath, { bigint: true })).ino).toBe(checkoutAfter.ino);
    } else {
      expect(errors).toEqual([]);
      expect(register).toHaveBeenCalledExactlyOnceWith(child, actor, checkoutPath);
      expect(registry.publishStackCompletion).toHaveBeenCalledWith(actor, opId, "add_branch", child, undefined);
      expect(await fixture.restart()).toEqual([]);
      expect(register).toHaveBeenCalledTimes(1);
    }
    expect(await store.hasJournal(commonDir)).toBe(false);
  },
);

it.each(["directory", "owner", "branch", "tip"] as const)("keeps local files when the reserved checkout changes %s", async (change) => {
  const { accept, checkoutPath, commonDir, restart, repo } = await setupProvisioning("after checkout");
  const gitDir = (await repo.output(["rev-parse", "--absolute-git-dir"], undefined, checkoutPath)).trim();
  const marker = join(gitDir, "codex-thread.json");
  if (change === "owner") await writeFile(marker, JSON.stringify({ version: 1, ownerThreadId: "unrelated" }));
  if (change === "branch") await repo.output(["switch", "-c", "other"], undefined, checkoutPath);
  if (change === "tip") await repo.output(["commit", "--allow-empty", "-m", "Local commit"], undefined, checkoutPath);
  if (change === "directory") {
    await rename(checkoutPath, `${checkoutPath}.kept`);
    await mkdir(checkoutPath);
  }
  await writeFile(join(checkoutPath, "keep.txt"), "other owner's edit");
  expect(await restart()).toEqual([expect.stringContaining(change === "tip" ? "branch changed" : "Cannot verify the reserved stack worktree")]);
  expect(accept).not.toHaveBeenCalled();
  expect(await readFile(join(checkoutPath, "keep.txt"), "utf8")).toBe("other owner's edit");
  if (change === "owner") expect(JSON.parse(await readFile(marker, "utf8")).ownerThreadId).toBe("unrelated");
  expect(await new GhStackCatalogStore().hasJournal(commonDir)).toBe(true);
});
