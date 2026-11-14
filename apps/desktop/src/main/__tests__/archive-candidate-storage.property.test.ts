import { ChildProcess, execFile } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import type { ThreadSubAgentSummary } from "@pwragent/shared";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { THREAD_SUB_AGENTS_MOVED_META_KEY } from "../state/thread-sub-agents";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { ARCHIVE_ACTIVE_SUB_AGENT_STATUSES } from "../app-server/thread-archive-sweeper";
import { resolveWorktreeRepositoryDirectory } from "../app-server/thread-directory-enricher";
import { CodexAppServerClient } from "../codex-app-server/desktop-client";
import { archiveCoordinatorStandIn } from "./helpers/archive-coordinator-stand-in";
import { ArchiveCleanupTransport } from "./fixtures/archive-cleanup-transport";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createTempStateDb, openInMemoryStateDb, removeTempStateDbDir } from "./sqlite-test-utils";
import budgets from "./fixtures/archive-candidate-budgets.json";

vi.mock("../codex-app-server/stdio-transport", async () => ({
  StdioJsonRpcTransport: (await import("./fixtures/archive-cleanup-transport")).ArchiveCleanupTransport,
}));
vi.mock("../log", () => ({ getMainLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }));
vi.mock("node:timers/promises", () => ({ setTimeout: async (ms: number) => {
  expect(ms).toBe(25);
  await new Promise<void>((resolve) => setImmediate(resolve));
} }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("archive candidate subagent projection", () => {
  // Oracle: the existing attention read followed by the archive status
  // predicate. Generated writes use the store's own card update path.
  it("matches attention membership across providers and card lifecycle updates", async () => {
    const db = openInMemoryStateDb();
    const store = new SqliteOverlayStore(db);
    try {
      await fc.assert(fc.asyncProperty(fc.array(fc.record({
        backend: fc.constantFrom("codex", "claude", "acp:grok"), threadId: fc.integer({ min: 0, max: 4 }),
        monitor: fc.integer({ min: 0, max: 3 }), ended: fc.boolean(),
        status: fc.constantFrom("pending", "running", "cancelling", "blocked", "completed", "failed", "failure", "cancelled"),
      }), { minLength: 25, maxLength: 60, size: "max" }), async (writes) => {
        db.raw.exec("DELETE FROM thread_sub_agents");
        for (const [sequence, write] of writes.entries()) await store.upsertThreadSubAgent({
          backend: write.backend, threadId: String(write.threadId), subAgent: {
            monitorId: `worker-${write.monitor}`, status: write.status,
            createdAt: sequence + 1, updatedAt: sequence + 1, ...(write.ended ? { completedAt: sequence + 1 } : {}),
          } as ThreadSubAgentSummary,
        });
        for (const backend of ["codex", "claude", "acp:grok"] as const) {
          const threadIds = ["0", "1", "2", "3", "4", "missing"];
          const expected: string[] = [];
          for (const threadId of threadIds) {
            const cards = await store.listActiveThreadSubAgents({ backend, threadId });
            if (cards.some((card) => ARCHIVE_ACTIVE_SUB_AGENT_STATUSES.includes(card.status))) expected.push(threadId);
          }
          expect(await store.listArchiveActiveSubAgentThreadIds({ backend, threadIds, statuses: ARCHIVE_ACTIVE_SUB_AGENT_STATUSES })).toEqual(expected);
        }
      }), { numRuns: 25 });
    } finally { db.close(); }
  });

  it("protects legacy cards without migration writes and sees later status changes", async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const db = openInMemoryStateDb();
    const store = new SqliteOverlayStore(db);
    try {
      // An old profile before the existing background move has visited it.
      db.raw.exec("DROP TRIGGER thread_sub_agents_capture_insert; DROP TRIGGER thread_sub_agents_capture_update;");
      db.raw.prepare("DELETE FROM meta WHERE key = ?").run(THREAD_SUB_AGENTS_MOVED_META_KEY);
      const seed = (status: string) => db.raw.prepare("INSERT OR REPLACE INTO threads(thread_id, payload) VALUES (?, ?)").run("codex:legacy",
        JSON.stringify({ backend: "codex", threadId: "legacy", subAgents: [{ monitorId: "worker", status }] }));
      seed("running");
      const params = { backend: "codex" as const, threadIds: ["legacy", "missing"], statuses: ARCHIVE_ACTIVE_SUB_AGENT_STATUSES };
      const { writes } = await measureSqliteWrites(async () => {
        expect(await store.listArchiveActiveSubAgentThreadIds(params)).toEqual(["legacy"]);
      });
      expect(writes.commits).toBe(0);
      expect(db.raw.prepare("SELECT count(*) AS n FROM thread_sub_agents").get()).toEqual({ n: 0 });
      seed("completed");
      expect(await store.listArchiveActiveSubAgentThreadIds(params)).toEqual([]);
    } finally { db.close(); }
  });
});

it("budgets complete discovery at N and 2N, and an unchanged second action, with zero commits", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const temp = createTempStateDb("pwragent-candidate-budget-");
  const db = StateDb.open(temp.dbPath);
  const store = new SqliteOverlayStore(db);
  const client = new CodexAppServerClient({ threadDirectoryEnricher: async () => { throw new Error("Candidate pages must defer Git to the pass resolver"); } });
  try {
    const root = await realpath(temp.tempDir);
    const repo = path.join(root, "repo");
    await mkdir(repo);
    const execute = promisify(execFile);
    const git = async (args: string[]) => await execute("git", ["-C", repo, "-c", "user.name=Fixture",
      "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", ...args]);
    await git(["init", "-b", "main"]);
    await git(["commit", "--allow-empty", "-m", "fixture"]);
    const checkouts = Array.from({ length: 3 }, (_, index) => path.join(root, `checkout-${index}`));
    for (const [index, checkout] of checkouts.entries()) await git(["worktree", "add", "-b", `fixture-${index}`, checkout]);
    db.raw.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, '1')").run(THREAD_SUB_AGENTS_MOVED_META_KEY);
    db.raw.transaction(() => {
      for (let id = 0; id < 400; id += 1) db.raw.prepare("INSERT INTO threads(thread_id, payload) VALUES (?, ?)").run(
        `codex:${id}`,
        JSON.stringify({ backend: "codex", threadId: String(id), extraLinkedDirectories: [],
          managedReviewEntries: [{ text: "contrived history ".repeat(1000) }] }));
    })();
    await client.getInitializeResult();
    const transport = ArchiveCleanupTransport.latest;
    const resolver = vi.fn(resolveWorktreeRepositoryDirectory);
    const coordinator = archiveCoordinatorStandIn({ overlayStore: store,
      registry: () => ({ subAgentStartupReconciliation: Promise.resolve(), isBootstrapModeFn: () => false,
        isCodexBootstrapDeferredFn: () => false, acpWorktreeRepositoryResolver: resolver }),
      providers: { codex: client, acp: { archiveCleanupBackendIds: async () => [] }, claude: { listThreads: async () => [] } },
    });
    const prepare = db.raw.prepare.bind(db.raw);
    let reads = 0;
    const plans: string[] = [];
    vi.spyOn(db.raw, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      const observe = (args: unknown[]) => {
        reads += 1;
        if (/^\s*SELECT/.test(sql)) plans.push(...(prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{ detail: string }>).map((row) => row.detail));
      };
      const all = statement.all.bind(statement);
      const get = statement.get.bind(statement);
      statement.all = (...args: unknown[]) => { observe(args); return all(...args); };
      statement.get = (...args: unknown[]) => { observe(args); return get(...args); };
      return statement;
    });
    const spawn = vi.spyOn(ChildProcess.prototype as unknown as { spawn: (options: unknown) => unknown }, "spawn");
    for (const [scenario, count] of [["cold-200", 200], ["unchanged-200", 200], ["double-400", 400]] as const) {
      transport.rows = { active: Array.from({ length: count / 2 }, (_, id) => ({ id: String(id), cwd: checkouts[id % 3]! })),
        archived: Array.from({ length: count / 2 }, (_, index) => ({ id: String(index + count / 2), cwd: checkouts[index % 3]! })) };
      transport.listings.length = 0;
      reads = 0;
      resolver.mockClear();
      spawn.mockClear();
      const { result: candidates, writes } = await measureSqliteWrites(() => coordinator.listAutoArchiveCandidates());
      const measured = { identities: candidates.length, providerPages: transport.listings.length,
        canonicalObservations: resolver.mock.calls.length, childProcesses: spawn.mock.calls.length, sqlReads: reads };
      expect(measured, scenario).toEqual(budgets[scenario]);
      expect(candidates.filter(({ thread }) => thread.archivedAt !== undefined)).toHaveLength(count / 2);
      expect(candidates.every((candidate) => !candidate.unreadable)).toBe(true);
      expect(candidates.every(({ thread }) => thread.linkedDirectories.some((directory) => directory.kind === "worktree"
        && directory.path === repo && checkouts.includes(directory.worktreePath!)))).toBe(true);
      expect(candidates.every((candidate) => candidate.overlay?.managedReviewEntries === undefined)).toBe(true);
      expectSqliteWriteBudget({ scenario: `archive-candidates-${scenario}`, writes,
        note: "Complete active and archived candidate discovery; read-only batches, 0 commits and 0 MB/day at any sweep cadence." });
    }
    expect(plans.some((plan) => /SEARCH thread_sub_agents.*thread_sub_agents_attention/.test(plan)), [...new Set(plans)].join("\n")).toBe(true);
    expect(plans.some((plan) => /SCAN (threads|thread_sub_agents)\b/.test(plan))).toBe(false);
    await coordinator.stopThreadArchiveSweeper();
  } finally { await client.close(); db.close(); removeTempStateDbDir(temp.tempDir); }
});

it("paces raw normalization and minimal directory rows without changing the provider result (oracle)", async () => {
  const client = new CodexAppServerClient({ threadDirectoryEnricher: async () => { throw new Error("Unexpected Git enrichment"); } });
  try {
    await client.getInitializeResult();
    await fc.assert(fc.asyncProperty(fc.integer({ min: 17, max: 100 }), async (count) => {
      ArchiveCleanupTransport.latest.rows = { active: Array.from({ length: count }, (_, id) => ({
        id: `row-${id}`, cwd: "/fixture/workspace", preview: "contrived title and preview ".repeat(100),
      })), archived: [] };
      const params = { archived: false, limit: 100, checkpoint: async () => {}, directoryFilter: async () => false };
      const baseline = await client.listArchiveCleanupThreadsPage(params);
      const rowCheckpoint = vi.fn(async () => {});
      expect(await client.listArchiveCleanupThreadsPage({ ...params, rowCheckpoint })).toEqual(baseline);
      // Before each raw iterator step (including done), then each directory
      // row, even though the directory filter skips Git.
      expect(rowCheckpoint).toHaveBeenCalledTimes(2 * count + 1);
    }), { numRuns: 10 });
  } finally { await client.close(); }
});
