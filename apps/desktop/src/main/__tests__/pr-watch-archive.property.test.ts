import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { buildLegacyEncodedThreadIdentityKey, buildPullRequestStatusKey, type AgentEvent, type PrSummary, type ThreadDependency, type ThreadPullRequestWatchSummary } from "@pwragent/shared";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import { PrStatusWatchCoordinator } from "../pr-status/pr-status-watch";
import { PrAutoDispatchCoordinator } from "../pr-status/pr-auto-dispatch";
import { ThreadDependencyCoordinator } from "../app-server/thread-dependency-coordinator";
import { ThreadDependencyStore } from "../state/thread-dependency-store";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createTempStateDb, openInMemoryStateDb, removeTempStateDbDir } from "./sqlite-test-utils";
import { CountingBackendClient } from "./fixtures/thread-read-harness";

const identity = { backend: "codex" as const, threadId: "watcher" };
const pr: PrSummary = {
  provider: "github.com", org: "fixture", repo: "project", number: 70,
  title: "Fixture", url: "https://github.com/fixture/project/pull/70",
  state: "passing", checkState: "passing", lifecycleState: "merged",
  headSha: "a".repeat(40),
};

function watch(terminal: boolean, id: string): ThreadPullRequestWatchSummary {
  return {
    ...identity, watchId: id, prKey: buildPullRequestStatusKey(pr), prUrl: pr.url,
    prNumber: pr.number, headSha: terminal ? "" : pr.headSha!,
    kind: terminal ? "terminal" : "checks", notifyOn: terminal ? ["merged"] : ["success"],
    createdAt: 1, failureHandledByAutoFix: false,
  };
}

function dependency(id: string): ThreadDependency {
  return {
    ...identity, id, status: "waiting", mode: "all", onFailure: "notify", createdAt: 1, updatedAt: 1, evidence: [],
    conditions: [{ backend: "codex", threadId: "foundation", when: "pr_merged", prUrl: pr.url }],
  };
}

async function lifecycle(terminal: boolean, commands: Array<"register" | "archive" | "restore" | "event">): Promise<void> {
  const db = openInMemoryStateDb();
  const store = new SqliteOverlayStore(db);
  const submitTurnIfIdle = vi.fn(async () => ({ status: "started" as const, turnId: "wake" }));
  const coordinator = new PrStatusWatchCoordinator({ store, registry: { submitTurnIfIdle } });
  let archived = false;
  let subscribed = false;
  let sequence = 1;
  try {
    for (const command of commands) {
      const now = ++sequence;
      if (command === "register") {
        const registration = store.registerThreadPrStatusWatch({ watch: watch(terminal, `watch-${now}`), now });
        if (archived) await expect(registration).rejects.toThrow(/archived/i);
        else { await registration; subscribed = true; }
      } else if (command === "archive") {
        await store.observeArchivedThreads([identity], now);
        archived = true;
        subscribed = false;
      } else if (command === "restore") {
        await store.setThreadArchiveTombstone({ ...identity, restoredAt: now });
        archived = false;
      } else {
        submitTurnIfIdle.mockClear();
        await coordinator.handleStatusSnapshot(terminal ? pr : { ...pr, lifecycleState: "open" }, now);
        expect(submitTurnIfIdle).toHaveBeenCalledTimes(subscribed ? 1 : 0);
        subscribed = false;
      }
      expect((await store.listActiveThreadPrStatusWatches(identity)).length > 0).toBe(subscribed);
    }
  } finally { db.close(); }
}

