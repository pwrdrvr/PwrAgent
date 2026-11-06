import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { stat, realpath, mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { WorktreeArchiveService } from "../app-server/worktree-archive-service";
import { resolveWorktreeRepositoryDirectory } from "../app-server/thread-directory-enricher";
import type { AppServerThreadSummary, LinkedDirectorySummary, ThreadOverlayState } from "@pwragent/shared";
import type { ArchiveCleanupIntent } from "../state/archive-cleanup-checkpoint";
import type { ArchiveCleanupContext } from "../app-server/archive-cleanup-queue";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import { CodexAppServerClient } from "../codex-app-server/desktop-client";
import { ArchiveCleanupTransport } from "./fixtures/archive-cleanup-transport";

vi.mock("../codex-app-server/stdio-transport", async () => ({
  StdioJsonRpcTransport: (await import("./fixtures/archive-cleanup-transport")).ArchiveCleanupTransport,
}));
vi.mock("../log", () => ({ getMainLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }));
vi.mock("../app-server/thread-assets", async (original) => ({
  ...await original<typeof import("../app-server/thread-assets")>(), deleteThreadAssets: async () => {},
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, stat: vi.fn(async (...args: Parameters<typeof actual.stat>) => {
    if (String(args[0]).startsWith("/fixture/")) throw Object.assign(new Error("Removed fixture"), { code: "ENOENT" });
    return await actual.stat(...args);
  }) };
});

type Row = { id: string; cwd: string };
type Noise = { archived: boolean; claude: boolean; cwd: number };
type CleanupBoundary = {
  enqueueArchiveCleanup(intent: ArchiveCleanupIntent): Promise<{ cleanup: Array<{ removedWorktree: boolean }> }>;
  completeArchivedThreadCleanup(params: { backend: "codex"; threadId: string; archivedAt: number;
    codexRolloutMissing: boolean; messagingCleanup: { error?: string }; context: ArchiveCleanupContext }): Promise<{ cleanup: Array<{ removedWorktree: boolean }> }>;
  findThreadForArchiveCleanup(params: { backend: "codex"; threadId: string; context: ArchiveCleanupContext }): Promise<{ thread: AppServerThreadSummary }>;
  worktreeArchiveService: WorktreeArchiveService;
  claudeBackend: { listThreads(params: { archived: boolean }): Promise<AppServerThreadSummary[]> };
};

const registries: DesktopBackendRegistry[] = [];
afterEach(async () => {
  await Promise.all(registries.splice(0).map((registry) => registry.close()));
  vi.mocked(stat).mockClear();
});

function worktree(cwd: string): LinkedDirectorySummary {
  return { id: cwd, kind: "worktree", label: "fixture", path: "/fixture/repository", worktreePath: cwd };
}

async function fixture(noise: Noise[], roots = 1, overlayOnly = false, real?: { cwd: string; repositoryPath: string }) {
  const candidates = real ? [real.cwd] : Array.from({ length: roots }, (_, i) => `/fixture/candidate-${i}`);
  const effects = { git: 0, workspace: 0 };
  const inspected = new Set<string>();
  const overlays = new Map<string, ThreadOverlayState>();
  if (roots > 1 || overlayOnly) overlays.set("target", { backend: "codex", threadId: "target",
    extraLinkedDirectories: candidates.slice(overlayOnly ? 0 : 1).map(worktree) });
  const client = new CodexAppServerClient({ threadDirectoryEnricher: async (cwd) => {
    effects.git += 1;
    if (real && cwd) {
      const directory = await resolveWorktreeRepositoryDirectory(cwd);
      return { linkedDirectories: directory ? [directory] : [] };
    }
    return { linkedDirectories: cwd && candidates.includes(cwd) ? [worktree(cwd)] : [] };
  } });
  await client.getInitializeResult();
  const transport = ArchiveCleanupTransport.latest;
  const rows: { active: Row[]; archived: Row[] } = { active: [], archived: [{ id: "target", cwd: overlayOnly ? "/fixture/primary" : candidates[0]! }] };
  const claude: { active: AppServerThreadSummary[]; archived: AppServerThreadSummary[] } = { active: [], archived: [] };
  noise.forEach((item, i) => {
    const row = { id: `noise-${i}`, cwd: `/fixture/unrelated-${item.cwd}` };
    const kind = item.archived ? "archived" : "active";
    if (item.claude) claude[kind].push({ id: row.id, source: "claude", title: row.id, titleSource: "explicit", projectKey: row.cwd, linkedDirectories: [] });
    else rows[kind].push(row);
  });
  transport.rows = rows;
  const readOverlays = async ({ backend, threadIds }: { backend: string; threadIds: string[] }) => {
    for (const id of threadIds) inspected.add(`${backend}:${id}`);
    return Object.fromEntries(threadIds.map((id) => [id, overlays.get(id)]));
  };
  const snapshots: Array<{ snapshot: { snapshotRef: string; worktreePath: string } }> = [];
  const store = new Proxy({ upsertWorktreeSnapshot: async (params: typeof snapshots[number]) => { snapshots.push(params); },
    getArchiveCleanupOverlayStates: readOverlays, getThreadOverlayStates: readOverlays,
    getThreadOverlayState: async ({ threadId }: { threadId: string }) => overlays.get(threadId),
  }, { get(object, key) {
    if (key === "then") return undefined;
    if (key in object) return object[key as keyof typeof object];
    return async () => String(key).startsWith("list") ? [] : undefined;
  } });
  let removed = 0;
  const archive = vi.fn(async (params: { backend: string; threadId: string; worktreePath: string; beforeRemove?: () => Promise<() => void> }) => {
    const guard = await params.beforeRemove!();
    guard();
    removed += 1;
    return { id: `snapshot-${removed}`, ...params, repositoryPath: "/fixture/repository", snapshotRef: "refs/codex/snapshots/test",
      snapshotCommit: "abc", createdAt: 1, archivedAt: 2, state: "archived", ignoredFilesExcluded: true };
  });
  const registry = new DesktopBackendRegistry({ codexClient: client, overlayStore: store as never,
    worktreeArchiveService: real ? new WorktreeArchiveService() : { archive } as never, threadTitleGenerationService: null,
    acpWorktreeRepositoryResolver: async () => { effects.workspace += 1; return undefined; },
  });
  registries.push(registry);
  const boundary = registry as unknown as CleanupBoundary;
  vi.spyOn(boundary.claudeBackend, "listThreads").mockImplementation(async ({ archived }) => claude[archived ? "archived" : "active"]);
  let checkpoints = 0;
  const context: ArchiveCleanupContext = { batch: {}, assertCurrent() {}, checkpoint: async () => { checkpoints += 1; }, settleCheckpoint: async () => {} };
  const cleanup = async () => await boundary.completeArchivedThreadCleanup({ backend: "codex", threadId: "target", archivedAt: 1,
    codexRolloutMissing: false, messagingCleanup: {}, context });
  return { registry, boundary, client, transport, rows, claude, overlays, effects, inspected, archive, context, cleanup, snapshots,
    get removed() { return removed; }, get checkpoints() { return checkpoints; } };
}

async function measure(noise: Noise[], roots = 1, overlayOnly = false) {
  const run = await fixture(noise, roots, overlayOnly);
  try {
    const result = await run.cleanup();
    expect(result.cleanup.filter((item) => item.removedWorktree)).toHaveLength(roots);
    expect(run.inspected).toContain("codex:target");
    noise.forEach((item, i) => expect(run.inspected).toContain(`${item.claude ? "claude" : "codex"}:noise-${i}`));
    return { ...run.effects };
  } finally { await run.registry.close(); }
}

describe("single archive discovery isolation", () => {
  it("one disjoint archived cwd cannot add a Git discovery (shrunk regression)", async () => {
    expect(await measure([{ archived: false, claude: false, cwd: 0 }])).toEqual(await measure([]));
    expect(await measure([{ archived: true, claude: false, cwd: 0 }])).toEqual(await measure([]));
  });

  it("adding disjoint active/archived identities preserves the expensive-work bound", async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.record({ archived: fc.boolean(), claude: fc.boolean(), cwd: fc.integer({ min: 0, max: 110 }) }), { minLength: 1, maxLength: 120 }),
      fc.integer({ min: 1, max: 3 }), fc.boolean(),
      async (noise, roots, overlayOnly) => {
        expect(await measure(noise, roots, overlayOnly)).toEqual(await measure([], roots, overlayOnly));
      },
    ), { numRuns: 25 });
  });
});

