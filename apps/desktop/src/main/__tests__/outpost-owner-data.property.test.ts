import fc from "fast-check";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import fs from "node:fs";
import { vi } from "vitest";
import { StateDb } from "@pwragent/sqlite-storage/state-db";
import { SqliteOverlayStore } from "@pwragent/sqlite-storage/overlay-store-sqlite";
import { ProviderThreadSnapshotStore } from "@pwragent/sqlite-storage/provider-thread-snapshot-store";
import { openOutpostProfileRuntime } from "../../../../../packages/pwragent/src/federation-core";
import { adoptOutpostOwnerData } from "@pwragent/sqlite-storage/legacy-outpost-owner-data";
import { SqliteOwnerJobStore } from "@pwragent/sqlite-storage/owner-job-store";
import { measureSqliteWrites } from "@pwragent/sqlite-storage/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";

async function modules() {
  const load = (file: string) => import(/* @vite-ignore */ pathToFileURL(path.join(process.cwd(), "packages/pwragent/src", file)).href);
  const [{ JobStore }, { HeadlessBackend }] = await Promise.all([load("store.js"), load("federation-backend.js")]);
  return { JobStore, HeadlessBackend };
}

function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "outpost-owner-data-")));
  const directory = path.join(root, "headless");
  mkdirSync(directory, { mode: 0o700 });
  const identity = { version: 1 as const, workspace: path.join(root, "workspace"), codexHome: path.join(root, "codex") };
  const db = StateDb.open(path.join(root, "state.db"), { profileName: "fixture" });
  const desktop = new SqliteOverlayStore(db);
  return { root, directory, identity, db, desktop };
}

it("the real Outpost registry and desktop observe one canonical metadata model across alternating owners", async () => {
  const { JobStore, HeadlessBackend } = await modules();
  await fc.assert(fc.asyncProperty(fc.array(fc.record({
    id: fc.constantFrom("a", "b", "c"), title: fc.string({ maxLength: 40 }),
    rank: fc.string({ maxLength: 8 }), seen: fc.nat(10000), desktop: fc.boolean(),
  }), { minLength: 1, maxLength: 15 }), async commands => {
    const f = fixture();
    const profile = openOutpostProfileRuntime({ stateDirectory: f.root, profileName: "fixture", cwd: f.identity.workspace });
    try {
      const store = new JobStore(f.directory, f.identity, profile);
      const runtime = { workspace: f.identity.workspace, store, onFailure(error: unknown) { throw error; } };
      const backend = new HeadlessBackend(runtime, () => {});
      for (const command of commands) {
        const identity = { backend: "codex" as const, threadId: command.id };
        const patch = { title: { text: command.title, source: "explicit" as const }, pinnedRank: command.rank,
          seenAt: command.seen + 1, seenUpdatedAt: command.seen,
          parent: { backend: "codex" as const, threadId: "parent", instanceId: "owner" } };
        const writer = command.desktop ? f.desktop : backend.threadRegistry;
        await writer.updateThreadMetadata(identity, patch);
        expect(await backend.threadRegistry.getThreadMetadata(identity)).toEqual(await f.desktop.getThreadMetadata(identity));
        expect(await f.desktop.getThreadMetadata(identity)).toMatchObject(patch);
      }
      expect(existsSync(path.join(f.directory, "threads.json"))).toBe(false);
    } finally { profile.close(); f.db.close(); rmSync(f.root, { recursive: true, force: true }); }
  }), { numRuns: 20 });
});

