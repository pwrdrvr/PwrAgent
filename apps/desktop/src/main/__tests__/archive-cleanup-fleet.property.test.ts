import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import type { LinkedDirectorySummary } from "@pwragent/shared";
import { ARCHIVE_CLEANUP_PAUSE_MS } from "../app-server/archive-cleanup-queue";
import type { DesktopBackendRegistry } from "../app-server/backend-registry";
import { ArchiveCleanupCheckpointStore } from "../state/archive-cleanup-checkpoint";
import { StateDb } from "../state/state-db";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";
import { buildFleetRegistry, raw, resolveFleetAlias, worktree, type Fleet } from "./fixtures/archive-fleet-harness";

/**
 * Model of bulk archive cleanup against an independent ownership oracle.
 *
 * The world is the provider's rows and the overlay store: the systems that own
 * which thread uses which checkout. The oracle reads them directly and knows
 * nothing about the fleet index, reference waits, the queue or checkpoints.
 * fast-check generates attach, detach, workspace move, archive, external
 * restore, delete, restart and pacer steps, interleaved with cleanup at every
 * checkpoint and between removal admission and `git worktree remove`.
 *
 * - Safety: at the instant of removal, no active thread uses the checkout.
 * - Liveness: once cleanup is idle, every checkout with an archived owner and
 *   no active user has been removed; no final release is lost.
 * - Restoration: every archived owner of a removed checkout holds a snapshot.
 */