it("shares identities across candidate roots without reusing another root's enrichment", async () => {
  const run = await fixture([]);
  try {
    run.rows.archived.push({ id: "second", cwd: "/fixture/second" });
    run.overlays.set("second", { backend: "codex", threadId: "second", extraLinkedDirectories: [worktree("/fixture/second")] });
    const first = await run.boundary.findThreadForArchiveCleanup({ backend: "codex", threadId: "target", context: run.context });
    const pages = run.transport.listings.length;
    const discoveries = run.effects.git;
    const second = await run.boundary.findThreadForArchiveCleanup({ backend: "codex", threadId: "second", context: run.context });
    expect(run.transport.listings).toHaveLength(pages);
    expect(run.effects.git).toBeGreaterThan(discoveries);
    expect(first.thread.id).toBe("target");
    expect(second.thread.linkedDirectories).toContainEqual(worktree("/fixture/second"));
    // A directory write invalidates the identity proof too, even in one batch.
    // The batch's fleet index reads that identity's provider row again rather
    // than every identity: the write names the thread it changed.
    const reads = vi.spyOn(run.client, "readArchiveCleanupThreadSummary");
    await run.registry.withThreadWorkspaceMutation({ backend: "codex", threadId: "second" }, async () => {});
    await run.boundary.findThreadForArchiveCleanup({ backend: "codex", threadId: "second", context: run.context });
    expect(reads).toHaveBeenCalledWith("second", expect.any(Function));
  } finally { await run.registry.close(); }
});