it("rolls threads, jobs and the completion marker back together on every generated statement refusal", async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom("threads", "owner_jobs", "meta"), fc.string({ maxLength: 30 }), async (table, title) => {
    const f = fixture();
    const source = JSON.stringify({ version: 1, threads: [{ id: "legacy", title, titleSource: "explicit", sandbox: "read-only" }] });
    const job = JSON.stringify({ version: 1, id: "legacy-job", threadId: "legacy", status: "running", fingerprint: "unchanged" });
    mkdirSync(path.join(f.directory, "jobs"), { mode: 0o700 });
    writeFileSync(path.join(f.directory, "identity.json"), JSON.stringify(f.identity));
    writeFileSync(path.join(f.directory, "threads.json"), source);
    writeFileSync(path.join(f.directory, "jobs/legacy-job.json"), job);
    const refusal = {
      threads: "CREATE TRIGGER refuse_import BEFORE INSERT ON threads BEGIN SELECT RAISE(ABORT, 'import refused'); END",
      owner_jobs: "CREATE TRIGGER refuse_import BEFORE INSERT ON owner_jobs BEGIN SELECT RAISE(ABORT, 'import refused'); END",
      meta: "CREATE TRIGGER refuse_import BEFORE INSERT ON meta WHEN NEW.key = 'outpost_owner_json_import_v1' BEGIN SELECT RAISE(ABORT, 'import refused'); END",
    };
    try {
      f.db.raw.exec(refusal[table]);
      expect(() => adoptOutpostOwnerData(f.db, f.directory, f.identity)).toThrow("import refused");
      expect(await f.desktop.listThreadMetadata()).toEqual([]);
      expect(new SqliteOwnerJobStore(f.db).list()).toEqual([]);
      expect(f.db.getMeta("outpost_owner_json_import_v1")).toBeUndefined();
      expect(readFileSync(path.join(f.directory, "threads.json"), "utf8")).toBe(source);
      expect(readFileSync(path.join(f.directory, "jobs/legacy-job.json"), "utf8")).toBe(job);
      expect(readFileSync(path.join(f.directory, "legacy-owner-backup-v1/threads.json"), "utf8")).toBe(source);
      f.db.raw.exec("DROP TRIGGER refuse_import");
      adoptOutpostOwnerData(f.db, f.directory, f.identity);
      expect((await f.desktop.getThreadMetadata({ backend: "codex", threadId: "legacy" }))?.title?.text).toBe(title);
      expect(new SqliteOwnerJobStore(f.db).get("legacy-job")?.status).toBe("unknown");
    } finally { f.db.close(); rmSync(f.root, { recursive: true, force: true }); }
  }), { numRuns: 15 });
});

it("resumes partial JSON retirement from the committed marker without replaying old metadata", async () => {
  const f = fixture();
  mkdirSync(path.join(f.directory, "jobs"), { mode: 0o700 });
  writeFileSync(path.join(f.directory, "identity.json"), JSON.stringify(f.identity));
  writeFileSync(path.join(f.directory, "threads.json"), JSON.stringify({ version: 1, threads: [{ id: "legacy", title: "Old" }] }));
  writeFileSync(path.join(f.directory, "jobs/legacy.json"), JSON.stringify({ version: 1, id: "legacy", status: "completed" }));
  const original = fs.unlinkSync;
  const unlink = vi.spyOn(fs, "unlinkSync").mockImplementation(file => {
    if (String(file) === path.join(f.directory, "threads.json")) throw new Error("retirement refused");
    original(file);
  });
  try {
    expect(() => adoptOutpostOwnerData(f.db, f.directory, f.identity)).toThrow("retirement refused");
    expect(existsSync(path.join(f.directory, "jobs/legacy.json"))).toBe(false);
    expect(f.db.getMeta("outpost_owner_json_import_v1")).toBeTruthy();
    await f.desktop.updateThreadMetadata({ backend: "codex", threadId: "legacy" }, { title: { text: "New canonical title", source: "explicit" } });
    unlink.mockRestore();
    adoptOutpostOwnerData(f.db, f.directory, f.identity);
    expect((await f.desktop.getThreadMetadata({ backend: "codex", threadId: "legacy" }))?.title?.text).toBe("New canonical title");
    expect(existsSync(path.join(f.directory, "threads.json"))).toBe(false);
  } finally { unlink.mockRestore(); f.db.close(); rmSync(f.root, { recursive: true, force: true }); }
});

