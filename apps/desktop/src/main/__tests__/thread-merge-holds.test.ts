import type { FederatedThreadTargetRuntime } from "../federation/federated-thread-target-service";
import { archiveCandidateProtectionReason } from "../app-server/thread-archive-sweeper";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppServerThreadSummary, ManageThreadMergeHoldsRequest } from "@pwragent/shared";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { appendMergeHoldDependents, assertNoMergeHolds, buildMergeHoldReminder, qualifyMergeHoldOwners, validateMergeHoldRequest } from "../thread-merge-holds/thread-merge-holds";
import { ThreadTodoService } from "../thread-todos/thread-todo-service";
import { ThreadTodoStore } from "../thread-todos/thread-todo-store";
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

  it("raises the operator's reminder with the hold in one commit when it is marked done, and only then", async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const temp = createTempStateDb("pwragent-merge-hold-reminder-");
    const measuredDb = StateDb.open(temp.dbPath);
    try {
      const measured = new SqliteOverlayStore(measuredDb);
      const todos = new ThreadTodoService({ store: new ThreadTodoStore(measuredDb) });
      const remind = (hold: Parameters<typeof buildMergeHoldReminder>[0], stillWaiting: number) =>
        todos.raiseForDependency(buildMergeHoldReminder(hold, stillWaiting)).todo.id;
      const [hold] = measured.manageThreadMergeHolds({ ...request, followUp: ["Rebase onto #3291", "Merge #17"], offerToSend: true }, "operator");
      const other = measured.manageThreadMergeHolds({ ...request, reason: "Review" }, "operator").find((item) => item.reason === "Review");
      const resolve = { ...waiting, action: "resolve" as const, holdId: hold!.id, note: "Validated on Windows." };
      const { writes } = await measureSqliteWrites(async () => {
        measured.manageThreadMergeHolds(resolve, "agent:codex:validation", 5, remind);
        measured.manageThreadMergeHolds(resolve, "agent:codex:validation", 6, remind);
      });
      expect(writes.commits).toBe(1);
      expectSqliteWriteBudget({ scenario: "thread-merge-hold-reminder", writes,
        note: "Marking a wait done and raising its reminder card share one commit; a repeat writes nothing. Only an explicit Mark Done writes, never a timer, turn, or streamed event.",
      });
      const cards = todos.list({ backend: "codex", threadId: "waiting" });
      expect(cards).toHaveLength(1);
      expect(cards[0]).toMatchObject({
        kind: "handoff", dependencyId: `merge-hold:${hold!.id}`,
        title: "Windows investigation done: Rebase onto #3291 (+1 more)",
        items: [{ text: "Rebase onto #3291", checked: false }, { text: "Merge #17", checked: false }],
        action: { type: "send_message", target: { backend: "codex", threadId: "waiting" } },
      });
      expect(cards[0]!.detail).toBe("Waited for: Waiting for Windows validation\nDone: Validated on Windows.\nMarked done by Windows investigation.\nMerging still waits on one other wait.");
      expect(measured.manageThreadMergeHolds({ ...waiting, action: "list" }, "operator").find((item) => item.id === hold!.id)?.reminderTodoId).toBe(cards[0]!.id);
      measured.manageThreadMergeHolds({ ...waiting, action: "cancel", holdId: other!.id, note: "Not needed." }, "operator", 7, remind);
      expect(todos.list({ backend: "codex", threadId: "waiting" })).toHaveLength(1);
    } finally { measuredDb.close(); removeTempStateDbDir(temp.tempDir); }
  });

  it("rolls the hold back when its reminder cannot be raised", () => {
    const [hold] = store.manageThreadMergeHolds(request, "operator");
    expect(() => store.manageThreadMergeHolds({ ...waiting, action: "resolve", holdId: hold!.id, note: "Done" }, "operator", 2, () => { throw new Error("to-do store unavailable"); }))
      .toThrow(/to-do store unavailable/);
    expect(store.listActiveThreadMergeHolds().map((item) => item.id)).toEqual([hold!.id]);
  });

  it("builds a plain reminder without steps, and never offers to send without them", () => {
    const resolved = { ...store.manageThreadMergeHolds({ ...request, dependency: undefined }, "operator")[0]!, status: "resolved" as const, resolution: { note: "Reviewed.", actor: "operator", at: 2 } };
    const card = buildMergeHoldReminder(resolved, 0);
    expect(card).toMatchObject({ title: "Waiting for Windows validation done", detail: "Waited for: Waiting for Windows validation\nDone: Reviewed.\nMarked done by you.\nMerging is no longer held." });
    expect(card).not.toHaveProperty("items");
    expect(card).not.toHaveProperty("action");
    expect(buildMergeHoldReminder({ ...resolved, followUp: ["x".repeat(200)] }, 0).title.length).toBeLessThanOrEqual(120);
    expect(() => validateMergeHoldRequest({ ...request, offerToSend: true })).toThrow(/followUp/);
    expect(() => validateMergeHoldRequest({ ...request, followUp: Array.from({ length: 13 }, () => "step") })).toThrow(/at most 12/);
    expect(() => validateMergeHoldRequest({ ...request, followUp: [" "] })).toThrow(/followUp\[0\]/);
  });

  it("refuses self dependencies and malformed release actions", () => {
    expect(() => validateMergeHoldRequest({ ...request, dependency: { ...waiting, target: { scope: "local" } } })).toThrow(/itself/);
    expect(() => validateMergeHoldRequest({ ...request, releaseWhen: undefined })).not.toThrow();
    for (const patch of [{ releaseWhen: " " }, { reason: " " }, { reason: "x".repeat(2001) }, { dependency: { ...request.dependency, target: { scope: "remote" } } }]) {
      expect(() => validateMergeHoldRequest({ ...request, ...patch } as ManageThreadMergeHoldsRequest)).toThrow();
    }
  });

  it.each(["mark us waiting on another thread", "do not merge until the dependency finishes", "soft lock merge hold", "clear merge dependency", "when that thread is done remind me to"])("makes the tool discoverable for %s", (query) => {
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
