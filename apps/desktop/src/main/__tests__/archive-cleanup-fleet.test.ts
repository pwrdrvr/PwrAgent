import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import type { AgentEvent, ThreadOverlayState } from "@pwragent/shared";
import type { ClaudeSession } from "../claude/claude-session-store";
import { ArchiveCleanupCheckpointStore } from "../state/archive-cleanup-checkpoint";
import { StateDb } from "../state/state-db";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";
import { buildFleetRegistry, drivePacer, raw, worktree, type Fleet, type FleetRegistryOptions } from "./fixtures/archive-fleet-harness";

/**
 * Adversarial interleavings for the batch fleet index: what it must still see
 * without a complete read per removal, and what it must keep doing across an
 * irreversible removal, a restart and the bounded queue.
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

const C0 = "/contrived/worktrees/c0";
const C1 = "/contrived/worktrees/c1";
const ALIAS = "/contrived/aliases/c0";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.useRealTimers();
});

function world(rows: Array<[string, string, number?]>, overlays: Record<string, ThreadOverlayState> = {}) {
  vi.useFakeTimers();
  fsModel.removed.clear();
  fsModel.aliases.clear();
  fsModel.aliases.set(ALIAS, C0);
  const fleet: Fleet = { rows: new Map(), overlays: new Map(Object.entries(overlays)), targets: [], checkouts: new Set([C0, C1]) };
  rows.forEach(([id, cwd, updatedAt], index) => fleet.rows.set(id, { thread: raw(id, cwd), archived: false, updatedAt: updatedAt ?? 1_000 + index }));
  const temp = createTempStateDb("pwragent-archive-fleet-");
  const db = StateDb.open(temp.dbPath);
  const checkpoint = new ArchiveCleanupCheckpointStore(db.raw, { processId: 4242, processAlive: () => false });
  const snapshots: Array<{ threadId: string; worktreePath: string }> = [];
  const removals: Array<{ checkout: string; users: string[] }> = [];
  const start = (options: FleetRegistryOptions = {}) => {
    const fixture = buildFleetRegistry(fsModel, fleet, checkpoint, {
      onSnapshot: (threadId, snapshot) => snapshots.push({ threadId, worktreePath: snapshot.worktreePath }),
      onRemove: (checkout) => {
        // The oracle: active provider rows whose cwd or overlay link is here.
        const users = [...fleet.rows].filter(([id, row]) => !row.archived && [row.thread.projectKey,
          ...(fleet.overlays.get(id)?.extraLinkedDirectories ?? []).map((directory) => directory.worktreePath)]
          .some((value) => value && (value === checkout || value.startsWith(`${checkout}/`)))).map(([id]) => id);
        removals.push({ checkout, users });
      },
      ...options,
    });
    const completions: AgentEvent[] = [];
    fixture.registry.onEvent((event) => {
      if (event.notification.method === "thread/archiveCleanup/completed") completions.push(event);
    });
    cleanups.push(async () => { await fixture.registry.close(); });
    return { ...fixture, completions };
  };
  cleanups.push(async () => {
    db.close();
    removeTempStateDbDir(temp.tempDir);
  });
  return { fleet, checkpoint, snapshots, removals, start };
}

async function archive(registry: ReturnType<ReturnType<typeof world>["start"]>["registry"], ...threadIds: string[]) {
  return await drivePacer(registry, Promise.all(threadIds.map(async (threadId) => await registry.archiveThread({ backend: "codex", threadId }))));
}

describe("archive cleanup fleet index", () => {
  it("refreshes a foreign Claude change without rereading unchanged providers, and obeys its current ownership", async () => {
    await fc.assert(fc.asyncProperty(
      fc.integer({ min: 30, max: 150 }),
      fc.constantFrom("active-here", "new-active-here", "active-via-alias", "active-child-here", "archived-here", "active-elsewhere", "deleted"),
      async (unrelated, change) => {
        const setup = world([["owner", C0], ...Array.from({ length: unrelated }, (_, index) =>
          [`unrelated-${index}`, `/contrived/projects/unrelated-${index}`] as [string, string])]);
        let token = "before";
        let sessions: ClaudeSession[] = change === "new-active-here" ? []
          : [{ cwd: C1, thread: { ...raw("claude-owner", C1), source: "claude" } }];
        let rowsBeforeAdmission = 0;
        const fixture = setup.start({
          beforeAdmission: async () => {
            rowsBeforeAdmission = fixture.counts.providerRows;
            sessions = change === "deleted" ? [] : [{
              cwd: change === "active-elsewhere" ? C1 : change === "active-via-alias" ? ALIAS
                : change === "active-child-here" ? `${C0}/src` : C0,
              thread: { ...raw("claude-owner", C0), source: "claude", ...(change === "archived-here" ? { archivedAt: 1 } : {}) },
            }];
            token = "after";
          },
        });
        vi.spyOn(fixture.claudeStore, "changeToken").mockImplementation(async () => token);
        vi.mocked(fixture.claudeStore.list).mockImplementation(async () => sessions);
        try {
          const [result] = await archive(fixture.registry, "owner");
          // Oracle: only a currently active Claude session at the checkout
          // protects it. Membership, a moved cwd and deletion all come from
          // Claude's fresh session listing, without notifications.
          const hasActiveUser = !["archived-here", "active-elsewhere", "deleted"].includes(change);
          expect(result!.cleanup[0]!.removedWorktree).toBe(!hasActiveUser);
          expect(fixture.counts.removals).toBe(hasActiveUser ? 0 : 1);
          if (change === "archived-here") expect(setup.snapshots.some((snapshot) => snapshot.threadId === "claude-owner")).toBe(true);
          // The unchanged Codex fleet contributes only its bounded recency
          // page, regardless of how many unrelated identities it contains.
          expect(fixture.counts.providerRows - rowsBeforeAdmission).toBeLessThanOrEqual(5);
        } finally {
          await fixture.registry.close();
        }
      },
    ), { numRuns: 16 });
  });

  it("sees an unreported new checkout user through the provider's recency read", async () => {
    const setup = world([["owner", C0], ["unrelated", "/contrived/projects/unrelated"]]);
    const fixture = setup.start({
      beforeAdmission: async () => {
        // Codex started a thread in the checkout and nothing told PwrAgent.
        setup.fleet.rows.set("cli", { thread: raw("cli", `${C0}/src`), archived: false, updatedAt: 9_000 });
      },
    });
    const [result] = await archive(fixture.registry, "owner");
    expect(setup.removals).toEqual([]);
    expect(result!.cleanup[0]).toMatchObject({ removedWorktree: false, error: expect.stringContaining("still used") });
    // One complete read for the batch; the recency read found the new row.
    expect(fixture.client.listArchiveCleanupThreadsPage.mock.calls.filter(([params]) => params.sortKey === "updated_at")).not.toHaveLength(0);
  });

  it("reads the fleet again when another process wrote the overlay store", async () => {
    let token = "first";
    const setup = world([["owner", C0], ["other", "/contrived/projects/other"]]);
    const fixture = setup.start({
      overlayToken: () => token,
      beforeAdmission: async () => {
        // A second instance on this profile attached the checkout. Its write
        // reaches neither this registry's writers nor its notifications.
        setup.fleet.overlays.set("other", { backend: "codex", threadId: "other", extraLinkedDirectories: [worktree("other:c0", C0)] });
        token = "second";
      },
    });
    const [result] = await archive(fixture.registry, "owner");
    expect(setup.removals).toEqual([]);
    expect(result!.cleanup[0]).toMatchObject({ removedWorktree: false });
  });

  it("protects every checkout while a changed owner cannot be read", async () => {
    // Older than the newest active row, so the admission's recency read does
    // not list it again: the failed read is all that is known of its change.
    const setup = world([["owner", C0], ["flaky", "/contrived/projects/flaky", 500], ["newest", "/contrived/projects/newest", 5_000]]);
    const fixture = setup.start({
      beforeAdmission: async () => {
        fixture.client.readArchiveCleanupThreadSummary.mockImplementationOnce(async () => { throw new Error("provider unavailable"); });
        await fixture.registry.publishLocalEvent({ backend: "codex", notification: {
          method: "navigation/threadDirectories/updated", params: { reason: "selected-thread", threadIds: ["flaky"] },
        } });
      },
    });
    await archive(fixture.registry, "owner");
    expect(setup.removals).toEqual([]);
  });

  it("does not reread the fleet for ordinary activity on unrelated threads", async () => {
    const setup = world([["owner", C0], ...Array.from({ length: 400 }, (_, index) => [`busy-${index}`, `/contrived/projects/busy-${index}`] as [string, string])]);
    let rowsAtAdmission = 0;
    const fixture = setup.start({
      beforeAdmission: async () => {
        rowsAtAdmission = fixture.counts.providerRows;
        for (let index = 0; index < 60; index += 1) {
          await fixture.registry.publishLocalEvent({ backend: "codex", notification: {
            method: "navigation/threadDirectories/updated", params: { reason: "selected-thread", threadIds: [`busy-${index}`] },
          } });
        }
      },
    });
    await archive(fixture.registry, "owner");
    expect(setup.removals).toEqual([{ checkout: C0, users: [] }]);
    // Sixty changed identities are read once each, not the 401-row fleet sixty
    // times; admission adds one five-row recency page.
    expect(fixture.counts.threadReads).toBe(60);
    expect(fixture.counts.providerRows - rowsAtAdmission).toBe(5);
  });

  it("gives an archived owner reached through a symlink its snapshot", async () => {
    const setup = world([["direct", C0], ["through-alias", ALIAS]]);
    const fixture = setup.start();
    await archive(fixture.registry, "direct", "through-alias");
    expect(setup.removals).toEqual([{ checkout: C0, users: [] }]);
    // The alias dangles after removal; the sibling was resolved before it.
    expect(setup.snapshots.map((snapshot) => snapshot.threadId).sort()).toEqual(["direct", "through-alias"]);
  });

  it("persists a snapshot whose write failed after removal on the next start, without removing twice", async () => {
    const setup = world([["owner", C0]]);
    const first = setup.start({ failSnapshotWrites: { remaining: 1 } });
    const [result] = await archive(first.registry, "owner");
    expect(result!.cleanup[0]).toMatchObject({ removedWorktree: false, error: "Snapshot persistence failed." });
    expect(setup.removals).toHaveLength(1);
    expect(setup.snapshots).toEqual([]);
    // Quit checkpoints the retained snapshot; the next process claims it.
    await first.registry.close();
    const second = setup.start({ instanceId: "second" });
    await drivePacer(second.registry, second.registry.resumeArchiveCleanupsAtStartup());
    expect(setup.snapshots).toEqual([{ threadId: "owner", worktreePath: C0 }]);
    expect(setup.removals).toHaveLength(1);
  });

  it("admits cleanups beyond the queue's 256 slots instead of refusing them", async () => {
    const setup = world(Array.from({ length: 300 }, (_, index) => [`owner-${index}`, `/contrived/worktrees/w-${index}`] as [string, string]));
    const fixture = setup.start();
    const ids = Array.from({ length: 300 }, (_, index) => `owner-${index}`);
    const finished = new Promise<void>((resolve) => fixture.registry.onEvent(() => { if (fixture.completions.length === 300) resolve(); }));
    await Promise.all(ids.map(async (threadId) => await fixture.registry.archiveThread({ backend: "codex", threadId, backgroundCleanup: true })));
    expect(fixture.registry.getArchiveCleanupCountForQuit()).toBe(300);
    await drivePacer(fixture.registry, finished);
    expect(fixture.completions.filter((event) => (event.notification.params as { error?: string }).error)).toEqual([]);
    expect(setup.removals.map((removal) => removal.checkout).sort()).toEqual(ids.map((_, index) => `/contrived/worktrees/w-${index}`).sort());
    expect(setup.removals.every((removal) => removal.users.length === 0)).toBe(true);
  });
});
