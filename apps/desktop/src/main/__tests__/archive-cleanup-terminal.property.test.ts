import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { createDesktopBackendRegistry, registryModules } from "../app-server/backend-registry-wiring";
import type { DesktopBackendRegistry } from "../app-server/backend-registry";
import { ARCHIVE_CLEANUP_PAUSE_MS } from "../app-server/archive-cleanup-queue";
import { CodexAppServerClient } from "../codex-app-server/desktop-client";
import { ArchiveCleanupCheckpointStore, type ArchiveCleanupIntent } from "../state/archive-cleanup-checkpoint";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { ArchiveWorktreeTransport } from "./fixtures/archive-worktree-transport";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

vi.mock("../log", () => ({ getMainLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }));
vi.mock("../codex-app-server/stdio-transport", async () => ({
  StdioJsonRpcTransport: (await import("./fixtures/archive-worktree-transport")).ArchiveWorktreeTransport,
}));

let activeProperty: Promise<void> | undefined;

afterEach(async () => {
  // Vitest's timeout aborts the test but does not join its async callback.
  // Restore the property-owned provider spy and close its real registry
  // before resetting the shared fake clock or starting another fixture.
  await activeProperty?.catch(() => {});
  activeProperty = undefined;
  ArchiveWorktreeTransport.threads = [];
  ArchiveWorktreeTransport.requests = [];
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

type Outcome = "absent" | "external" | "blocked";

async function drivePacer(registry: DesktopBackendRegistry, work: Promise<void>): Promise<void> {
  let settled = false;
  const settlement = work.finally(() => { settled = true; });
  while (!settled) {
    await Promise.race([settlement, registryModules(registry).threadArchiveCoordinator.whenArchiveCleanupCheckpointPendingForTests()]);
    if (!settled) await vi.advanceTimersByTimeAsync(ARCHIVE_CLEANUP_PAUSE_MS);
  }
  await settlement;
}

async function fixture(outcomes: Outcome[], deferred: boolean) {
  const temp = createTempStateDb("pwragent-terminal-cleanup-");
  const db = StateDb.open(temp.dbPath);
  const store = new SqliteOverlayStore(db);
  const checkpoint = new ArchiveCleanupCheckpointStore(db.raw, { processAlive: () => false });
  const directories = outcomes.map((outcome, index) => ({ id: `checkout-${index}`, kind: "worktree" as const,
    label: "Fixture", path: path.join(temp.tempDir, "repo"), worktreePath: path.join(temp.tempDir, `checkout-${index}`),
    ...(outcome === "external" ? { worktreeOwnership: "external" as const } : {}),
  }));
  // A held checkout must actually exist. Only the absent outcome has no
  // folder; stale ownership cannot keep a folder that is already gone.
  for (let index = 0; index < outcomes.length; index += 1) {
    if (outcomes[index] !== "absent") await mkdir(directories[index]!.worktreePath);
  }
  ArchiveWorktreeTransport.threads = outcomes.flatMap((outcome, index) => [
    { id: `archived-${index}`, cwd: directories[index]!.worktreePath, source: "cli", archived: true },
    ...(outcome === "blocked" ? [{ id: `blocker-${index}`, cwd: directories[index]!.worktreePath, source: "cli" }] : []),
  ]);
  const intents: ArchiveCleanupIntent[] = outcomes.map((_, index) => ({ backend: "codex", threadId: `archived-${index}`,
    archivedAt: 1, codexRolloutMissing: false, messagingCleanup: {},
    ...(deferred ? { deferredWorktrees: [{ repositoryPath: directories[index]!.path,
      worktreePath: directories[index]!.worktreePath, blockers: [`codex:blocker-${index}`] }] } : {}),
  }));
  checkpoint.save("previous-process", intents);
  let generation = 0;
  const open = () => createDesktopBackendRegistry({ codexClient: new CodexAppServerClient({ directoryResolver: async (cwd) =>
    directories.filter((directory) => directory.worktreePath === cwd) }), overlayStore: store,
    archiveCleanupCheckpointStore: checkpoint, runtimeInstanceId: `resumed-process-${++generation}`, resolveLiveProfileRuntimeInstanceIds: () => [],
    messagingStore: null, threadTitleGenerationService: null,
  });
  let registry = open();
  // Persist the marker as a workspace overlay too, as real adopted checkouts do.
  for (let index = 0; index < outcomes.length; index += 1) {
    await store.replaceWorkspaceLinkedDirectory({ backend: "codex", threadId: `archived-${index}`, directory: directories[index]! });
  }
  return { get registry() { return registry; }, db, store, checkpoint,
    savedIntents: () => (db.raw.prepare("SELECT value FROM meta WHERE key GLOB 'archive_cleanup_checkpoint_v2:*'")
      .all() as Array<{ value: string }>).map((row) => (JSON.parse(row.value) as { intent: ArchiveCleanupIntent }).intent),
    async restart() {
      await registry.close();
      registry = open();
    }, async close() {
    await registry.close();
    db.close();
    removeTempStateDbDir(temp.tempDir);
  } };
}

describe("terminal archive cleanup recovery", () => {
  // Rule: failed discovery cannot prove cleanup finished. Its saved intent
  // survives both recovery drain and clean quit until discovery succeeds.
  it("retains unresolved requests through transient metadata failures and retires them after successful discovery", async ({ signal }) => {
    vi.useFakeTimers();
    await (activeProperty = fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 3 }), fc.boolean(), fc.constantFrom("provider", "overlay"),
      async (failures, deferred, source) => {
        signal.throwIfAborted();
        const test = await fixture(["absent"], deferred);
        const original = test.savedIntents();
        const fail = source === "provider"
          ? vi.spyOn(CodexAppServerClient.prototype, "listArchiveCleanupThreadsPage").mockRejectedValue(new Error("Provider temporarily unavailable"))
          : vi.spyOn(test.store, "getArchiveCleanupOverlayStates").mockRejectedValue(new Error("Overlay temporarily unavailable"));
        try {
          signal.throwIfAborted();
          for (let attempt = 0; attempt < failures; attempt += 1) {
            await drivePacer(test.registry, test.registry.resumeArchiveCleanupsAtStartup());
            signal.throwIfAborted();
            expect(test.savedIntents()).toEqual(original);
            expect(test.registry.getArchiveCleanupCountForQuit()).toBe(0);
            await test.restart();
            expect(test.savedIntents()).toEqual(original);
          }
          fail.mockRestore();
          await drivePacer(test.registry, test.registry.resumeArchiveCleanupsAtStartup());
          expect(test.savedIntents()).toEqual([]);
          await test.restart();
          await drivePacer(test.registry, test.registry.resumeArchiveCleanupsAtStartup());
          expect(test.savedIntents()).toEqual([]);
        } finally {
          fail.mockRestore();
          await test.close();
        }
      }), { numRuns: 25, examples: [[1, false, "provider"]] }));
  });

  it("preserves a plain recovered request when provider discovery fails", async () => {
    vi.useFakeTimers();
    const test = await fixture(["absent"], false);
    const original = test.savedIntents();
    const fail = vi.spyOn(CodexAppServerClient.prototype, "listArchiveCleanupThreadsPage").mockRejectedValue(new Error("Provider temporarily unavailable"));
    try {
      await drivePacer(test.registry, test.registry.resumeArchiveCleanupsAtStartup());
      expect(test.savedIntents()).toEqual(original);
    } finally {
      fail.mockRestore();
      await test.close();
    }
  });

  // Rule: the durable backlog after recovery contains only checkouts that
  // still need a retry, regardless of completion order or other held owners.
  it("retires terminal outcomes while preserving active checkout references", async ({ signal }) => {
    vi.useFakeTimers();
    await (activeProperty = fc.assert(fc.asyncProperty(
      fc.array(fc.constantFrom<Outcome>("absent", "external", "blocked"), { minLength: 1, maxLength: 6 }),
      fc.boolean(),
      async (outcomes, deferred) => {
        signal.throwIfAborted();
        const test = await fixture(outcomes, deferred);
        try {
          signal.throwIfAborted();
          await drivePacer(test.registry, test.registry.resumeArchiveCleanupsAtStartup());
          signal.throwIfAborted();
          // Claim as if this process died immediately, without a clean quit
          // that could hide a missing recovery-drain checkpoint.
          const remaining = test.checkpoint.recover("next-process", () => []);
          expect(remaining.map((intent) => intent.threadId).sort()).toEqual(outcomes.flatMap((outcome, index) =>
            outcome === "blocked" ? [`archived-${index}`] : []).sort());
          for (const intent of remaining) expect(intent.deferredWorktrees?.[0]?.blockers).toEqual([
            `codex:blocker-${intent.threadId.slice("archived-".length)}`,
          ]);
        } finally { await test.close(); }
      },
    ), { numRuns: 25, examples: [[["absent"], true], [["external"], true], [["absent"], false], [["blocked", "absent", "external"], true]] }));
  });

  it.each(["absent", "external"] as const)("does not report an %s checkout again after a clean restart", async (outcome) => {
    vi.useFakeTimers();
    const test = await fixture([outcome], true);
    try {
      await drivePacer(test.registry, test.registry.resumeArchiveCleanupsAtStartup());
      test.registry.checkpointArchiveCleanupsForQuit();
      expect(test.checkpoint.recover("next-process", () => [])).toEqual([]);
    } finally { await test.close(); }
  });

  it("bounds recovery writes at the batch drain rather than each terminal result", async () => {
    vi.useFakeTimers();
    vi.stubEnv("PWRAGENT_DEV_SQLITE_WRITE_METRICS", "1");
    const test = await fixture(Array.from({ length: 16 }, (_, index) => index === 0 ? "external" : "absent"), true);
    try {
      const { writes } = await measureSqliteWrites(async () => {
        await drivePacer(test.registry, test.registry.resumeArchiveCleanupsAtStartup());
      });
      expect(test.checkpoint.recover("next-process", () => [])).toEqual([]);
      expectSqliteWriteBudget({ scenario: "archive-cleanup-16-terminal-recovery",
        note: "Recover 15 absent and one external checkout: one claim and one drained deletion plus 16 existing archive-overlay commits; no per-item checkpoint or idle writes. At 10 launches/day and about 272 KB WAL per launch, about 2.72 MB/day.", writes });
    } finally { await test.close(); }
  });
});
