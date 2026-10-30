import type { FederatedThreadTargetRuntime } from "../federation/federated-thread-target-service";
import { archiveCandidateProtectionReason } from "../app-server/thread-archive-sweeper";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppServerThreadSummary, ManageThreadMergeHoldsRequest } from "@pwragent/shared";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { appendMergeHoldDependents, assertNoMergeHolds, qualifyMergeHoldOwners, validateMergeHoldRequest } from "../thread-merge-holds/thread-merge-holds";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createTempStateDb, removeTempStateDbDir, openInMemoryStateDb } from "./sqlite-test-utils";
import { resolveAgentToolCatalogs } from "../agent-tools/agent-tool-catalog-registry";
import { searchPwrAgentTools } from "../agent-tools/pwragent-tool-search";

let db: StateDb;
let store: SqliteOverlayStore;
let tempDir: string | undefined;
const waiting = { backend: "codex" as const, threadId: "waiting" };
const request = {
  ...waiting, action: "create" as const, reason: "Waiting for Windows validation",
  releaseWhen: "Reconcile the validation findings with PR #17",
  dependency: { backend: "codex" as const, threadId: "validation", title: "Windows investigation", target: { scope: "remote" as const, instanceId: "offline-windows" } },
};
beforeEach(() => { db = openInMemoryStateDb(); store = new SqliteOverlayStore(db); });
afterEach(() => { db.close(); if (tempDir) removeTempStateDbDir(tempDir); tempDir = undefined; vi.unstubAllEnvs(); });

