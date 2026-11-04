import { afterEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AgentEvent, LinkedDirectorySummary } from "@pwragent/shared";
import { ArchiveCleanupCheckpointStore } from "../state/archive-cleanup-checkpoint";
import { buildFleetRegistry, drivePacer, raw, worktree, type Counts, type Fleet } from "./fixtures/archive-fleet-harness";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites } from "../state/sqlite-write-metrics";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

/**
 * Bulk archive scaling. Every counter below sits on a real boundary the
 * registry crosses: the provider's paged `thread/list` and `thread/read`, its
 * Git directory enrichment, the overlay store's queries, `realpath`, the
 * worktree snapshot/removal service, overlay writes, and the checkpoint's
 * SQLite commits and serialized bytes. Nothing counts an implementation helper.
 *
 * The operator archives about 50 of 1,500 threads at a time; archive-all of
 * 1,000 is the degenerate case. Metadata work must stay linear in the fleet
 * plus the batch, so removal (one snapshot + one `git worktree remove` per
 * checkout) is the dominant cost rather than repeated fleet scans.
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
  // Mirrors resolveFleetAlias; a mock factory cannot import the harness,
  // which imports this module.
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

type Scenario = {
  name: string;
  /** Threads that remain active and unrelated to any archived checkout. */
  unrelated: number;
  /** Archived together, as the sidebar sends them: one concurrent burst. */
  members: number;
  /** Managed checkouts each member owns (the first is its cwd, the rest overlay attachments). */
  worktreesPerMember: number;
  /** Members sharing one canonical checkout; half refer to it through a symlink alias. */
  sharedGroup: number;
  /**
   * Active threads that also hold the members' checkouts through an overlay
   * link: one holder for every checkout, or one holder per member. After the
   * burst each holder detaches, all at once or one at a time, and only then
   * may the checkout go.
   */
  holders?: "one" | "each";
};

function seed(scenario: Scenario): Fleet {
  const fleet: Fleet = { rows: new Map(), overlays: new Map(), targets: [], checkouts: new Set() };
  for (let index = 0; index < scenario.unrelated; index += 1) {
    const id = `unrelated-${index}`;
    // Distinct activity times, as a real fleet has.
    fleet.rows.set(id, { thread: raw(id, `/contrived/projects/unrelated-${index}`), archived: false, updatedAt: 1_000 + index });
  }
  for (let index = 0; index < scenario.members; index += 1) {
    const id = `member-${index}`;
    const group = Math.floor(index / scenario.sharedGroup);
    const canonical = `/contrived/worktrees/wt-${group}`;
    let cwd = canonical;
    if (scenario.sharedGroup > 1 && index % 2 === 1) {
      cwd = `/contrived/aliases/wt-${group}`;
      fsModel.aliases.set(cwd, canonical);
    }
    fleet.checkouts.add(canonical);
    fleet.rows.set(id, { thread: raw(id, cwd), archived: false, updatedAt: 1_000 + scenario.unrelated + index });
    fleet.targets.push(id);
    const extra: LinkedDirectorySummary[] = [];
    for (let other = 1; other < scenario.worktreesPerMember; other += 1) {
      const extraPath = `/contrived/worktrees/wt-${group}-extra-${other}`;
      fleet.checkouts.add(extraPath);
      extra.push(worktree(`${id}-extra-${other}`, extraPath));
    }
    if (extra.length) fleet.overlays.set(id, { backend: "codex", threadId: id, extraLinkedDirectories: extra });
  }
  const holderIds = scenario.holders === "one" ? ["holder"] : scenario.holders === "each" ? fleet.targets.map((id) => `holder-${id}`) : [];
  holderIds.forEach((id, index) => {
    fleet.rows.set(id, { thread: raw(id, `/contrived/projects/${id}`), archived: false, updatedAt: 500 + index });
    const held = scenario.holders === "one" ? [...fleet.checkouts] : [`/contrived/worktrees/wt-${index}`];
    fleet.overlays.set(id, { backend: "codex", threadId: id, extraLinkedDirectories: held.map((value) => worktree(`${id}:${value}`, value)) });
  });
  fleet.holders = holderIds;
  return fleet;
}

