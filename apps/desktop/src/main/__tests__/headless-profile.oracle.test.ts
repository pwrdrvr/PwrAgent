import { fork } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import fc from "fast-check";
import { buildThreadIdentityKey } from "@pwragent/shared";
import { expect, it } from "vitest";
import { StateDb } from "../state/state-db";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { AcpSessionStore } from "../storage/acp-session-store";
import { ProviderThreadSnapshotStore } from "../storage/provider-thread-snapshot-store";
import { ClaudeSessionStore } from "../claude/claude-session-store";
import { observeStorageArchive } from "../state/storage-maintenance";
import { buildOwnerFixture } from "./helpers/built-owner-fixture";

async function openOwner(root: string, kind: "desktop" | "headless", command = process.execPath, home?: string) {
  const directory = path.join(root, `bundle-${kind}`);
  const guard = await buildOwnerFixture(directory, kind);
  const driver = path.join(directory, "driver.cjs");
  fs.writeFileSync(driver, `const app = require("./dist/index.js");
    (async () => {
      await app.prepareOutpostProfile("t");
      const services = await app.startHeadlessHost(undefined, { manageSignals: false });
      process.on("message", async request => {
        if (request.method === "stop") { await app.shutdownHeadlessHost("profile-oracle"); process.disconnect(); return; }
        try { const target = request.method === "resolveCodexSpawnEnvAsync" ? services.settings : typeof services.registry[request.method] === "function" ? services.registry : services.service; process.send({ id: request.id, result: await target[request.method](request.params) }); }
        catch(error) { process.send({ id: request.id, error: error.message }); }
      });
      process.send({ ready: true });
    })().catch(error => { process.send({ startupError: error.message }); process.exitCode = 1; process.disconnect(); });`);
  const child = fork(driver, [], { cwd: path.join(root, "workspace"),
    env: { ...process.env, PWRAGENT_HOME: root, PWRAGENT_PROFILE: "t", PWRAGENT_CODEX_COMMAND: command,
      ...(home ? { PWRAGENT_CODEX_HOME: home, CODEX_HOME: home } : {}),
      PWRAGENT_TEST_DATA: path.join(root, "fixture"), CLAUDE_CONFIG_DIR: path.join(root, "claude") },
    execArgv: ["--require", guard], stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let output = "";
  child.stdout?.on("data", chunk => { output += String(chunk); });
  child.stderr?.on("data", chunk => { output += String(chunk); });
  const exited = once(child, "exit");
  const [ready] = await Promise.race([once(child, "message"), exited.then(([code]) => { throw new Error(`Owner exited ${code}: ${output.slice(-3000)}`); })]);
  if (ready.startupError) { await exited; throw new Error(ready.startupError); }
  let sequence = 0;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  child.on("message", raw => {
    const message = raw as { id: number; result?: unknown; error?: string };
    const request = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) request?.reject(new Error(message.error)); else request?.resolve(message.result);
  });
  return {
    call: <T>(method: string, params: unknown): Promise<T> => new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve: value => resolve(value as T), reject });
      child.send({ id, method, params });
    }),
    close: async () => { child.send({ method: "stop" }); const [code] = await exited; expect(code, output.slice(-3000)).toBe(0); },
  };
}

