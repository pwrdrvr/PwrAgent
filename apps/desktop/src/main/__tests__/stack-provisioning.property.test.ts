import { AsyncLocalStorage } from "node:async_hooks";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, inject, it, onTestFinished, vi } from "vitest";
import { StackGit } from "@pwragent/owner-core/stacks/engine/git";
import { ThreadStartNotAdmittedError } from "@pwragent/owner-core/thread-creation-lifecycle";
import type { DesktopBackendRegistry } from "../app-server/backend-registry";
import { GitDirectoryService } from "../app-server/git-directory-service";
import { GhStackCatalogStore, stackGitRunner, type RuntimeJournal } from "../stacks/stack-engine-ports";
import { StackOperationsService } from "../stacks/stack-operations-service";
import { getDesktopOverlayStore } from "../storage/desktop-overlay-store";
import { SqliteOverlayStore } from "../storage/overlay-store-sqlite";
import { openInMemoryStateDb } from "./sqlite-test-utils";
import { traceStackProvisioning } from "./helpers/stack-provisioning-trace";

const caseOverlay = new AsyncLocalStorage<SqliteOverlayStore>();

vi.mock("../state/app-state", async (importOriginal) => ({
  ...await importOriginal<typeof import("../state/app-state")>(),
  getAppOverlayStore: () => {
    const storage = caseOverlay.getStore();
    if (!storage) throw new Error("Stack provisioning requires a case-owned overlay store");
    return storage;
  },
}));
vi.mock("../native-relay-path", () => ({ nativeRelayPath: () => inject("nativeHelperFixtures").stackEngine!.relay }));
vi.mock("../app-server/subthread-order-actions", () => ({ updateLocalSubthreadOrder: vi.fn() }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, link: vi.fn(fs.link) };
});

const actor = { backend: "codex" as const, threadId: "lead" };
const child = { backend: "codex" as const, threadId: "accepted" };
type Fault = "before checkout" | "after checkout" | "after carry" | "lost acceptance" | "after acceptance"
  | "unlisted empty session" | "vanished empty session" | "definite refusal" | "failed hook";
const crashed = () => new Error("Injected host crash");

it("keeps each case's overlay when an earlier case finishes late", async () => {
  const earlierDb = openInMemoryStateDb();
  const laterDb = openInMemoryStateDb();
  const earlierStore = new SqliteOverlayStore(earlierDb);
  const laterStore = new SqliteOverlayStore(laterDb);
  const finishEarlier = Promise.withResolvers<void>();
  const earlier = caseOverlay.run(earlierStore, async () => {
    try {
      await finishEarlier.promise;
      return getDesktopOverlayStore();
    } finally {
      earlierDb.close();
    }
  });
  try {
    await caseOverlay.run(laterStore, async () => {
      finishEarlier.resolve();
      const earlierOverlay = await earlier;
      expect(getDesktopOverlayStore()).toBe(laterStore);
      expect(earlierOverlay).toBe(earlierStore);
    });
  } finally {
    laterDb.close();
  }
});

async function withProvisioning(fault: Fault, check: (fixture: Awaited<ReturnType<typeof setupProvisioning>>) => Promise<void>) {
  const service = new StackOperationsService();
  let root: string | undefined;
  let db: ReturnType<typeof openInMemoryStateDb> | undefined;
  let trace: ReturnType<typeof traceStackProvisioning> | undefined;
  let finished = false;
  onTestFinished(async ({ task }) => {
    finished = true;
    trace?.finish(task.result?.state === "fail");
    // Vitest can finish a timed-out test while its async body still owns the fixture.
    await Promise.allSettled([work]);
    await service.drainBackgroundRuns();
    db?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });
  const work = (async () => {
    root = await mkdtemp(join(tmpdir(), "pwragent-stack-provision-"));
    const canonicalRoot = await realpath(root);
    if (finished) return;
    db = openInMemoryStateDb();
    const storage = new SqliteOverlayStore(db);
    const activeTrace = traceStackProvisioning(canonicalRoot, join(canonicalRoot, "repo", ".git"), fault);
    trace = activeTrace;
    await caseOverlay.run(storage, () => setupProvisioning(fault, canonicalRoot, storage, service, activeTrace).then(check));
  })();
  await work;
}