async function runBurst(scenario: Scenario) {
  vi.useFakeTimers();
  vi.stubEnv("PWRAGENT_DEV_SQLITE_WRITE_METRICS", "1");
  fsModel.removed.clear();
  fsModel.aliases.clear();
  fsModel.realpathCalls = 0;
  const fleet = seed(scenario);
  const temp = createTempStateDb("pwragent-archive-scaling-");
  const db = StateDb.open(temp.dbPath);
  // A fixed owner pid keeps checkpoint byte counts identical across runs.
  const checkpoint = new ArchiveCleanupCheckpointStore(db.raw, { processId: 4242 });
  const fixture = buildFleetRegistry(fsModel, fleet, checkpoint, { checkpointDb: db.raw });
  try {
    const completions: AgentEvent[] = [];
    const waiters: Array<{ count: number; resolve: () => void }> = [];
    fixture.registry.onEvent((event) => {
      if (event.notification.method !== "thread/archiveCleanup/completed") return;
      completions.push(event);
      for (const waiter of waiters.splice(0)) {
        if (completions.length >= waiter.count) waiter.resolve();
        else waiters.push(waiter);
      }
    });
    const completed = (count: number) => completions.length >= count ? Promise.resolve()
      : new Promise<void>((resolve) => { waiters.push({ count, resolve }); });
    const release = async (holder: string) => {
      fleet.overlays.set(holder, { backend: "codex", threadId: holder, extraLinkedDirectories: [] });
      await fixture.registry.publishLocalEvent({ backend: "codex", notification: {
        method: "navigation/threadDirectories/updated", params: { reason: "selected-thread", threadIds: [holder] },
      } });
    };
    const startedAt = performance.now();
    const { writes } = await measureSqliteWrites(async () => {
      await Promise.all(fleet.targets.map((threadId) =>
        fixture.registry.archiveThread({ backend: "codex", threadId, backgroundCleanup: true })));
      await drivePacer(fixture.registry, completed(fleet.targets.length));
      const holders = fleet.holders ?? [];
      if (scenario.holders === "one") {
        expect(fixture.counts.removals).toBe(0);
        await release(holders[0]!);
        await drivePacer(fixture.registry, completed(2 * fleet.targets.length));
      } else if (scenario.holders === "each") {
        for (const [index, holder] of holders.entries()) {
          expect(fixture.counts.removals).toBe(index);
          await release(holder);
          await drivePacer(fixture.registry, completed(fleet.targets.length + index + 1));
        }
      }
    });
    const wallMs = performance.now() - startedAt;
    fixture.counts.realpathCalls = fsModel.realpathCalls;
    const errors = completions.flatMap((event) => {
      const params = event.notification.params as { error?: string; cleanup: Array<{ error?: string }> };
      return [params.error, ...params.cleanup.map((item) => item.error)].filter(Boolean);
    });
    // Supporting evidence only: wall time is never asserted.
    if (process.env.ARCHIVE_SCALING_REPORT) {
      appendFileSync(process.env.ARCHIVE_SCALING_REPORT, `${JSON.stringify({ scenario: scenario.name, ...fixture.counts,
        commits: writes.commits, rowsChanged: writes.rowsChanged, walBytes: writes.walBytes, wallMs: Math.round(wallMs), errors: errors.length })}\n`);
    }
    return { counts: fixture.counts, writes, wallMs, errors, fleet, archive: fixture.archive };
  } finally {
    await fixture.registry.close();
    db.close();
    removeTempStateDbDir(temp.tempDir);
    vi.unstubAllEnvs();
  }
}

const BUDGETS_PATH = path.join(import.meta.dirname, "fixtures", "archive-cleanup-scaling-budgets.json");
type ScalingBudget = Omit<Counts, "realpathCalls"> & { realpathCalls: number; commits: number; rowsChanged: number };

function expectScalingBudget(name: string, measured: ScalingBudget): void {
  const file = JSON.parse(readFileSync(BUDGETS_PATH, "utf8")) as Record<string, ScalingBudget>;
  if (process.env.UPDATE_ARCHIVE_SCALING_BUDGETS === "1") {
    file[name] = measured;
    writeFileSync(BUDGETS_PATH, `${JSON.stringify(Object.fromEntries(Object.entries(file).sort(([left], [right]) => left.localeCompare(right))), null, 2)}\n`);
    return;
  }
  expect(measured, `archive scaling budget "${name}" changed; rerun with UPDATE_ARCHIVE_SCALING_BUDGETS=1 if deliberate`).toEqual(file[name]);
}