it("fresh desktop and Node roots preserve one profile's native identities, titles and canonical metadata", async () => {
  await fc.assert(fc.asyncProperty(fc.stringMatching(/^[A-Z][a-z]{0,8}$/), async suffix => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "pa-profile-oracle-")));
    for (const name of ["workspace", "fixture"]) fs.mkdirSync(path.join(root, name));
    let host: Awaited<ReturnType<typeof openOwner>> | undefined;
    type Ref = { backend: "codex"; threadId: string };
    try {
      host = await openOwner(root, "desktop");
      const parent = await host.call<Ref>("startThread", { backend: "codex", cwd: path.join(root, "workspace") });
      const child = await host.call<Ref>("startThread", { backend: "codex", cwd: path.join(root, "workspace") });
      await host.call("renameThread", { ...parent, name: `Parent ${suffix}` });
      await host.call("renameThread", { ...child, name: `Desktop ${suffix}` });
      await host.call("setThreadPin", { ...parent, pinnedRank: "8192" });
      await host.call("setThreadParent", { ...child, parentThreadId: parent.threadId, parentThreadBackend: "codex" });
      await host.close(); host = undefined;
      for (const [kind, title] of [["headless", `Desktop ${suffix}`], ["desktop", `Outpost ${suffix}`], ["headless", `Desktop again ${suffix}`]] as const) {
        host = await openOwner(root, kind);
        await host.call("readThread", child);
        // The provider's completed inventory walk is the ownership boundary;
        // startup's retained snapshot can precede a native observation.
        await host.call("listThreads", { backend: "codex", forceRefresh: true, enrichDirectories: false });
        const read = await host.call<{ thread: { title: string; titleSource: string; parentThreadId?: string } }>("getNavigationSelectedDetail", { protocol: 2, ref: child });
        expect(read.thread).toMatchObject({ title, titleSource: "explicit", parentThreadId: parent.threadId });
        expect((await host.call<{ thread: unknown }>("getNavigationSelectedDetail", { protocol: 2, ref: parent })).thread).toMatchObject({ title: `Parent ${suffix}`, pinnedRank: "8192" });
        const next = kind === "headless" ? `Outpost ${suffix}` : `Desktop again ${suffix}`;
        await host.call("renameThread", { ...child, name: next, expectedName: title });
        const provider = JSON.parse(fs.readFileSync(path.join(root, "fixture/fixture-threads.json"), "utf8"));
        expect(provider[child.threadId].name).toBe(next);
        const after = await host.call<{ thread: unknown }>("getNavigationSelectedDetail", { protocol: 2, ref: child });
        expect(after.thread, JSON.stringify({ info: await host.call("getThreadInfo", child), cached: await host.call("getCachedThreadSummary", child) })).toMatchObject({ title: next });
        await host.close(); host = undefined;
      }
    } finally { await host?.close(); fs.rmSync(root, { recursive: true, force: true }); }
  }), { numRuns: 3 });
}, 120_000);

it("a refused headless startup cannot rewrite a live owner's profile configuration", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "pa-profile-owner-")));
  for (const name of ["workspace", "fixture"]) fs.mkdirSync(path.join(root, name));
  let owner: Awaited<ReturnType<typeof openOwner>> | undefined;
  try {
    owner = await openOwner(root, "desktop");
    const file = path.join(root, "profiles/t/config.toml"), before = fs.readFileSync(file);
    await expect(openOwner(root, "headless", "/fixture/different-codex")).rejects.toThrow(/lease is held/);
    expect(fs.readFileSync(file)).toEqual(before);
  } finally { await owner?.close(); fs.rmSync(root, { recursive: true, force: true }); }
}, 120_000);

it("the Outpost spawn home stays equal to the explicit preflight home despite saved desktop mappings", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "pa-profile-home-")));
  for (const name of ["workspace", "fixture", "dedicated", "profiles/t"]) fs.mkdirSync(path.join(root, name), { recursive: true });
  fs.writeFileSync(path.join(root, "profiles/t/config.toml"), '[models.codex]\nprofile = "work"\n');
  let owner: Awaited<ReturnType<typeof openOwner>> | undefined;
  try {
    owner = await openOwner(root, "headless", process.execPath, path.join(root, "dedicated"));
    expect((await owner.call<NodeJS.ProcessEnv>("resolveCodexSpawnEnvAsync", undefined)).CODEX_HOME).toBe(path.join(root, "dedicated"));
    expect(fs.readFileSync(path.join(root, "profiles/t/config.toml"), "utf8")).toContain('profile = "work"');
  } finally { await owner?.close(); fs.rmSync(root, { recursive: true, force: true }); }
}, 120_000);