async function setupProvisioning(fault: Fault, root: string, storage: SqliteOverlayStore, service: StackOperationsService,
  trace: ReturnType<typeof traceStackProvisioning>) {
  const holdCheckout = fault === "lost acceptance" ? {
    reached: Promise.withResolvers<void>(), release: Promise.withResolvers<void>(),
  } : undefined;
  const cwd = join(root, "repo");
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
  if (fault === "failed hook") {
    const hooks = join(root, "hooks");
    await mkdir(hooks);
    const hook = join(hooks, "post-checkout");
    await writeFile(hook, "#!/bin/sh\nprintf kept > hook-edit.txt\nexit 1\n");
    await chmod(hook, 0o755);
    await repo.output(["config", "core.hooksPath", hooks]);
  }
  const repository = "github.com:fixture/stack";
  await repo.output(["remote", "add", "origin", "https://github.com/fixture/stack.git"]);
  const commonDir = await realpath(join(cwd, ".git"));
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
    expect((await readJournal()).provisioning?.stage).toBe("admitting");
    trace.phase("provider start");
    if (shouldCrash && fault === "definite refusal") throw new ThreadStartNotAdmittedError(crashed());
    const threadId = !shouldCrash && fault === "vanished empty session" ? "replacement" : child.threadId;
    workspaces.set(threadId, checkout!);
    if (shouldCrash && fault === "lost acceptance") {
      trace.record("provider accepted without a receipt");
      throw crashed();
    }
    return { threadId, codexHome: root };
  });
  const start = vi.fn(async ({ stackWorktree }: Parameters<DesktopBackendRegistry["startThread"]>[0]) => {
    trace.phase("prepare");
    const workspace = await stackWorktree!.prepare();
    checkout = workspace.cwd!;
    trace.record("checkout and carry prepared");
    if (shouldCrash && fault === "after carry") throw crashed();
    trace.phase("admission checks");
    await stackWorktree!.admit(accept);
    trace.record("provider receipt persisted");
    if (shouldCrash && (fault === "after acceptance" || fault === "vanished empty session" || fault === "unlisted empty session")) throw crashed();
    return child;
  });
  const registry = {
    listThreads: async () => fault === "unlisted empty session" ? [] :
      [...workspaces].map(([id, path]) => ({ id, source: "codex", title: id, linkedDirectories: [{ path }] })),
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
          if (shouldCrash && holdCheckout) {
            trace.record("checkout held at reserved checkpoint");
            holdCheckout.reached.resolve();
            await holdCheckout.release.promise;
          }
          workspaceWrites += 1;
        }
      }
      const workspace = await directoryService.prepareStackWorktree(...args);
      trace.record("checkout verified", { create: options.create });
      if (options.create && shouldCrash && fault === "after checkout") throw crashed();
      return workspace;
    },
    registerStackLayerThread: register,
    inspectCodexStackThread: async ({ threadId }: typeof child, _worktree: string, priorHome?: string) =>
      workspaces.has(threadId) ? "present" : priorHome === root ? "missing" : "unverified",
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
  const scope = { repository, directories: [cwd], branch: "parent", infer: async () => [] };
  const { opId } = await service.call("apply_stack_operation",
    { operation: "add_branch", name: "child", newThread: true, carryChanges: fault !== "failed hook" }, actor, scope, registry) as { opId: string };
  const drained = service.drainBackgroundRuns();
  if (holdCheckout) {
    try {
      await Promise.race([holdCheckout.reached.promise, drained.then(() => {
        throw new Error("The attempt settled before reaching the reserved checkout.");
      })]);
      const state = await service.call("manage_stack_operation", { action: "status", opId }, actor, scope, registry);
      trace.record("status while checkout is held", { state });
      expect(state).toMatchObject({ status: "running", moved: [{ branch: "child", from: null, to: tip }] });
      expect(await readJournal()).toMatchObject({ committed: true, provisioning: { stage: "reserved" } });
    } finally { holdCheckout.release.resolve(); }
  }
  await drained;
  const state = await service.call("manage_stack_operation", { action: "status", opId }, actor, scope, registry) as {
    status: string; issue?: { code: string };
  };
  trace.record("attempt settled", { status: state.status, issue: state.issue?.code });
  expect(state).toMatchObject({ status: "paused", issue: { code: "post_apply_failed" } });
  const journal = await readJournal();
  const stage = {
    "before checkout": "reserved", "after checkout": "reserved", "after carry": "reserved",
    "lost acceptance": "admitting", "after acceptance": "accepted", "unlisted empty session": "accepted",
    "vanished empty session": "accepted", "definite refusal": "reserved", "failed hook": "checkout_failed",
  }[fault];
  expect(journal).toMatchObject({ committed: true, provisioning: { stage } });
  const beforeRestart = journal.provisioning;
  const reservation = beforeRestart && "worktree" in beforeRestart ? beforeRestart.worktree : undefined;
  expect(reservation).toBeDefined();
  const checkoutPath = reservation!.path;
  return {
    accept, checkoutPath, commonDir, cwd, notices, opId, register, registry, repo, scope, tip, unrelated,
    workspaceWrites: () => workspaceWrites,
    restart: async () => {
      shouldCrash = false;
      if (fault === "vanished empty session") workspaces.delete(child.threadId);
      trace.phase("restart");
      const errors = await new StackOperationsService("restarted-owner").resumeInterrupted([cwd], registry);
      trace.record("restart settled", { errors: errors.length, journalRetained: await new GhStackCatalogStore().hasJournal(commonDir) });
      return errors;
    },
  };
}