describe("PR watches end at archive", () => {
  it("retires setting-only legacy Auto-fix overlays without changing live settings", async () => {
    await fc.assert(fc.asyncProperty(
      fc.constantFrom("codex" as const, "claude" as const, "acp:grok" as const),
      fc.constantFrom("archiveRetentionStartedAt", "archiveTombstonedAt"),
      async (backend, archiveField) => {
        const db = openInMemoryStateDb();
        const store = new SqliteOverlayStore(db);
        const target = { backend, threadId: "legacy-setting-only" };
        const live = { backend, threadId: "live-setting-only" };
        try {
          for (const identity of [target, live]) await store.setThreadPrAutoDispatchEnabled({ ...identity, enabled: true });
          // Older releases retained the preference after their PR rows disappeared.
          db.raw.prepare("UPDATE threads SET payload = json_set(payload, ?, 1) WHERE thread_id = ?")
            .run(`$.${archiveField}`, buildLegacyEncodedThreadIdentityKey(backend, target.threadId));
          await store.retireArchivedThreadPrAutomation(2);
          await store.setThreadArchiveTombstone({ ...target, restoredAt: 3 });
          expect((await store.getThreadOverlayState(target))?.prAutoDispatchEnabled).toBe(false);
          expect((await store.getThreadOverlayState(live))?.prAutoDispatchEnabled).toBe(true);
        } finally { db.close(); }
      },
    ), { numRuns: 25 });
  });

  it("publishes retirement updates after the archive transaction for owners and prerequisites", async () => {
    const db = openInMemoryStateDb();
    const store = new SqliteOverlayStore(db);
    const client = new CountingBackendClient([]);
    const registry = new DesktopBackendRegistry({ codexClient: client as never, overlayStore: store, threadTitleGenerationService: null });
    const events: AgentEvent[] = [];
    let watchCount = 1;
    const dependencies = new Set(["codex:watcher", "codex:foundation", "claude:foundation"]);
    registry.onEvent(async (event) => {
      events.push(event);
      if (event.notification.method === "thread/prWatches/updated") {
        expect(db.raw.inTransaction).toBe(false);
        watchCount = (await store.listActiveThreadPrStatusWatches(identity)).length;
      }
      if (event.notification.method === "thread/dependencies/updated") {
        expect(db.raw.inTransaction).toBe(false);
        expect(new ThreadDependencyStore(db.raw).active()).toEqual([]);
        dependencies.delete(`${event.backend}:${event.notification.params.threadId}`);
      }
    });
    try {
      await store.retireArchivedThreadPrAutomation(0);
      await store.registerThreadPrStatusWatch({ watch: watch(true, "retiring-watch"), now: 1 });
      new ThreadDependencyStore(db.raw).register({ ...dependency("retiring-dependency"), conditions: [
        ...dependency("unused").conditions,
        { backend: "claude", threadId: "foundation", when: "pr_merged", prUrl: pr.url },
      ] });
      await client.emitNotification({ method: "thread/archived", params: { threadId: identity.threadId } });
      expect(watchCount).toBe(0);
      expect(dependencies).toEqual(new Set());
      const changed = events.filter((event) => event.notification.method === "thread/prWatches/updated"
        || event.notification.method === "thread/dependencies/updated");
      expect(changed).toHaveLength(4);
      await store.setThreadArchiveTombstone({ ...identity, restoredAt: 3 });
      expect(watchCount).toBe(0);
      events.length = 0;
      await client.emitNotification({ method: "thread/archived", params: { threadId: identity.threadId } });
      expect(events.filter((event) => event.notification.method === "thread/prWatches/updated"
        || event.notification.method === "thread/dependencies/updated")).toEqual([]);
    } finally { await registry.close(); db.close(); }
  });

  it("publishes no retirement updates when archive rolls back", async () => {
    const db = openInMemoryStateDb();
    const store = new SqliteOverlayStore(db);
    const registry = new DesktopBackendRegistry({ codexClient: new CountingBackendClient([]) as never, overlayStore: store, threadTitleGenerationService: null });
    const changed = vi.fn();
    registry.onEvent(changed);
    try {
      await store.registerThreadPrStatusWatch({ watch: watch(true, "kept-watch"), now: 1 });
      db.raw.exec(`CREATE TRIGGER fail_archive_retention BEFORE INSERT ON threads
        WHEN NEW.thread_id = 'codex:watcher' BEGIN SELECT RAISE(ABORT, 'fixture archive failure'); END;`);
      await expect(registry.observeArchivedThreads([identity], 2)).rejects.toThrow("fixture archive failure");
      expect(await store.listActiveThreadPrStatusWatches(identity)).toHaveLength(1);
      expect(changed).not.toHaveBeenCalled();
    } finally { await registry.close(); db.close(); }
  });

  it.each([false, true])("does not replay a pre-archive watch after restore (terminal=%s)", async (terminal) => {
    await lifecycle(terminal, ["register", "archive", "restore", "event"]);
  });

  it("models registration, archive, restore and PR events without reviving old subscriptions", async () => {
    await fc.assert(fc.asyncProperty(fc.boolean(), fc.array(
      fc.constantFrom("register" as const, "archive" as const, "restore" as const, "event" as const),
      { minLength: 1, maxLength: 16 },
    ), lifecycle), { numRuns: 25 });
  });

  it("retires legacy archived subscriptions before startup replays and preserves other identities", async () => {
    const db = openInMemoryStateDb();
    const store = new SqliteOverlayStore(db);
    try {
      await store.registerThreadPrStatusWatch({ watch: watch(true, "old-watch"), now: 1 });
      await store.registerThreadPrStatusWatch({ watch: { ...watch(true, "foreign-watch"), backend: "claude" }, now: 1 });
      // Older versions recorded the archive without retiring subscriptions.
      await store.setThreadArchiveTombstone({ ...identity, archivedAt: 2 });
      expect(await store.retireArchivedThreadPrAutomation(3))
        .toEqual([{ ...identity, prWatchesChanged: true, autoFixChanged: false, dependencies: [] }]);
      expect(await store.listPendingPrTerminalWatchPrKeys(identity)).toEqual([]);
      expect(await store.listThreadPrStatusWatchHistory({ ...identity, limit: 10 }))
        .toEqual([expect.objectContaining({ watchId: "old-watch", status: "cancelled", endedReason: "archived" })]);
      expect(await store.listActiveThreadPrStatusWatches({ ...identity, backend: "claude" })).toHaveLength(1);
    } finally { db.close(); }
  });

  it("retires subscriptions in one archive commit and makes no writes on repeated observations", async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const temp = createTempStateDb("pr-watch-archive-budget-");
    const db = StateDb.open(temp.dbPath);
    const store = new SqliteOverlayStore(db);
    const repairs = new PrAutoDispatchCoordinator({
      store, registry: { submitTurnIfIdle: async () => ({ status: "busy" }) }, now: () => 1,
    });
    try {
      const legacy = { ...identity, threadId: "setting-only-budget" };
      await store.setThreadPrAutoDispatchEnabled({ ...legacy, enabled: true });
      await store.setThreadArchiveTombstone({ ...legacy, archivedAt: 1 });
      const startup = await measureSqliteWrites(() => store.retireArchivedThreadPrAutomation(2));
      expectSqliteWriteBudget({ scenario: "pr-setting-only-startup-retirement", writes: startup.writes,
        note: "Retire one legacy archived Auto-fix preference without live PR rows in one startup commit (~0.012 MB); one startup/day costs ~0.012 MB/day. Repeat scans write nothing." });
      await store.setThreadPrAutoDispatchEnabled({ ...identity, enabled: true });
      await store.syncThreadPrAutoDispatchCandidates({ ...identity, prKeys: [buildPullRequestStatusKey(pr)], now: 1 });
      await repairs.handleStatusSnapshot({
        pr: { ...pr, state: "failing", checkState: "failing", lifecycleState: "open" },
        threadKeys: ["codex:watcher"], observedAt: 1, backgroundPollingEnabled: true,
      });
      new ThreadDependencyStore(db.raw).register(dependency("continuation"));
      for (let index = 0; index < 20; index++) {
        for (const terminal of [false, true]) await store.registerThreadPrStatusWatch({
          watch: { ...watch(terminal, `watch-${index}-${terminal}`), prKey: `github.com/fixture/project#${index}` }, now: 1,
        });
      }
      const archive = await measureSqliteWrites(() => store.observeArchivedThreads([identity], 2));
      expectSqliteWriteBudget({ scenario: "pr-watch-archive-retirement", writes: archive.writes,
        note: "Archive retires 40 watches, a pending repair, Auto-fix candidacy and a prerequisite subscription in one boundary commit (~0.091 MB); 10 archives/day cost ~0.91 MB/day. No per-event or idle commits." });
      const repeated = await measureSqliteWrites(async () => {
        await store.observeArchivedThreads([identity], 3);
        await store.retireArchivedThreadPrAutomation(3);
      });
      expectSqliteWriteBudget({ scenario: "pr-watch-archive-retirement-repeat", writes: repeated.writes,
        note: "Repeated archive observations and startup pruning are read-only once subscriptions are retired: 0 MB/day." });
    } finally { repairs.close(); db.close(); removeTempStateDbDir(temp.tempDir); vi.unstubAllEnvs(); }
  });

  it.each(["claim", "details", "prepare"] as const)("discards a terminal claim archived during %s, even after restore", async (stage) => {
    const db = openInMemoryStateDb();
    const store = new SqliteOverlayStore(db);
    const submitTurnIfIdle = vi.fn(async () => ({ status: "started" as const, turnId: "wake" }));
    const archiveAndRestore = async () => {
      await store.observeArchivedThreads([identity], 2);
      await store.setThreadArchiveTombstone({ ...identity, restoredAt: 3 });
    };
    const prepareTerminalWake = vi.fn(async () => {
      if (stage === "prepare") await archiveAndRestore();
      return [];
    });
    const coordinator = new PrStatusWatchCoordinator({
      store, registry: { submitTurnIfIdle }, prepareTerminalWake,
      fetchTerminalDetails: async () => {
        if (stage === "details") await archiveAndRestore();
        return undefined;
      },
    });
    if (stage === "claim") {
      const claim = store.claimThreadPrTerminalWatches.bind(store);
      vi.spyOn(store, "claimThreadPrTerminalWatches").mockImplementationOnce(async (params) => {
        const claims = await claim(params);
        await archiveAndRestore();
        return claims;
      });
    }
    try {
      await store.registerThreadPrStatusWatch({ watch: watch(true, "old-watch"), now: 1 });
      await coordinator.handleTerminalSnapshot(pr, 4);
      expect(submitTurnIfIdle).not.toHaveBeenCalled();
      expect(await store.listActiveThreadPrStatusWatches(identity)).toEqual([]);
      if (stage !== "prepare") expect(prepareTerminalWake).not.toHaveBeenCalled();
    } finally { db.close(); }
  });
});

