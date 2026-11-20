import { mkdir, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildDependencyTodo, ThreadDependencyCoordinator } from "../app-server/thread-dependency-coordinator";
import { authorizeLocalFile, LOCAL_FILE_CHECK_INTERVAL_MS, LocalFilePoller, readLocalFile } from "../app-server/thread-dependency-local-files";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites } from "../state/sqlite-write-metrics";
import { ThreadDependencyStore } from "../state/thread-dependency-store";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

describe("observing an existing local watcher", () => {
  let db: StateDb;
  let tempDir: string;
  let store: ThreadDependencyStore;
  let terminal: Set<string>;
  const probe = vi.fn(async (filename: string) => terminal.has(filename));
  const submit = vi.fn(async (_request: { threadId: string }) => ({ status: "started" as const, turnId: "result-turn" }));

  const coordinator = (overrides: Partial<ConstructorParameters<typeof ThreadDependencyCoordinator>[0]> = {}) => new ThreadDependencyCoordinator({
    store, authorizeLocalFile: async (_thread, file) => file,
    readLocalFile: async (file) => await probe(file.path) ? "result" : undefined,
    readThread: async () => ({ turns: [], prs: [] }),
    submit, changed: async () => undefined,
    ...overrides,
  });
  const register = (owner: ThreadDependencyCoordinator, threadId: string, path: string, continuation = "Report the release result.") =>
    owner.manage({
      action: "create", backend: "codex", threadId,
      conditions: [{ when: "local_file", backend: "codex", threadId: "", localFile: { path, since: 1 } }],
      continuation,
    });

  beforeEach(() => {
    vi.stubEnv("PWRAGENT_DEV_SQLITE_WRITE_METRICS", "1");
    const temp = createTempStateDb("pwragent-local-file-dependencies-");
    tempDir = temp.tempDir;
    db = StateDb.open(temp.dbPath);
    store = new ThreadDependencyStore(db.raw);
    terminal = new Set();
    probe.mockClear();
    submit.mockClear();
  });

  afterEach(() => { db.close(); removeTempStateDbDir(tempDir); vi.unstubAllEnvs(); vi.useRealTimers(); });

  it("keeps one observer through unchanged signing waits and delivers once when the same watcher finishes", async () => {
    const path = "/release/watch-ci/terminal.marker";
    let owner = coordinator();
    await register(owner, "release", path);
    const { writes } = await measureSqliteWrites(async () => {
      for (let i = 0; i < 100; i++) await owner.checkLocalFiles();
      await register(owner, "release", path, "Observation restored. Report the result when ready.");
      owner = coordinator();
      await owner.checkLocalFiles();
    });
    expectSqliteWriteBudget({
      scenario: "thread-dependency-local-file-pending",
      note: "100 pending marker checks, one redundant registration and restart: zero commits and 0 MB/day while it waits.",
      writes,
    });
    expect(submit).not.toHaveBeenCalled();
    expect(probe).toHaveBeenCalledTimes(101);
    expect(store.active()).toHaveLength(1);
    terminal.add(path);
    await Promise.all([owner.checkLocalFiles(), coordinator().checkLocalFiles()]);
    await register(owner, "release", path);
    expect(submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ threadId: "release" }));
    expect(store.active()).toHaveLength(0);
  });

  it("checks at a bounded cadence and stops after the first result", async () => {
    vi.useFakeTimers();
    const marker = "/release/watch-ci/terminal.marker";
    const owner = coordinator();
    await register(owner, "release", marker);
    const poller = new LocalFilePoller({
      hasPending: () => owner.hasPendingLocalFiles(),
      check: () => owner.checkLocalFiles(),
      onError: (error) => { throw error; },
    });
    try {
      poller.sync(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(probe).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5 * LOCAL_FILE_CHECK_INTERVAL_MS - 1);
      expect(probe).toHaveBeenCalledTimes(5);
      expect(submit).not.toHaveBeenCalled();
      terminal.add(marker);
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(probe).toHaveBeenCalledTimes(6);
      expect(submit).toHaveBeenCalledTimes(1);
    } finally {
      poller.dispose();
    }
  });

  it("discards a probe that completes after cancellation and never replays an uncertain admission", async () => {
    const marker = "/release/watch-ci/terminal.marker";
    const result = Promise.withResolvers<"result">();
    const admit = vi.fn(async () => { throw new Error("Connection lost during provider turn/start"); });
    const owner = coordinator({ readLocalFile: () => result.promise, submit: admit });
    const { dependencies: [wait] } = await register(owner, "release", marker);
    const checking = owner.checkLocalFiles();
    await owner.manage({ action: "cancel", backend: "codex", threadId: "release", dependencyId: wait!.id });
    result.resolve("result");
    await checking;
    expect(admit).not.toHaveBeenCalled();

    await register(owner, "release", marker);
    await owner.checkLocalFiles();
    const restarted = coordinator({ submit: admit });
    await restarted.reconcile();
    expect(admit).toHaveBeenCalledTimes(1);
    const [claim] = store.active();
    expect(claim).toMatchObject({ status: "dispatching", error: expect.stringContaining("review") });
    await restarted.manage({ action: "dismiss", backend: "codex", threadId: "release", dependencyId: claim!.id });
    await register(restarted, "release", marker);
    await restarted.checkLocalFiles();
    expect(admit).toHaveBeenCalledTimes(1);
    expect(store.active()).toHaveLength(0);
  });

  it.each(["exited", "unreadable"] as const)("keeps work blocked when the watcher is %s", async (outcome) => {
    const owner = coordinator({ readLocalFile: async () => {
      if (outcome === "unreadable") throw new Error("permission denied");
      return outcome;
    } });
    await register(owner, "release", "/release/terminal.marker");
    await owner.checkLocalFiles();
    const [wait] = store.list("codex", "release");
    expect(wait).toMatchObject({ status: "delivered", outcome: "failure", evidence: [{ state: "failed" }] });
    const card = buildDependencyTodo({ ...wait!, handoff: true });
    expect(card.action).toBeUndefined();
    expect(card.detail).toContain("Not started: Report the release result.");
    expect(card.title).toMatch(/^Local watcher failed/);
  });

  it("leaves a terminal wake ready until a thread owner can claim it", async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 6 }), async (deniedChecks) => {
      submit.mockClear();
      const consumer = crypto.randomUUID();
      const marker = `/release/${consumer}/terminal.marker`;
      terminal.add(marker);
      let hasLease = false;
      const owner = coordinator({
        canClaimLocalFileWake: () => hasLease,
      });
      await register(owner, consumer, marker);
      for (let i = 0; i < deniedChecks; i++) await owner.checkLocalFiles();
      expect(store.list("codex", consumer)[0]).toMatchObject({ status: "ready", outcome: "success" });
      expect(owner.hasPendingLocalFiles()).toBe(true);
      expect(submit).not.toHaveBeenCalled();
      hasLease = true;
      await owner.checkLocalFiles();
      await owner.checkLocalFiles();
      expect(submit).toHaveBeenCalledTimes(1);
    }), { numRuns: 12 });
  });

  it("budgets one watcher from registration through terminal delivery", async () => {
    const marker = "/release/watch-ci/terminal.marker";
    const owner = coordinator();
    const { writes } = await measureSqliteWrites(async () => {
      await register(owner, "release", marker);
      terminal.add(marker);
      await owner.checkLocalFiles();
    });
    expectSqliteWriteBudget({
      scenario: "thread-dependency-local-file-lifecycle",
      note: "One local file wait writes only on registration, terminal observation, claim, and delivery.",
      writes,
    });
  });

  it("ignores stale or nonregular files and prefers a fresh result over an exit marker", async () => {
    const workspace = path.join(tempDir, "work");
    await mkdir(workspace);
    const marker = path.join(workspace, "terminal.marker");
    const exit = path.join(workspace, "exit");
    const since = 60_000;
    const file = await authorizeLocalFile(workspace, { path: marker, since, exitPath: exit });
    expect(await readLocalFile(file)).toBeUndefined();
    await writeFile(marker, "");
    await utimes(marker, new Date(0), new Date(0));
    expect(await readLocalFile(file)).toBeUndefined();
    await writeFile(exit, "");
    expect(await readLocalFile(file)).toBe("exited");
    await utimes(marker, new Date(since), new Date(since));
    expect(await readLocalFile(file)).toBe("result");
    const directory = path.join(workspace, "directory");
    await mkdir(directory);
    expect(await readLocalFile(await authorizeLocalFile(workspace, { path: directory, since }))).toBeUndefined();
    await expect(authorizeLocalFile(workspace, { path: path.join(tempDir, "outside"), since })).rejects.toThrow("inside");
  });

  it.skipIf(process.platform === "win32")("rejects a marker directory symlink outside the workspace", async () => {
    const workspace = path.join(tempDir, "work");
    await mkdir(workspace);
    const link = path.join(workspace, "link");
    await symlink(tempDir, link);
    await expect(authorizeLocalFile(workspace, { path: path.join(link, "terminal.marker"), since: 1 })).rejects.toThrow("inside");
  });

  it("matches a one-shot oracle across re-registration, independent consumers, and restart", async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.record({
      action: fc.constantFrom("register", "poll", "finish", "restart"),
      target: fc.constantFrom("a", "b", "c"),
    }), { maxLength: 32 }), async (steps) => {
      const identities = new Map<string, string>();
      const delivered = new Set<string>();
      let owner = coordinator();
      terminal.clear();
      submit.mockClear();
      const run = crypto.randomUUID();
      for (const { action, target } of steps) {
        const thread = `${run}-${target}`;
        const path = target === "c" ? "/other/terminal.marker" : "/release/terminal.marker";
        if (action === "register") {
          await register(owner, thread, path);
          identities.set(thread, path);
        } else if (action === "restart") {
          owner = coordinator();
        } else if (action === "finish") {
          terminal.add(path);
        } else {
          for (const [id, file] of identities) if (terminal.has(file)) delivered.add(id);
          const before = probe.mock.calls.length;
          const wanted = new Set(store.active().map((item) => item.conditions[0]!.localFile!.path));
          await owner.checkLocalFiles();
          expect(probe.mock.calls.length - before).toBe(wanted.size);
        }
        expect(submit.mock.calls.map(([req]) => req.threadId).sort()).toEqual([...delivered].sort());
      }
      for (const item of store.active()) store.cancel(item.backend, item.threadId, item.id, Date.now());
    }), { numRuns: 75 });
  });
});