describe("merge holds", () => {
  it("persists an offline prerequisite without locking work, then requires explicit findings to release it", async () => {
    const temp = createTempStateDb("pwragent-merge-holds-reopen-");
    tempDir = temp.tempDir; db.close(); db = StateDb.open(temp.dbPath); store = new SqliteOverlayStore(db);
    const [hold] = store.manageThreadMergeHolds(request, "agent:codex:waiting", 1);
    expect(hold).toMatchObject({ status: "waiting", dependency: request.dependency });
    db.close(); db = StateDb.open(temp.dbPath);
    const reopened = new SqliteOverlayStore(db);
    expect(reopened.listActiveThreadMergeHolds()).toEqual([hold]);
    expect(await reopened.getThreadOverlayState(waiting)).not.toHaveProperty("lock");
    await reopened.setThreadReaction({ ...waiting, emoji: "✅", present: true });
    expect(reopened.listActiveThreadMergeHolds()).toHaveLength(1);
    expect(archiveCandidateProtectionReason({
      thread: { id: waiting.threadId, source: "codex", titleSource: "explicit", title: "Windows MCP link", linkedDirectories: [], threadStatus: "idle" },
      overlay: await reopened.getThreadOverlayState(waiting),
    })).toBe("Merge held");
    await reopened.forgetThreadArchiveStates([waiting]);
    expect(reopened.listActiveThreadMergeHolds()).toHaveLength(1);
    expect(() => reopened.manageThreadMergeHolds({ ...waiting, action: "resolve", holdId: hold!.id }, "operator")).toThrow(/note/);
    const resolved = reopened.manageThreadMergeHolds({ ...waiting, action: "resolve", holdId: hold!.id, note: "Validated on Windows; findings reconciled." }, "peer:windows", 2);
    expect(resolved[0]).toMatchObject({ status: "resolved", resolution: { actor: "peer:windows", at: 2, note: "Validated on Windows; findings reconciled." } });
    expect(reopened.listActiveThreadMergeHolds()).toEqual([]);
    expect(() => assertNoMergeHolds(resolved, waiting)).not.toThrow();
  });

  it("holds all attached PR merge paths, including another thread and a PR attached after creation", async () => {
    const [hold] = store.manageThreadMergeHolds(request, "operator");
    const pr = { provider: "github.com", org: "fixture", repo: "project", number: 17, url: "https://github.com/fixture/project/pull/17", state: "passing" as const, checks: "success" as const, mergeState: "mergeable" as const };
    await store.setThreadPullRequests({ ...waiting, prs: [pr] });
    const active = store.listActiveThreadMergeHolds();
    expect(() => assertNoMergeHolds(active, waiting)).toThrow(/Merge held/);
    expect(() => assertNoMergeHolds(active, { backend: "claude", threadId: "other", pullRequest: "https://github.com/FIXTURE/project/pull/17/files?x=1" })).toThrow(/Merge held/);
    expect(() => assertNoMergeHolds(active, { backend: "codex", threadId: "other", pullRequest: "https://github.com/unrelated/project/pull/17" })).not.toThrow();
    await store.setThreadPullRequests({ ...waiting, prs: [] });
    expect(() => assertNoMergeHolds(store.listActiveThreadMergeHolds(), { backend: "claude", threadId: "other", pullRequest: pr.url })).toThrow(/Merge held/);
    store.manageThreadMergeHolds({ ...waiting, action: "cancel", holdId: hold!.id, note: "The operator removed this prerequisite." }, "operator");
    expect(() => assertNoMergeHolds(store.listActiveThreadMergeHolds(), waiting)).not.toThrow();
  });

  it("requires every hold to clear and projects active holds into bounded navigation rows", () => {
    const [first] = store.manageThreadMergeHolds(request, "operator");
    store.manageThreadMergeHolds({ ...request, reason: "Waiting for review" }, "operator");
    const provider: AppServerThreadSummary = { id: waiting.threadId, source: "codex", title: "Windows MCP link", titleSource: "explicit", linkedDirectories: [] };
    expect(store.readNavigationQueryIndex({ backend: "all", threads: [provider] }).threads[0]?.mergeHolds).toHaveLength(2);
    store.manageThreadMergeHolds({ ...waiting, action: "resolve", holdId: first!.id, note: "Windows validation reconciled" }, "operator");
    expect(() => assertNoMergeHolds(store.listActiveThreadMergeHolds(), waiting)).toThrow(/review/);
    expect(store.readNavigationQueryIndex({ backend: "all", threads: [provider] }).threads[0]?.mergeHolds).toHaveLength(1);
  });

  it("finds remote dependents on their owner and qualifies completion targets for a remote viewer", async () => {
    const [hold] = store.manageThreadMergeHolds({ ...request, dependency: {
      ...request.dependency, target: { scope: "remote", instanceId: "windows" },
    } }, "operator");
    const read = vi.fn(async () => ({ holds: [hold], dependents: [] }));
    const runtime = {
      health: async () => ({ instanceId: "windows" }),
      connectedPeerTargets: () => [{ label: "Mac", target: { scope: "remote", instanceId: "mac" }, capabilities: ["turn_control"] }],
      remoteBackend: () => ({ manageThreadMergeHolds: read }),
    } as unknown as FederatedThreadTargetRuntime;
    const response = await appendMergeHoldDependents({ holds: [], dependents: [] }, { action: "list", backend: "codex", threadId: "validation" }, runtime);
    expect(response.dependents).toEqual([{ hold, owner: { scope: "remote", instanceId: "mac" } }]);
    expect(read).toHaveBeenCalledExactlyOnceWith({ action: "active" });
    expect(qualifyMergeHoldOwners(response, { scope: "remote", instanceId: "windows" }, "mac").dependents[0]?.owner).toEqual({ scope: "local" });
    expect(qualifyMergeHoldOwners({ holds: [], dependents: [{ hold: hold! }] }, { scope: "remote", instanceId: "windows" }, "mac").dependents[0]?.owner).toEqual({ scope: "remote", instanceId: "windows" });
    await appendMergeHoldDependents({ holds: [], dependents: [] }, { action: "active" }, runtime);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("refuses self dependencies and malformed release actions", () => {
    expect(() => validateMergeHoldRequest({ ...request, dependency: { ...waiting, target: { scope: "local" } } })).toThrow(/itself/);
    for (const patch of [{ releaseWhen: " " }, { reason: "x".repeat(2001) }, { dependency: { ...request.dependency, target: { scope: "remote" } } }]) {
      expect(() => validateMergeHoldRequest({ ...request, ...patch } as ManageThreadMergeHoldsRequest)).toThrow();
    }
  });

  it.each(["mark us waiting on another thread", "do not merge until the dependency finishes", "soft lock merge hold", "clear merge dependency"])("makes the tool discoverable for %s", (query) => {
    const dynamic = resolveAgentToolCatalogs({}).flatMap((catalog) => catalog.dynamicTools);
    expect(searchPwrAgentTools(dynamic, query).map((tool) => tool.name)).toContain("manage_thread_merge_holds");
  });

  it("writes only once per explicit transition, with no writes for reads or repeated actions", async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const temp = createTempStateDb("pwragent-merge-hold-budget-");
    const measuredDb = StateDb.open(temp.dbPath);
    try {
      const measured = new SqliteOverlayStore(measuredDb);
      const { writes } = await measureSqliteWrites(async () => {
        const [hold] = measured.manageThreadMergeHolds(request, "operator");
        measured.manageThreadMergeHolds(request, "operator");
        measured.manageThreadMergeHolds({ ...waiting, action: "list" }, "operator");
        measured.listActiveThreadMergeHolds();
        const resolve = { ...waiting, action: "resolve" as const, holdId: hold!.id, note: "Findings reconciled" };
        measured.manageThreadMergeHolds(resolve, "operator");
        measured.manageThreadMergeHolds(resolve, "operator");
      });
      expectSqliteWriteBudget({ scenario: "thread-merge-hold-lifecycle", writes,
        note: "One commit per create/resolve; reads and duplicate actions write nothing. No timer, turn, or streamed-event writes. Measured 28,872 WAL bytes/lifecycle; 50 lifecycles/day project 1.44 MB/day.",
      });
    } finally { measuredDb.close(); removeTempStateDbDir(temp.tempDir); }
  });
});