describe("Auto-fix ends at archive", () => {
  it("models explicit enable, archive and restore without implicitly re-enabling Auto-fix", async () => {
    await fc.assert(fc.asyncProperty(
      fc.constantFrom("codex" as const, "claude" as const, "acp:grok" as const),
      fc.array(fc.constantFrom("enable" as const, "archive" as const, "restore" as const), { minLength: 1, maxLength: 12 }),
      async (backend, commands) => {
        const db = openInMemoryStateDb();
        const store = new SqliteOverlayStore(db);
        const target = { ...identity, backend };
        let archived = false;
        let enabled = false;
        try {
          for (const [index, command] of commands.entries()) {
            if (command === "enable") {
              const enabling = store.setThreadPrAutoDispatchEnabled({ ...target, enabled: true });
              if (archived) await expect(enabling).rejects.toThrow(/archived/i);
              else { await enabling; enabled = true; }
            } else if (command === "archive") {
              await store.observeArchivedThreads([target], index);
              archived = true;
              enabled = false;
            } else {
              await store.setThreadArchiveTombstone({ ...target, restoredAt: index });
              archived = false;
            }
            expect((await store.getThreadOverlayState(target))?.prAutoDispatchEnabled === true).toBe(enabled);
            await store.syncThreadPrAutoDispatchCandidates({ ...target, prKeys: [buildPullRequestStatusKey(pr)], now: index });
            const winner = await store.getPrAutoDispatchCandidateWinner({ prKey: buildPullRequestStatusKey(pr) });
            expect(winner !== undefined).toBe(enabled);
          }
        } finally { db.close(); }
      },
    ), { numRuns: 25 });
  });

  it.each(["pending", "reserving", "busy"] as const)("discards a repair archived while %s and does not rearm on restore", async (stage) => {
    const db = openInMemoryStateDb();
    const store = new SqliteOverlayStore(db);
    const failedPr = { ...pr, lifecycleState: "open" as const, checkState: "failing" as const, state: "failing" as const };
    const archiveAndRestore = async () => {
      await store.observeArchivedThreads([identity], 2);
      await store.setThreadArchiveTombstone({ ...identity, restoredAt: 3 });
    };
    const submitTurnIfIdle = vi.fn(async () => {
      if (stage === "busy") await archiveAndRestore();
      return { status: "busy" as const };
    });
    const coordinator = new PrAutoDispatchCoordinator({
      store, registry: { submitTurnIfIdle }, now: () => 1,
      isBackgroundPollingEnabled: () => true, getCurrentPr: () => failedPr, isPrAttached: () => true,
    });
    try {
      await store.setThreadPrAutoDispatchEnabled({ ...identity, enabled: true });
      await store.syncThreadPrAutoDispatchCandidates({ ...identity, prKeys: [buildPullRequestStatusKey(pr)], now: 1 });
      await coordinator.handleStatusSnapshot({ pr: failedPr, threadKeys: ["codex:watcher"], observedAt: 1, backgroundPollingEnabled: true });
      const pending = await store.getThreadPrAutoDispatchPending(identity);
      expect(pending).toBeDefined();
      if (stage === "pending") await archiveAndRestore();
      if (stage === "reserving") {
        const reserve = store.reserveThreadPrAutoDispatchBudget.bind(store);
        vi.spyOn(store, "reserveThreadPrAutoDispatchBudget").mockImplementationOnce(async (params) => {
          const reserved = await reserve(params);
          await archiveAndRestore();
          return reserved;
        });
      }
      await coordinator.sendPendingNow({ ...identity, fingerprint: pending!.pending.fingerprint });
      expect(submitTurnIfIdle).toHaveBeenCalledTimes(stage === "busy" ? 1 : 0);
      expect((await store.getThreadOverlayState(identity))?.prAutoDispatchEnabled).toBe(false);
      expect(await store.getThreadPrAutoDispatchPending(identity)).toBeUndefined();
      expect(await store.getPrAutoDispatchCandidateWinner({ prKey: buildPullRequestStatusKey(pr) })).toBeUndefined();
      await coordinator.handleStatusSnapshot({ pr: failedPr, threadKeys: ["codex:watcher"], observedAt: 4, backgroundPollingEnabled: true });
      expect(await store.getThreadPrAutoDispatchPending(identity)).toBeUndefined();
      expect(await store.getThreadPrAutoDispatchAttemptCount({ ...identity, prKey: buildPullRequestStatusKey(pr) })).toBe(0);
      expect(await store.getPrAutoDispatchBudgetStatus({
        config: { capacity: 30, refillPerMinute: 1, pauseWhenEmpty: true }, now: 4,
      })).toMatchObject({ availableTokens: 30 });
    } finally { coordinator.close(); db.close(); }
  });
});