/** Work that is not per-checkout snapshot/removal: the overhead being bounded. */
function metadataWork(counts: Counts): number {
  return counts.providerRows + counts.threadReads + counts.enrichedRows + counts.gitDiscoveries
    + counts.overlayRows + counts.realpathCalls + (counts.checkpointSerializedBytes + counts.checkpointBytes) / 100;
}

const archiveAll = (members: number): Scenario => ({ name: `archive-all-${members}`, unrelated: 0, members, worktreesPerMember: 1, sharedGroup: 1 });

afterEach(() => {
  vi.useRealTimers();
});

describe("bulk archive scaling", () => {
  // Linear metadata: one pass over the batch plus one pass over the fleet, with
  // bounded per-checkout admission. A per-removal fleet scan grows as n^2.
  it("keeps archive-all metadata linear from 25 to 200 threads", async () => {
    const sizes = [25, 50, 100, 200];
    const perThread: number[] = [];
    for (const size of sizes) {
      const result = await runBurst(archiveAll(size));
      expect(result.errors).toEqual([]);
      expect(result.counts.removals).toBe(size);
      perThread.push(metadataWork(result.counts) / size);
    }
    // Quadratic growth doubles per-thread work at each step (8x across the
    // range). Linear work stays flat; allow 1.5x for fixed per-batch costs.
    expect(perThread[3]! / perThread[0]!, `per-thread metadata work by size: ${perThread.map((value) => value.toFixed(1)).join(", ")}`).toBeLessThan(1.5);
  }, 60_000);

  const scenarios: Scenario[] = [
    archiveAll(1000),
    { name: "50-of-1500", unrelated: 1450, members: 50, worktreesPerMember: 1, sharedGroup: 1 },
    { name: "multi-worktree-100x3", unrelated: 100, members: 100, worktreesPerMember: 3, sharedGroup: 1 },
    { name: "shared-canonical-200x10", unrelated: 100, members: 200, worktreesPerMember: 1, sharedGroup: 10 },
    // More released checkouts than the 256-slot queue, all at once.
    { name: "released-300-one-holder", unrelated: 100, members: 300, worktreesPerMember: 1, sharedGroup: 1, holders: "one" },
    // Each release is its own drain boundary and checkpoint.
    { name: "released-150-one-at-a-time", unrelated: 100, members: 150, worktreesPerMember: 1, sharedGroup: 1, holders: "each" },
  ];

  it.each(scenarios)("$name: removes each checkout once within its read and write budget", async (scenario) => {
    const result = await runBurst(scenario);
    expect(result.errors).toEqual([]);
    // Each canonical checkout is snapshotted and removed exactly once, whatever
    // alias or how many archived owners reach it.
    expect(result.counts.removals).toBe(result.fleet.checkouts.size);
    expect([...fsModel.removed].sort()).toEqual([...result.fleet.checkouts].sort());
    const checkouts = result.fleet.checkouts.size;
    // Bounded overhead: a constant number of fleet passes plus a constant
    // amount of work per batch member and per removed checkout.
    const fleetRows = result.fleet.rows.size;
    // One fleet pass per queue batch. The burst is one batch; a release that
    // drains the queue before the next one starts its own batch.
    const batches = 1 + (scenario.holders === "each" ? scenario.members : scenario.holders === "one" ? 1 : 0);
    // Linear forms: a fleet pass per batch plus a constant amount of work per
    // batch member and per removed checkout. A quadratic term would be a
    // product of these. The exact counts are the budget below.
    const units = scenario.members + checkouts;
    expect(result.counts.providerRows).toBeLessThanOrEqual(2 * batches * fleetRows + 8 * units);
    expect(result.counts.overlayRows).toBeLessThanOrEqual(2 * batches * fleetRows + 8 * units);
    expect(result.counts.enrichedRows).toBeLessThanOrEqual(2 * batches * fleetRows + 12 * units);
    expect(result.counts.realpathCalls).toBeLessThanOrEqual(2 * batches * fleetRows + 40 * units);
    expect(result.counts.checkpointSerializedBytes).toBeLessThanOrEqual(2_000 * units);
    expect(result.counts.checkpointBytes).toBeLessThanOrEqual(2_000 * units);
    expectScalingBudget(scenario.name, {
      ...result.counts,
      commits: result.writes.commits,
      rowsChanged: result.writes.rowsChanged,
    });
  }, 60_000);
});