it("budgets a job lifecycle, atomic import and unchanged reads separately from inherited defaults", async () => {
  const previous = process.env.PWRAGENT_DEV_SQLITE_WRITE_METRICS;
  process.env.PWRAGENT_DEV_SQLITE_WRITE_METRICS = "1";
  const f = fixture();
  const budgetFile = "outpost-owner-data-write-budgets.json";
  try {
    const imported = await measureSqliteWrites(() => adoptOutpostOwnerData(f.db, f.directory, f.identity));
    expectSqliteWriteBudget({ budgetFile, scenario: "outpost-empty-adoption", note: "One first-adoption marker; schema and identity file excluded from SQLite accounting", writes: imported.writes });
    const jobs = new SqliteOwnerJobStore(f.db);
    const lifecycle = await measureSqliteWrites(() => {
      let job = jobs.save({ version: 1, id: "job", status: "starting", fingerprint: "input-identity", createdAt: "2026-01-01T00:00:00Z" });
      job = jobs.save({ ...job, threadId: "thread" });
      job = jobs.save({ ...job, status: "running", turnId: "turn" });
      jobs.save({ ...job, status: "completed", finishedAt: "2026-01-01T00:00:01Z" });
    });
    expectSqliteWriteBudget({ budgetFile, scenario: "outpost-job-lifecycle", note: "Durable acceptance, thread identity, turn identity and terminal outcome; one FULL commit per boundary", writes: lifecycle.writes });
    const unchanged = await measureSqliteWrites(() => {
      for (let i = 0; i < 1000; i++) { jobs.get("job"); jobs.list(); jobs.count(); }
      adoptOutpostOwnerData(f.db, f.directory, f.identity);
    });
    expectSqliteWriteBudget({ budgetFile, scenario: "outpost-job-read-reopen", note: "1000 reads and adoption reopen/recovery; no replay or idle writes", writes: unchanged.writes });
  } finally {
    f.db.close(); rmSync(f.root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.PWRAGENT_DEV_SQLITE_WRITE_METRICS;
    else process.env.PWRAGENT_DEV_SQLITE_WRITE_METRICS = previous;
  }
});

it.skipIf(process.platform === "win32")("budgets the actual runtime turn, owner commands and streamed events through the production storage ports", async () => {
  const { JobStore, HeadlessBackend } = await modules();
  const { Runtime } = await import(/* @vite-ignore */ pathToFileURL(path.join(process.cwd(), "packages/pwragent/src/runtime.js")).href);
  const previous = process.env.PWRAGENT_DEV_SQLITE_WRITE_METRICS;
  process.env.PWRAGENT_DEV_SQLITE_WRITE_METRICS = "1";
  const f = fixture();
  mkdirSync(f.identity.workspace);
  mkdirSync(f.identity.codexHome);
  const profile = openOutpostProfileRuntime({ stateDirectory: f.root, profileName: "fixture", cwd: f.identity.workspace });
  const budgetFile = "outpost-owner-data-write-budgets.json";
  try {
    const store = new JobStore(f.directory, f.identity, profile);
    const runtime = new Runtime({ store, workspace: f.identity.workspace, home: f.identity.codexHome, command: "/fixture/codex",
      onFailure(error: unknown) { throw error; } });
    runtime.codex = { startThread: async () => ({ threadId: "thread" }), startTurn: async () => ({ turnId: "turn" }),
      renameThread: async ({ threadId }: { threadId: string }) => ({ threadId }) };
    const backend = new HeadlessBackend(runtime, () => {});
    runtime.onEvent = (message: unknown) => backend.event(message);
    const turn = await measureSqliteWrites(async () => {
      runtime.submit({ id: "job", prompt: "Check the fixture" });
      await runtime.work;
      runtime.notification({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn", status: "completed" } } });
    });
    expect(store.get("job").status).toBe("completed");
    expectSqliteWriteBudget({ budgetFile, scenario: "outpost-runtime-new-thread-turn", note: "Actual submit/start/completion: four job boundaries, canonical thread discovery and first-prompt title; schema/profile setup excluded", writes: turn.writes });
    for (const [method, params] of [
      ["renameThread", { title: "Operator name" }], ["markThreadSeen", { seenAt: 100, seenUpdatedAt: 90 }],
      ["setThreadModelSettings", { model: "fixture-model", reasoningEffort: "high" }], ["setThreadExecutionMode", { executionMode: "auto" }],
    ] as const) {
      const command = await measureSqliteWrites(() => backend.handle(method, { threadId: "thread", ...params }));
      expectSqliteWriteBudget({ budgetFile, scenario: `outpost-owner-${method}`, note: "One actual owner command merges its changed facts in the canonical overlay transaction", writes: command.writes });
    }
    const streamed = await measureSqliteWrites(() => {
      for (let i = 0; i < 1000; i++) {
        const notification = { method: "item/agentMessage/delta", params: { threadId: "thread", itemId: "item", delta: "invented transient text" } };
        runtime.notification(notification); backend.event(notification);
      }
    });
    expectSqliteWriteBudget({ budgetFile, scenario: "outpost-streamed-events", note: "1000 actual runtime/backend streamed notifications persist no text and make zero commits", writes: streamed.writes });
  } finally {
    profile.close(); f.db.close(); rmSync(f.root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.PWRAGENT_DEV_SQLITE_WRITE_METRICS;
    else process.env.PWRAGENT_DEV_SQLITE_WRITE_METRICS = previous;
  }
});

it("imports legacy threads and jobs together, backs up bytes, retires JSON and preserves no-replay job identity", async () => {
  const { JobStore, HeadlessBackend } = await modules();
  await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom("starting", "running", "completed", "failed", "unknown"), {
    minLength: 1, maxLength: 8,
  }), async statuses => {
    const f = fixture();
    const threads = statuses.map((_, i) => ({ id: `thread-${i}`, title: `Title ${i}`, titleSource: "explicit",
      createdAt: i, sandbox: "read-only", pinnedRank: `a${i}`, seenAt: i + 2, seenUpdatedAt: i,
      parentThreadId: "parent", messagingFileTools: true }));
    const jobs = statuses.map((status, i) => ({ version: 1, id: `job-${i}`, threadId: `thread-${i}`, status,
      fingerprint: `fingerprint-${i}`, createdAt: new Date(i).toISOString(), updatedAt: new Date(i).toISOString(), sandbox: "read-only" }));
    const bytes = JSON.stringify({ version: 1, threads });
    writeFileSync(path.join(f.directory, "identity.json"), JSON.stringify(f.identity));
    writeFileSync(path.join(f.directory, "threads.json"), bytes);
    mkdirSync(path.join(f.directory, "jobs"), { mode: 0o700 });
    for (const job of jobs) writeFileSync(path.join(f.directory, "jobs", `${job.id}.json`), JSON.stringify(job));
    let profile = openOutpostProfileRuntime({ stateDirectory: f.root, profileName: "fixture", cwd: f.identity.workspace });
    try {
      const store = new JobStore(f.directory, f.identity, profile);
      const backend = new HeadlessBackend({ workspace: f.identity.workspace, store, onFailure(error: unknown) { throw error; } }, () => {});
      expect((await f.desktop.listThreadMetadata()).length).toBe(threads.length);
      for (const [i, job] of jobs.entries()) {
        expect(store.get(job.id)).toMatchObject({ id: job.id, fingerprint: job.fingerprint,
          status: ["starting", "running"].includes(job.status) ? "unknown" : job.status });
        expect(await backend.threadRegistry.getThreadMetadata({ backend: "codex", threadId: job.threadId })).toMatchObject({ pinnedRank: `a${i}`, seenUpdatedAt: i });
        expect(existsSync(path.join(f.directory, "jobs", `${job.id}.json`))).toBe(false);
      }
      expect(readFileSync(path.join(f.directory, "legacy-owner-backup-v1", "threads.json"), "utf8")).toBe(bytes);
      expect(existsSync(path.join(f.directory, "threads.json"))).toBe(false);
      const beforeClose = [...store.jobs.values()];
      profile.close();
      profile = openOutpostProfileRuntime({ stateDirectory: f.root, profileName: "fixture", cwd: f.identity.workspace });
      const reopened = new JobStore(f.directory, f.identity, profile);
      expect([...reopened.jobs.values()]).toEqual(beforeClose);
    } finally { profile.close(); f.db.close(); rmSync(f.root, { recursive: true, force: true }); }
  }), { numRuns: 12 });
});

it("commits a multi-record legacy import once while preserving existing canonical facts", async () => {
  const previous = process.env.PWRAGENT_DEV_SQLITE_WRITE_METRICS;
  process.env.PWRAGENT_DEV_SQLITE_WRITE_METRICS = "1";
  const f = fixture();
  try {
    await f.desktop.updateThreadMetadata({ backend: "codex", threadId: "existing" }, { title: { text: "Canonical", source: "explicit" }, pinnedRank: "current" });
    mkdirSync(path.join(f.directory, "jobs"), { mode: 0o700 });
    writeFileSync(path.join(f.directory, "identity.json"), JSON.stringify(f.identity));
    writeFileSync(path.join(f.directory, "threads.json"), JSON.stringify({ version: 1, threads: [
      { id: "existing", title: "Legacy", pinnedRank: "old", seenAt: 20 }, { id: "new", title: "Imported", sandbox: "read-only" },
    ] }));
    for (const [id, status] of [["active", "running"], ["terminal", "completed"]]) writeFileSync(path.join(f.directory, "jobs", `${id}.json`), JSON.stringify({ version: 1, id, status, threadId: "new" }));
    const imported = await measureSqliteWrites(() => adoptOutpostOwnerData(f.db, f.directory, f.identity));
    expect(imported.writes.commits).toBe(1);
    expectSqliteWriteBudget({ budgetFile: "outpost-owner-data-write-budgets.json", scenario: "outpost-legacy-threads-jobs-import",
      note: "Two threads, two jobs, active-job recovery and the retirement marker share one FULL-durability transaction; backups and schema excluded", writes: imported.writes });
    expect(await f.desktop.getThreadMetadata({ backend: "codex", threadId: "existing" })).toMatchObject({ title: { text: "Canonical", source: "explicit" }, pinnedRank: "current", seenAt: 20 });
    expect(imported.result.jobs.get("active")?.status).toBe("unknown");
  } finally {
    f.db.close(); rmSync(f.root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.PWRAGENT_DEV_SQLITE_WRITE_METRICS;
    else process.env.PWRAGENT_DEV_SQLITE_WRITE_METRICS = previous;
  }
});

it("rejects a corrupted job key without rewriting or aliasing its accepted identity", () => {
  fc.assert(fc.property(fc.string({ maxLength: 30 }), text => {
    const f = fixture();
    try {
      const jobs = new SqliteOwnerJobStore(f.db);
      const bytes = JSON.stringify({ version: 1, id: "different", status: "completed", fingerprint: text });
      f.db.raw.prepare("INSERT INTO owner_jobs(job_id, payload) VALUES (?, ?)").run("accepted", bytes);
      expect(() => jobs.get("accepted")).toThrow("Invalid headless job record identity");
      expect(() => jobs.list()).toThrow("Invalid headless job record identity");
      expect(f.db.raw.prepare("SELECT payload FROM owner_jobs WHERE job_id = ?").pluck().get("accepted")).toBe(bytes);
    } finally { f.db.close(); rmSync(f.root, { recursive: true, force: true }); }
  }), { numRuns: 15 });
});

it("honors provider archive state and the latest canonical archive/restore boundary without resurrecting ownership", async () => {
  const { JobStore, HeadlessBackend } = await modules();
  await fc.assert(fc.asyncProperty(fc.boolean(), fc.array(fc.constantFrom("archive", "restore"), { minLength: 1, maxLength: 12 }), async (initialArchived, commands) => {
    const f = fixture();
    new ProviderThreadSnapshotStore(f.db).replace({ backend: "codex", observedAt: 1, threads: [{
      id: "thread", source: "codex", title: "Provider title", titleSource: "explicit", linkedDirectories: [], createdAt: 1,
      ...(initialArchived ? { archivedAt: 1 } : {}),
    }] });
    const profile = openOutpostProfileRuntime({ stateDirectory: f.root, profileName: "fixture", cwd: f.identity.workspace });
    try {
      const store = new JobStore(f.directory, f.identity, profile);
      const backend = new HeadlessBackend({ workspace: f.identity.workspace, store, onFailure(error: unknown) { throw error; } }, () => {});
      let archived = initialArchived;
      const check = () => {
        if (archived) expect(() => backend.owned("thread")).toThrow("Thread is not owned");
        else expect(backend.owned("thread").title).toBe("Provider title");
        expect(backend.runtime.listOwnedThreads().some((thread: { id: string }) => thread.id === "thread")).toBe(!archived);
      };
      check();
      for (const [index, command] of commands.entries()) {
        await f.desktop.updateThreadMetadata({ backend: "codex", threadId: "thread" }, command === "archive"
          ? { archivedAt: index + 2 } : { restoredAt: index + 2 });
        archived = command === "archive";
        check();
      }
    } finally { profile.close(); f.db.close(); rmSync(f.root, { recursive: true, force: true }); }
  }), { numRuns: 20 });
});