// The persisted owner is the oracle: reads by a host without these providers
// must leave every stored byte intact, including provenance and observation time.
it("desktop → Codex-only headless → desktop preserves unsupported providers byte-for-byte", async () => {
  await fc.assert(fc.asyncProperty(fc.uuid(), fc.stringMatching(/^[A-Z][a-z]{0,8}$/), async (threadId, suffix) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "pa-unsupported-")));
    for (const name of ["workspace", "fixture", "profiles/t/state/claude"]) fs.mkdirSync(path.join(root, name), { recursive: true });
    const database = path.join(root, "profiles/t/state/state.db");
    const claude = path.join(root, `profiles/t/state/claude/${threadId}.json`);
    const db = StateDb.open(database);
    try {
      const overlay = new SqliteOverlayStore(db);
      const threads = (["claude", "acp:gemini"] as const).map(source => ({ id: threadId, source,
        title: `${source} ${suffix}`, titleSource: "explicit" as const, createdAt: 1, updatedAt: 20,
        linkedDirectories: [{ id: "w", kind: "local" as const, path: path.join(root, "workspace"), label: "w" }], executionMode: "default" as const }));
      await new ClaudeSessionStore(path.dirname(claude)).save({ cwd: path.join(root, "workspace"), thread: threads[0]! });
      new AcpSessionStore(db).upsertSession({ backendId: "acp:gemini", sessionId: threadId, title: `acp:gemini ${suffix}`,
        titleSource: "explicit", cwd: path.join(root, "workspace"), createdAt: 1, updatedAt: 20, executionMode: "default", status: "idle" });
      for (const thread of threads) {
        new ProviderThreadSnapshotStore(db).replace({ backend: thread.source, observedAt: 21, threads: [thread] });
        await overlay.updateThreadMetadata({ backend: thread.source, threadId }, { title: { text: thread.title, source: "explicit" },
          pinnedRank: "4096", seenAt: 10, seenUpdatedAt: 9, archivedAt: 8, restoredAt: 11 });
        observeStorageArchive(db.raw, thread.source, threadId, true, Date.now());
      }
      overlay.initializeNavigationUnreadBaseline(threads.map(thread => ({ ...thread, inbox: { inInbox: true } })));
    } finally { db.close(); }
    const snapshot = () => {
      const db = StateDb.open(database);
      try {
        return JSON.stringify({ claude: fs.readFileSync(claude).toString("base64"),
          metadata: db.raw.prepare("SELECT * FROM threads WHERE thread_id IN (?, ?) ORDER BY thread_id").all(buildThreadIdentityKey("claude", threadId), buildThreadIdentityKey("acp:gemini", threadId)),
          acp: db.raw.prepare("SELECT * FROM acp_sessions ORDER BY backend_id, session_id").all(),
          inventory: db.raw.prepare("SELECT * FROM provider_thread_snapshots WHERE backend != 'codex' ORDER BY backend").all(),
          unread: db.raw.prepare("SELECT * FROM meta WHERE key = 'navigation-unread-baseline-v2'").all(),
          archive: db.raw.prepare("SELECT * FROM thread_storage_retention WHERE backend != 'codex' ORDER BY backend, thread_id").all(),
        });
      } finally { db.close(); }
    };
    let host: Awaited<ReturnType<typeof openOwner>> | undefined;
    try {
      const expected = snapshot();
      for (const kind of ["desktop", "headless", "desktop"] as const) {
        host = await openOwner(root, kind);
        await host.call("listThreads", { forceRefresh: true, enrichDirectories: false });
        for (const backend of ["claude", "acp:gemini"]) {
          await host.call("getNavigationSelectedDetail", { protocol: 2, ref: { backend, threadId } });
          await expect(host.call("startTurn", { backend, threadId, input: [{ type: "text", text: "Must refuse" }] })).rejects.toThrow(/disabled/);
        }
        expect(snapshot(), `${kind} changed unsupported provider state`).toBe(expected);
        await host.close(); host = undefined;
        expect(snapshot(), `${kind} shutdown changed unsupported provider state`).toBe(expected);
      }
    } finally { await host?.close(); fs.rmSync(root, { recursive: true, force: true }); }
  }), { numRuns: 3 });
}, 120_000);