it("bounds a 1876-identity single archive to candidate discovery plus fresh admission", async () => {
  const noise = Array.from({ length: 1875 }, (_, cwd) => ({ cwd, archived: cwd >= 399, claude: false }));
  const run = await fixture(noise);
  try {
    await run.cleanup();
    expect(run.removed).toBe(1);
    expect(run.inspected.size).toBe(1876);
    expect({ ...run.effects, providerPages: run.transport.listings.length }).toEqual({ git: 2, workspace: 0, providerPages: 38 });
  } finally { await run.registry.close(); }
});

// The model is a set of reasons a checkout must survive. Operations update the
// provider/overlay owner, not production predicates. Snapshot preparation is an
// explicit scheduling boundary: discovery has completed, admission has not.
it("matches an owner/reference model across late lifecycle and directory events", async () => {
  const operation = fc.constantFrom("attach", "detach", "restore", "rearchive", "external", "adopt", "fail", "recover", "unrelated");
  await fc.assert(fc.asyncProperty(fc.array(operation, { maxLength: 16 }), fc.scheduler(), async (operations, scheduler) => {
    const run = await fixture([]);
    const blockers = new Set<string>();
    let failedRead = false;
    const originalRead = run.client.listArchiveCleanupThreadsPage.bind(run.client);
    vi.spyOn(run.client, "listArchiveCleanupThreadsPage").mockImplementation(async (params) => {
      if (failedRead) throw new Error("Safety read unavailable");
      return await originalRead(params);
    });
    run.context.checkpoint = async () => { await scheduler.schedule(Promise.resolve(), "cleanup checkpoint"); };
    const originalArchive = run.archive.getMockImplementation()!;
    run.archive.mockImplementationOnce(async (params) => {
      for (const op of operations) {
        if (op === "attach" || op === "detach") {
          run.rows.active = run.rows.active.filter((row) => row.id !== "owner");
          if (op === "attach") { blockers.add("shared"); run.rows.active.push({ id: "owner", cwd: "/fixture/candidate-0/child" }); }
          else blockers.delete("shared");
        } else if (op === "restore" || op === "rearchive") {
          run.rows.active = run.rows.active.filter((row) => row.id !== "target");
          run.rows.archived = run.rows.archived.filter((row) => row.id !== "target");
          run.rows[op === "restore" ? "active" : "archived"].push({ id: "target", cwd: "/fixture/candidate-0" });
          if (op === "restore") blockers.add("restored"); else blockers.delete("restored");
        } else if (op === "external" || op === "adopt") {
          if (op === "external") {
            blockers.add("external");
            run.rows.archived = run.rows.archived.filter((row) => row.id !== "external");
            run.rows.archived.push({ id: "external", cwd: "/fixture/elsewhere" });
            run.overlays.set("external", { backend: "codex", threadId: "external", extraLinkedDirectories: [{ ...worktree("/fixture/candidate-0"), worktreeOwnership: "external" }] });
          } else { blockers.delete("external"); run.overlays.delete("external"); }
        } else if (op === "fail" || op === "recover") {
          failedRead = op === "fail";
          if (failedRead) blockers.add("failed read"); else blockers.delete("failed read");
        } else {
          // Unrelated activity continues even at the final removal checkpoint.
          await run.registry.publishLocalEvent({ backend: "codex", notification: { method: "navigation/threadDirectories/updated", params: { reason: "selected-thread", threadIds: ["unrelated"] } } });
        }
      }
      return await originalArchive(params);
    });
    try {
      await scheduler.waitFor(run.cleanup());
      expect(run.removed).toBe(blockers.size ? 0 : 1);
      if (blockers.size) {
        // Release every final blocker. A new queue drain reads fresh evidence;
        // unrelated directory notifications need not stop for it to finish.
        failedRead = false;
        run.rows.active = [];
        run.rows.archived = [{ id: "target", cwd: "/fixture/candidate-0" }];
        run.overlays.clear();
        run.context.batch = {};
        await run.registry.publishLocalEvent({ backend: "codex", notification: { method: "navigation/threadDirectories/updated", params: { reason: "selected-thread", threadIds: ["unrelated"] } } });
        await scheduler.waitFor(run.cleanup());
        expect(run.removed).toBe(1);
      }
    } finally { await run.registry.close(); }
  }), { numRuns: 30 });
});