describe("PR prerequisite subscriptions end at archive", () => {
  it("models registration, archive, restore and prerequisite events without replay", async () => {
    await fc.assert(fc.asyncProperty(fc.array(
      fc.constantFrom("register" as const, "archive" as const, "restore" as const, "event" as const),
      { minLength: 1, maxLength: 12 },
    ), async (commands) => {
      const db = openInMemoryStateDb();
      const overlays = new SqliteOverlayStore(db);
      const store = new ThreadDependencyStore(db.raw);
      const submit = vi.fn(async () => ({ status: "started" as const, turnId: "wake" }));
      const coordinator = new ThreadDependencyCoordinator({
        store, submit, readThread: async () => ({ turns: [], prs: [{ pr, fetchedAt: 1 }] }), changed: async () => {}, now: () => 1,
      });
      let archived = false;
      let subscribed = false;
      try {
        for (const [index, command] of commands.entries()) {
          if (command === "register") {
            if (archived) expect(() => store.register(dependency(`dependency-${index}`))).toThrow(/archived/i);
            else { store.register(dependency(`dependency-${index}`)); subscribed = true; }
          } else if (command === "archive") {
            await overlays.observeArchivedThreads([identity], index);
            archived = true;
            subscribed = false;
          } else if (command === "restore") {
            await overlays.setThreadArchiveTombstone({ ...identity, restoredAt: index });
            archived = false;
          } else {
            submit.mockClear();
            await coordinator.handlePrEvent(pr.url);
            expect(submit).toHaveBeenCalledTimes(subscribed ? 1 : 0);
            subscribed = false;
          }
          expect(store.active().length > 0).toBe(subscribed);
        }
      } finally { db.close(); }
    }), { numRuns: 25 });
  });

  it("discards a claimed continuation archived during publication even after restore", async () => {
    const db = openInMemoryStateDb();
    const overlays = new SqliteOverlayStore(db);
    const store = new ThreadDependencyStore(db.raw);
    const submit = vi.fn(async () => ({ status: "started" as const, turnId: "wake" }));
    const coordinator = new ThreadDependencyCoordinator({
      store, submit, readThread: async () => ({ turns: [], prs: [{ pr, fetchedAt: 1 }] }), now: () => 1,
      changed: async (item) => {
        if (item.status !== "dispatching") return;
        await overlays.observeArchivedThreads([identity], 2);
        await overlays.setThreadArchiveTombstone({ ...identity, restoredAt: 3 });
      },
    });
    try {
      store.register(dependency("old-continuation"));
      await coordinator.handlePrEvent(pr.url);
      expect(submit).not.toHaveBeenCalled();
      expect(store.get(identity.backend, identity.threadId, "old-continuation")?.status).toBe("cancelled");
    } finally { db.close(); }
  });
});