const fsModel = vi.hoisted(() => ({
  removed: new Set<string>(),
  aliases: new Map<string, string>(),
  realpathCalls: 0,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const path = await import("node:path");
  // Production resolves paths natively: on Windows "/contrived/x" arrives as
  // "D:\\contrived\\x". Map into this POSIX model, and answer natively.
  const toModel = (value: string) => process.platform === "win32"
    ? value.replace(/^[A-Za-z]:/, "").replace(/\\/g, "/").toLowerCase() : value;
  const toNative = (value: string) => process.platform === "win32" ? path.resolve(value) : value;
  // Mirrors resolveFleetAlias; a mock factory cannot import the harness.
  const resolveAlias = (value: string) => {
    for (const [alias, target] of fsModel.aliases) {
      if (value === alias || value.startsWith(alias + "/")) return target + value.slice(alias.length);
    }
    return value;
  };
  return {
    ...actual,
    realpath: vi.fn(async (filePath: Parameters<typeof actual.realpath>[0]) => {
      if (typeof filePath === "string" && toModel(filePath).startsWith("/contrived")) {
        fsModel.realpathCalls += 1;
        const resolved = resolveAlias(toModel(filePath));
        if (fsModel.removed.has(resolved)) throw Object.assign(new Error("Removed"), { code: "ENOENT" });
        return toNative(resolved);
      }
      return await actual.realpath(filePath);
    }),
    stat: vi.fn(async (filePath: Parameters<typeof actual.stat>[0], options?: Parameters<typeof actual.stat>[1]) => {
      if (typeof filePath === "string" && toModel(filePath).startsWith("/contrived")) {
        if (fsModel.removed.has(resolveAlias(toModel(filePath)))) throw Object.assign(new Error("Removed"), { code: "ENOENT" });
        return { isDirectory: () => true } as Awaited<ReturnType<typeof actual.stat>>;
      }
      return await actual.stat(filePath, options);
    }),
  };
});
const registryLog = vi.hoisted(() => ({ debug() {}, info() {}, warn() {}, error() {} }));
vi.mock("../log", () => ({ getMainLogger: () => registryLog }));
vi.mock("../app-server/worktree-container-service", () => ({ WorktreeContainerService: class {
  async containerPath(): Promise<undefined> { return undefined; }
  comparisonPaths(containerPath: string): string[] { return [containerPath]; }
  worktreeComparisonPaths(worktreePath: string): string[] { return [worktreePath]; }
} }));
vi.mock("../app-server/thread-assets", async (importOriginal) => ({
  ...await importOriginal<typeof import("../app-server/thread-assets")>(),
  deleteThreadAssets: vi.fn(async () => {}),
}));

const THREADS = ["t0", "t1", "t2", "t3", "t4", "t5"];
const CHECKOUTS = ["/contrived/worktrees/c0", "/contrived/worktrees/c1", "/contrived/worktrees/c2", "/contrived/worktrees/c3"];
/** A symlink to c0: an owner reached through it is still c0's owner. */
const ALIAS = "/contrived/aliases/c0";
const PLACES = [...CHECKOUTS, ALIAS, `${CHECKOUTS[1]}/nested`, "/contrived/projects/home"];

type World = {
  fleet: Fleet;
  registry: DesktopBackendRegistry;
  instance: number;
  clock: number;
  /** Threads archived through the registry since their last restore. */
  cleanupRequested: Set<string>;
  /** Canonical checkout -> threads holding its snapshot. */
  snapshots: Map<string, Set<string>>;
  /** Canonical checkout -> archived owners at the instant it was removed. */
  owedSnapshots: Map<string, string[]>;
  violations: string[];
  db: StateDb;
  checkpoint: ArchiveCleanupCheckpointStore;
};

function canonicalUses(world: World, threadId: string): string[] {
  const row = world.fleet.rows.get(threadId);
  if (!row) return [];
  const extras = world.fleet.overlays.get(threadId)?.extraLinkedDirectories ?? [];
  return [row.thread.projectKey, ...extras.map((directory) => directory.worktreePath ?? directory.path)]
    .filter((value): value is string => Boolean(value))
    .map((value) => resolveFleetAlias(fsModel, value));
}

function uses(world: World, threadId: string, checkout: string): boolean {
  return canonicalUses(world, threadId).some((value) => value === checkout || value.startsWith(`${checkout}/`));
}

/** The oracle: active provider threads whose cwd or overlay link is in the checkout. */
function activeUsers(world: World, checkout: string): string[] {
  return [...world.fleet.rows].filter(([id, row]) => !row.archived && uses(world, id, checkout)).map(([id]) => id);
}

function archivedOwners(world: World, checkout: string): string[] {
  return [...world.fleet.rows].filter(([id, row]) => row.archived && uses(world, id, checkout)).map(([id]) => id);
}

function start(world: World): void {
  const { registry } = buildFleetRegistry(fsModel, world.fleet, world.checkpoint, {
    instanceId: `model-${world.instance}`,
    parkBeforeRemove: async () => await new Promise((resolve) => setTimeout(resolve, ARCHIVE_CLEANUP_PAUSE_MS)),
    onRemove: (checkout) => {
      const users = activeUsers(world, checkout);
      if (users.length) world.violations.push(`removed ${checkout} while ${users.join(", ")} used it`);
      // Every owner archived at this instant must be able to restore it.
      world.owedSnapshots.set(checkout, archivedOwners(world, checkout));
    },
    onSnapshot: (threadId, snapshot) => {
      const checkout = resolveFleetAlias(fsModel, snapshot.worktreePath);
      const holders = world.snapshots.get(checkout) ?? new Set<string>();
      holders.add(threadId);
      world.snapshots.set(checkout, holders);
    },
  });
  world.registry = registry;
}

async function publish(world: World, method: string, threadId: string): Promise<void> {
  const params = method === "navigation/threadDirectories/updated"
    ? { reason: "selected-thread", threadIds: [threadId] }
    : { threadId };
  await drive(world.registry.publishLocalEvent({ backend: "codex", notification: { method, params } as never }));
}

/** Awaits registry work while cleanup keeps pacing: an archive or restart can
 * wait for a running cleanup job, which only the clock moves. */
async function drive<T>(promise: Promise<T>): Promise<T> {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  for (let tick = 0; tick < 2_000; tick += 1) {
    await vi.advanceTimersByTimeAsync(0);
    if (settled) return await promise;
    await vi.advanceTimersByTimeAsync(ARCHIVE_CLEANUP_PAUSE_MS);
  }
  throw new Error("Registry work did not settle while cleanup was paced.");
}

async function step(ticks: number): Promise<void> {
  for (let tick = 0; tick < ticks; tick += 1) await vi.advanceTimersByTimeAsync(ARCHIVE_CLEANUP_PAUSE_MS);
}

async function settle(world: World): Promise<void> {
  let idle = 0;
  for (let tick = 0; tick < 2_000 && idle < 4; tick += 1) {
    await vi.advanceTimersByTimeAsync(ARCHIVE_CLEANUP_PAUSE_MS);
    idle = world.registry.getArchiveCleanupCountForQuit() === 0 ? idle + 1 : 0;
  }
}

/** A refused write (removal reserved) is a legitimate outcome, not a failure. */
async function tolerate(work: () => Promise<unknown>): Promise<void> {
  try { await drive(work()); }
  catch (error) {
    if (!/reserved|in flight|changed during|lifecycle/i.test(String(error))) throw error;
  }
}

type Command = fc.AsyncCommand<object, World>;

const commands: Array<fc.Arbitrary<Command>> = [
  fc.record({ thread: fc.constantFrom(...THREADS) }).map(({ thread }) => ({
    check: () => true,
    run: async (_model, world) => {
      if (world.fleet.rows.get(thread)?.archived !== false) return;
      await tolerate(async () => await world.registry.archiveThread({ backend: "codex", threadId: thread, backgroundCleanup: true }));
      if (world.fleet.rows.get(thread)?.archived) world.cleanupRequested.add(thread);
    },
    toString: () => `archive(${thread})`,
  })),
  fc.record({ thread: fc.constantFrom(...THREADS), checkout: fc.constantFrom(...CHECKOUTS, ALIAS) }).map(({ thread, checkout }) => ({
    check: () => true,
    run: async (_model, world) => {
      if (world.fleet.rows.get(thread)?.archived !== false) return;
      await tolerate(async () => {
        await world.registry.withArchiveWorkspaceWrite([checkout], async () => {
          const overlay = world.fleet.overlays.get(thread) ?? { backend: "codex" as const, threadId: thread, extraLinkedDirectories: [] };
          const extra: LinkedDirectorySummary[] = [...overlay.extraLinkedDirectories ?? [], worktree(`${thread}:${checkout}`, checkout)];
          world.fleet.overlays.set(thread, { ...overlay, extraLinkedDirectories: extra });
        });
        await publish(world, "navigation/threadDirectories/updated", thread);
      });
    },
    toString: () => `attach(${thread}, ${checkout})`,
  })),
  fc.record({ thread: fc.constantFrom(...THREADS) }).map(({ thread }) => ({
    check: () => true,
    run: async (_model, world) => {
      const overlay = world.fleet.overlays.get(thread);
      if (!overlay?.extraLinkedDirectories?.length || world.fleet.rows.get(thread)?.archived !== false) return;
      world.fleet.overlays.set(thread, { ...overlay, extraLinkedDirectories: overlay.extraLinkedDirectories.slice(1) });
      await publish(world, "navigation/threadDirectories/updated", thread);
    },
    toString: () => `detach(${thread})`,
  })),
  fc.record({ thread: fc.constantFrom(...THREADS), place: fc.constantFrom(...PLACES) }).map(({ thread, place }) => ({
    check: () => true,
    run: async (_model, world) => {
      const row = world.fleet.rows.get(thread);
      if (!row || row.archived) return;
      await tolerate(async () => {
        await world.registry.withThreadWorkspaceMutation({ backend: "codex", threadId: thread }, async () => {
          await world.registry.withArchiveWorkspaceWrite([place], async () => {
            row.thread = { ...row.thread, projectKey: place };
            row.updatedAt = ++world.clock;
          });
        });
        await publish(world, "navigation/threadDirectories/updated", thread);
      });
    },
    toString: () => `move(${thread}, ${place})`,
  })),
  fc.record({ thread: fc.constantFrom(...THREADS) }).map(({ thread }) => ({
    check: () => true,
    run: async (_model, world) => {
      const row = world.fleet.rows.get(thread);
      if (!row?.archived) return;
      // A reported restore from outside this registry.
      row.archived = false;
      row.updatedAt = ++world.clock;
      world.cleanupRequested.delete(thread);
      await publish(world, "thread/unarchived", thread);
    },
    toString: () => `restore(${thread})`,
  })),
  fc.record({ thread: fc.constantFrom(...THREADS) }).map(({ thread }) => ({
    check: () => true,
    run: async (_model, world) => {
      if (!world.fleet.rows.delete(thread)) return;
      world.fleet.overlays.delete(thread);
      world.cleanupRequested.delete(thread);
      await publish(world, "thread/deleted", thread);
    },
    toString: () => `delete(${thread})`,
  })),
  fc.integer({ min: 1, max: 6 }).map((ticks) => ({
    check: () => true,
    run: async () => { await step(ticks); },
    toString: () => `step(${ticks})`,
  })),
  fc.constant<Command>({
    check: () => true,
    run: async (_model, world) => {
      // Quit checkpoints what is pending; a new process claims and resumes it.
      await drive(world.registry.close());
      world.instance += 1;
      start(world);
      await drive(world.registry.resumeArchiveCleanupsAtStartup());
    },
    toString: () => "restart",
  }),
];

const initialPlace = fc.constantFrom(...PLACES);
const initialWorld = fc.record({
  places: fc.array(initialPlace, { minLength: THREADS.length, maxLength: THREADS.length }),
  extras: fc.array(fc.subarray([...CHECKOUTS, ALIAS], { maxLength: 2 }), { minLength: THREADS.length, maxLength: THREADS.length }),
});

const worlds: World[] = [];
afterEach(async () => {
  for (const world of worlds.splice(0)) {
    await drive(world.registry.close()).catch(() => {});
    world.db.close();
  }
  vi.useRealTimers();
});

describe("bulk archive cleanup model", () => {
  it("never removes a used checkout, releases every final reference, and keeps every owner restorable", async () => {
    const temp = createTempStateDb("pwragent-archive-model-");
    try {
      await fc.assert(fc.asyncProperty(initialWorld, fc.commands(commands, { maxCommands: 14 }), async (initial, generated) => {
        vi.useFakeTimers();
        fsModel.removed.clear();
        fsModel.aliases.clear();
        fsModel.aliases.set(ALIAS, CHECKOUTS[0]!);
        const db = StateDb.open(temp.dbPath);
        db.raw.prepare("DELETE FROM meta WHERE key GLOB 'archive_cleanup_checkpoint_*'").run();
        const fleet: Fleet = { rows: new Map(), overlays: new Map(), targets: [...THREADS], checkouts: new Set(CHECKOUTS) };
        THREADS.forEach((id, index) => {
          fleet.rows.set(id, { thread: raw(id, initial.places[index]!), archived: false, updatedAt: 1_000 + index });
          const extras = initial.extras[index]!;
          if (extras.length) fleet.overlays.set(id, { backend: "codex", threadId: id, extraLinkedDirectories: extras.map((value) => worktree(`${id}:${value}`, value)) });
        });
        const world: World = {
          fleet, registry: undefined as never, instance: 0, clock: 10_000, cleanupRequested: new Set(), snapshots: new Map(), owedSnapshots: new Map(), violations: [],
          db, checkpoint: new ArchiveCleanupCheckpointStore(db.raw, { processId: 4242, processAlive: () => false }),
        };
        worlds.push(world);
        start(world);
        await fc.asyncModelRun(() => ({ model: {}, real: world }), generated);
        await settle(world);
        expect(world.violations).toEqual([]);
        for (const checkout of CHECKOUTS) {
          const removed = fsModel.removed.has(checkout);
          const owners = archivedOwners(world, checkout).filter((owner) => world.cleanupRequested.has(owner));
          if (!removed && owners.length && !activeUsers(world, checkout).length) {
            throw new Error(`${checkout} was released by its last active user but never removed (owners ${owners.join(", ")})`);
          }
          if (removed) {
            const holders = world.snapshots.get(checkout) ?? new Set<string>();
            for (const owner of world.owedSnapshots.get(checkout) ?? []) {
              if (!holders.has(owner)) throw new Error(`${owner} owned ${checkout} when it was removed but holds no snapshot`);
            }
          }
        }
        await drive(world.registry.close());
        db.close();
        worlds.splice(worlds.indexOf(world), 1);
        vi.useRealTimers();
      }), { numRuns: 30 });
    } finally {
      // A failed run leaves its world open; Windows cannot remove an open database.
      for (const world of worlds.splice(0)) {
        await drive(world.registry.close()).catch(() => {});
        world.db.close();
      }
      removeTempStateDbDir(temp.tempDir);
    }
  }, 60_000);
});