it.each([true, false])("an unresolved %s-relevant mutation cannot admit removal", async (relevant) => {
  const run = await fixture([]);
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const archive = run.archive.getMockImplementation()!;
  let mutation: Promise<unknown> | undefined;
  run.rows.active.push({ id: "writer", cwd: "/fixture/unrelated" });
  run.archive.mockImplementationOnce(async (params) => {
    mutation = run.registry.withThreadLifecycleMutation({ backend: "codex", threadId: "writer",
      worktreePath: relevant ? "/fixture/candidate-0" : "/fixture/unrelated" }, async () => { entered(); await gate; });
    await started;
    return await archive(params);
  });
  try {
    await run.cleanup();
    expect(run.removed).toBe(relevant ? 0 : 1);
  } finally { release(); await mutation; await run.registry.close(); }
});

const execFileAsync = promisify(execFile);
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-c", "maintenance.autoDetach=false", "-c", "gc.autoDetach=false", "-C", cwd, ...args]);
  return stdout.trim();
}

it("uses real Git and canonical paths as the snapshot/removal oracle at the changed boundary", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-scoped-oracle-")));
  const repo = path.join(root, "repo");
  await mkdir(repo);
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "Fixture");
  await git(repo, "config", "user.email", "fixture@example.com");
  await git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "--allow-empty", "-m", "initial");
  const unrelated = path.join(root, "unrelated");
  const unrelatedAlias = path.join(root, "unrelated-alias");
  await mkdir(unrelated);
  await symlink(unrelated, unrelatedAlias, process.platform === "win32" ? "junction" : "dir");
  let sequence = 0;
  try {
    await fc.assert(fc.asyncProperty(fc.constantFrom("eligible", "alias-owner", "descendant-owner", "external-alias", "primary", "locked"), fc.string({ minLength: 1, maxLength: 25 }), async (kind, contents) => {
      const checkout = path.join(root, `checkout-${sequence++}`);
      await git(repo, "worktree", "add", "--detach", checkout);
      const target = kind === "primary" ? repo : checkout;
      const alias = path.join(root, `alias-${sequence}`);
      await symlink(checkout, alias, process.platform === "win32" ? "junction" : "dir");
      await mkdir(path.join(checkout, "child"));
      await writeFile(path.join(target, "preserved.txt"), contents);
      if (kind === "locked") await git(repo, "worktree", "lock", checkout);
      const run = await fixture([], 1, false, { cwd: target, repositoryPath: repo });
      const previousRefs = new Set((await git(repo, "for-each-ref", "--format=%(refname)", "refs/codex/snapshots/")).split("\n"));
      const service = run.boundary.worktreeArchiveService;
      const archive = service.archive.bind(service);
      vi.spyOn(service, "archive").mockImplementation(async (params) => await archive({ ...params, beforeRemove: async () => {
        const refs = (await git(repo, "for-each-ref", "--format=%(refname)", "refs/codex/snapshots/")).split("\n").filter((ref) => !previousRefs.has(ref));
        expect(refs).toHaveLength(1);
        expect(await git(repo, "show", `${refs[0]}:preserved.txt`)).toBe(contents.trim());
        expect(await readFile(path.join(target, "preserved.txt"), "utf8")).toBe(contents);
        return await params.beforeRemove!();
      } }));
      if (kind === "alias-owner" || kind === "descendant-owner") run.rows.active.push({ id: "owner", cwd: kind === "alias-owner" ? alias : path.join(alias, "child") });
      if (kind === "external-alias") {
        run.rows.archived.push({ id: "external", cwd: alias });
        run.overlays.set("external", { backend: "codex", threadId: "external", extraLinkedDirectories: [{ ...worktree(alias), path: repo, worktreeOwnership: "external" }] });
      }
      try {
        await run.boundary.findThreadForArchiveCleanup({ backend: "codex", threadId: "target", context: run.context });
        const baselineDiscoveries = run.effects.git;
        run.rows.active.push({ id: "noise-alias", cwd: unrelatedAlias }, { id: "noise-repeat", cwd: unrelatedAlias });
        run.rows.archived.push({ id: "noise-real", cwd: unrelated });
        run.context.batch = {};
        await run.boundary.findThreadForArchiveCleanup({ backend: "codex", threadId: "target", context: run.context });
        expect(run.effects.git).toBe(2 * baselineDiscoveries);
        for (const id of ["noise-alias", "noise-repeat", "noise-real"]) expect(run.inspected).toContain(`codex:${id}`);
        const result = await run.cleanup();
        const removed = result.cleanup.some((item) => item.removedWorktree);
        expect(removed).toBe(kind === "eligible");
        const worktrees = await git(repo, "worktree", "list", "--porcelain");
        if (removed) {
          expect(worktrees).not.toContain(checkout.replaceAll("\\", "/"));
          expect(run.snapshots).toHaveLength(1);
          expect(await git(repo, "show", `${run.snapshots[0]!.snapshot.snapshotRef}:preserved.txt`)).toBe(contents.trim());
        } else {
          expect(await readFile(path.join(target, "preserved.txt"), "utf8")).toBe(contents);
          expect(worktrees).toContain(checkout.replaceAll("\\", "/"));
        }
      } finally { await run.registry.close(); }
    }), { numRuns: 4, examples: [
      ["eligible", "snapshot"], ["alias-owner", "keep"], ["descendant-owner", "keep"],
      ["external-alias", "keep"], ["primary", "keep"], ["locked", "keep"],
    ] });
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Inject only the queue's scheduling effect. Registry reference tracking,
// dispatch, provider/overlay reads, lifecycle fences and admission remain real.
// The production pacer's serialization/cancellation has its own queue suite.
function scheduledQueue(context: ArchiveCleanupContext) {
  const jobs = new Map<string, { promise: Promise<unknown>; cancelled: boolean }>();
  return {
    get availableSlots() { return 256 - jobs.size; },
    pending: (key: string) => jobs.get(key)?.promise,
    pendingKeys: () => [...jobs.keys()],
    isCancelled: (key: string) => jobs.get(key)?.cancelled === true,
    enqueue(key: string, work: (context: ArchiveCleanupContext) => Promise<unknown>) {
      if (jobs.has(key)) return jobs.get(key)!.promise;
      const job = { promise: Promise.resolve() as Promise<unknown>, cancelled: false };
      job.promise = Promise.resolve().then(async () => await work({ ...context, batch: {}, assertCurrent: () => {
        if (job.cancelled) throw new Error("Cancelled fixture cleanup");
      } })).finally(() => { jobs.delete(key); });
      jobs.set(key, job);
      return job.promise;
    },
    cancel(key: string) { const job = jobs.get(key); if (job) job.cancelled = true; },
    async cancelAndWait(key: string) { this.cancel(key); await jobs.get(key)?.promise.catch(() => {}); },
    async close() { await Promise.all([...jobs.keys()].map(async (key) => { await this.cancelAndWait(key); })); },
  };
}

it("automatically completes once after the last owner releases while unrelated events continue", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 4 }),
    fc.array(fc.record({ owner: fc.integer({ min: 0, max: 3 }), attached: fc.boolean(), duplicate: fc.boolean() }), { maxLength: 12 }),
    fc.scheduler(), async (count, events, scheduler) => {
      const run = await fixture([]);
      const owners = new Set(Array.from({ length: count }, (_, i) => i));
      const unrelated = { id: "unrelated", cwd: "/fixture/active-elsewhere" };
      run.rows.active = [...owners].map((i) => ({ id: `owner-${i}`, cwd: "/fixture/candidate-0" })).concat(unrelated);
      const context: ArchiveCleanupContext = { ...run.context, checkpoint: async () => {
        await run.registry.publishLocalEvent({ backend: "codex", notification: { method: "navigation/threadDirectories/updated", params: { reason: "selected-thread", threadIds: ["unrelated"] } } });
        await scheduler.schedule(Promise.resolve(), "paced cleanup with unrelated activity");
      } };
      Object.assign(run.registry, { archiveCleanupQueue: scheduledQueue(context) });
      let completions = 0;
      let finish!: () => void;
      const completed = new Promise<void>((resolve) => { finish = resolve; });
      run.registry.onEvent((event) => {
        if (event.notification.method === "thread/archiveCleanup/completed"
          && Array.isArray(event.notification.params.cleanup)
          && event.notification.params.cleanup.some((item: { removedWorktree?: boolean }) => item.removedWorktree)) { completions += 1; finish(); }
      });
      const notify = async (owner: number) => {
        await run.registry.publishLocalEvent({ backend: "codex", notification: { method: "navigation/threadDirectories/updated", params: { reason: "selected-thread", threadIds: [`owner-${owner}`] } } });
      };
      const writeOwner = (owner: number, attached: boolean) => {
        if (attached) owners.add(owner); else owners.delete(owner);
        run.rows.active = [...owners].map((i) => ({ id: `owner-${i}`, cwd: "/fixture/candidate-0" })).concat(unrelated);
        // A released owner still exists elsewhere; its current cwd, rather
        // than an event's historical payload, is the ownership oracle.
        for (let i = 0; i < count; i++) if (!owners.has(i)) run.rows.active.push({ id: `owner-${i}`, cwd: `/fixture/released-${i}` });
      };
      try {
        await scheduler.waitFor(run.boundary.enqueueArchiveCleanup({ backend: "codex", threadId: "target", archivedAt: 1, codexRolloutMissing: false, messagingCleanup: {} }));
        expect(run.removed).toBe(0);
        for (const event of events) {
          if (run.removed) break;
          const owner = event.owner % count;
          writeOwner(owner, event.attached);
          await scheduler.waitFor(notify(owner));
          if (event.duplicate) await scheduler.waitFor(notify(owner));
          await scheduler.waitAll();
          if (owners.size) expect(run.removed).toBe(0);
        }
        if (!run.removed) {
          for (let i = 0; i < count; i++) {
            writeOwner(i, false);
            await scheduler.waitFor(notify(i));
          }
          await scheduler.waitFor(completed);
        }
        await scheduler.waitAll();
        expect(run.removed).toBe(1);
        expect(completions).toBe(1);
      } finally { await scheduler.waitFor(run.registry.close()); }
    }), { numRuns: 25 });
});