// Crash model: restart may repeat pre-admission work, but the committed
// operation may create only one checkout and retain only one provider thread.
it.each<Fault>(["before checkout", "after checkout", "after carry", "lost acceptance", "after acceptance", "unlisted empty session"])(
  "reconciles an interrupted start %s against Git and provider state", (fault) => withProvisioning(fault, async (fixture) => {
    const { accept, checkoutPath, commonDir, cwd, opId, notices, register, registry, repo, scope, tip, unrelated } = fixture;
    const checkoutBefore = await lstat(checkoutPath, { bigint: true });
    const pointerBefore = await lstat(join(checkoutPath, ".git")).catch(() => undefined);
    expect(Boolean(pointerBefore)).toBe(fault !== "before checkout");
    expect(register).not.toHaveBeenCalled();
    const errors = await fixture.restart();
    const admitted = fault === "lost acceptance" || fault === "after acceptance" || fault === "unlisted empty session";
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
  }),
);

it.each(["vanished empty session", "definite refusal"] as const)("reuses the checkout after %s", (fault) => withProvisioning(fault, async (fixture) => {
  const { accept, checkoutPath, commonDir, register, restart, workspaceWrites } = fixture;
  expect(await restart()).toEqual([]);
  expect(workspaceWrites()).toBe(1);
  expect(accept).toHaveBeenCalledTimes(2);
  const recoveredChild = fault === "vanished empty session" ? { ...child, threadId: "replacement" } : child;
  expect(register).toHaveBeenCalledExactlyOnceWith(recoveredChild, actor, checkoutPath);
  expect(await readFile(join(checkoutPath, "carry.txt"), "utf8")).toContain("untracked");
  expect(await new GhStackCatalogStore().hasJournal(commonDir)).toBe(false);
}));

it("keeps a registered checkout held after its post-checkout hook fails", () => withProvisioning("failed hook", async (fixture) => {
  const { accept, checkoutPath, commonDir, restart, repo } = fixture;
  // The Git oracle confirms HEAD and the hook's file outlive the failed add.
  expect((await repo.output(["symbolic-ref", "HEAD"], undefined, checkoutPath)).trim()).toBe("refs/heads/child");
  expect(await restart()).toEqual([expect.stringContaining("checkout setup failed")]);
  expect(accept).not.toHaveBeenCalled();
  expect(await readFile(join(checkoutPath, "hook-edit.txt"), "utf8")).toBe("kept");
  expect(await new GhStackCatalogStore().hasJournal(commonDir)).toBe(true);
}));

it("publishes a complete owner marker atomically and preserves competing owners", () => withProvisioning("after checkout", async (fixture) => {
  const { checkoutPath, repo } = fixture;
  const gitDir = (await repo.output(["rev-parse", "--absolute-git-dir"], undefined, checkoutPath)).trim();
  const marker = join(gitDir, "codex-thread.json");
  const directoryService = new GitDirectoryService();
  const record = (threadId: string) => directoryService.recordCodexWorktreeOwnerThread({
    worktreePath: checkoutPath, threadId, preserveExisting: true,
  });
  vi.mocked(link).mockRejectedValueOnce(crashed());
  await expect(record(child.threadId)).rejects.toThrow("Injected host crash");
  await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  const claims = await Promise.allSettled([record(child.threadId), record("other")]);
  const owner = claims[0]?.status === "fulfilled" ? child.threadId : "other";
  expect(claims.map(({ status }) => status).sort()).toEqual(["fulfilled", "rejected"]);
  expect(JSON.parse(await readFile(marker, "utf8"))).toEqual({ version: 1, ownerThreadId: owner });
  await expect(record(owner)).resolves.toBeUndefined();
}));

it.each(["directory", "owner", "branch", "tip"] as const)("keeps local files when the reserved checkout changes %s", (change) => withProvisioning("after checkout", async (fixture) => {
  const { accept, checkoutPath, commonDir, restart, repo } = fixture;
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
}));
