import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import fc from "fast-check";
import { buildThreadIdentityKey } from "@pwragent/shared/contracts/navigation";
import { expect, it } from "vitest";
import { StateDb } from "../state/state-db";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { AcpSessionStore } from "../storage/acp-session-store";
import { ProviderThreadSnapshotStore } from "../storage/provider-thread-snapshot-store";
import { ClaudeSessionStore } from "../claude/claude-session-store";
import { resolveMainLogFileNameForProfile } from "../log";
import { observeStorageArchive } from "../state/storage-maintenance";
import { buildOwnerFixture } from "./helpers/built-owner-fixture";

type TraceOwnerPhase = (phase: string) => void;

async function openOwner(root: string, kind: "desktop" | "headless", {
  command = process.execPath, home, trace,
}: { command?: string; home?: string; trace?: TraceOwnerPhase } = {}) {
  const directory = path.join(root, `bundle-${kind}`);
  trace?.("build:start");
  const guard = await buildOwnerFixture(directory, kind);
  trace?.("build:done");
  const driver = path.join(directory, "driver.cjs");
  fs.writeFileSync(driver, `const mark = ${trace ? 'phase => process.stderr.write("profile-oracle: " + Math.round(process.uptime() * 1000) + "ms " + phase + "\\n")' : "undefined"};
    mark?.("load:start");
    const app = require("./dist/index.js");
    mark?.("load:done");
    (async () => {
      mark?.("prepare-profile:start");
      await app.prepareOutpostProfile("t");
      mark?.("prepare-profile:done");
      mark?.("start-host:start");
      const services = await app.startHeadlessHost(undefined, { manageSignals: false });
      mark?.("start-host:done");
      process.on("message", async request => {
        if (request.method === "stop") {
          mark?.("shutdown:start");
          await app.shutdownHeadlessHost("profile-oracle");
          mark?.("shutdown:done resources=" + process.getActiveResourcesInfo().join(","));
          process.disconnect();
          return;
        }
        mark?.("request:" + request.id + ":" + request.method + ":start");
        try {
          const target = request.method === "resolveCodexSpawnEnvAsync" ? services.settings : typeof services.registry[request.method] === "function" ? services.registry : services.service;
          const result = await target[request.method](request.params);
          mark?.("request:" + request.id + ":done");
          process.send({ id: request.id, result });
        } catch(error) {
          mark?.("request:" + request.id + ":rejected");
          process.send({ id: request.id, error: error.message });
        }
      });
      mark?.("ready:send");
      process.send({ ready: true });
    })().catch(error => { process.send({ startupError: error.message }); process.exitCode = 1; process.disconnect(); });`);
  trace?.("fork:start");
  const child = fork(driver, [], { cwd: path.join(root, "workspace"),
    env: { ...process.env, PWRAGENT_HOME: root, PWRAGENT_PROFILE: "t", PWRAGENT_CODEX_COMMAND: command,
      ...(home ? { PWRAGENT_CODEX_HOME: home, CODEX_HOME: home } : {}),
      PWRAGENT_TEST_DATA: path.join(root, "fixture"), CLAUDE_CONFIG_DIR: path.join(root, "claude") },
    execArgv: ["--require", guard], stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  return await connectOwnerDriver(child, trace);
}

async function connectOwnerDriver(child: ChildProcess, trace?: TraceOwnerPhase) {
  let output = "";
  let disconnectReason: string | undefined;
  let sequence = 0;
  let closing: Promise<void> | undefined;
  const pending = new Map<number, { method: string; resolve(value: unknown): void; reject(error: Error): void }>();
  const rejectCall = (id: number, reason: string) => {
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);
    request.reject(new Error(`Owner request ${request.method} (${id}) failed: ${reason}`));
  };
  const failConnection = (reason: string) => {
    disconnectReason ??= reason;
    for (const id of pending.keys()) rejectCall(id, reason);
  };
  const collectOutput = (chunk: string | Buffer) => { output = (output + String(chunk)).slice(-3000); };
  child.stdout?.on("data", collectOutput);
  child.stderr?.on("data", collectOutput);
  if (trace) {
    let line = "";
    child.stderr?.setEncoding("utf8").on("data", (text: string) => {
      const lines = (line + text).split("\n");
      line = lines.pop()?.slice(-3000) ?? "";
      for (const entry of lines) {
        if (entry.startsWith("profile-oracle: ")) trace(`child ${entry.slice("profile-oracle: ".length)}`);
      }
    });
    child.once("spawn", () => trace(`fork:spawn pid=${child.pid}`));
    child.once("close", (code, signal) => {
      trace(`stdio:close code=${code} signal=${signal}`);
      if (code !== 0 && output) trace(`failed-owner-output: ${output}`);
    });
  }
  child.once("disconnect", () => {
    trace?.("ipc:disconnect");
    failConnection("IPC disconnected");
  });
  const exited = new Promise<string | undefined>((resolve, reject) => {
    child.on("error", error => {
      trace?.(`process:error ${error.message}`);
      failConnection(error.message);
      // A spawn error can be terminal without an exit event. Once spawned,
      // keep waiting for this exact child even if its IPC channel fails.
      if (child.pid === undefined) reject(error);
    });
    child.once("exit", (code, signal) => {
      trace?.(`exit code=${code} signal=${signal}`);
      const outcome = signal ? `signal ${signal}` : `code ${code}`;
      failConnection(`owner exited with ${outcome}`);
      resolve(code === 0 ? undefined : outcome);
    });
  });
  const firstMessage = new Promise<{ startupError?: string }>(resolve => child.once("message", resolve));
  const ready = await Promise.race([firstMessage, exited.then(outcome => {
    throw new Error(`Owner exited before readiness (${outcome ?? "code 0"}): ${output}`);
  })]);
  if (ready.startupError) { await exited; throw new Error(ready.startupError); }
  trace?.("ready:received");
  child.on("message", raw => {
    const message = raw as { id: number; result?: unknown; error?: string };
    trace?.(`response:${message.id}:${message.error ? "rejected" : "received"}`);
    const request = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) request?.reject(new Error(message.error)); else request?.resolve(message.result);
  });
  return {
    call: <T>(method: string, params: unknown): Promise<T> => new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { method, resolve: value => resolve(value as T), reject });
      if (!child.connected || disconnectReason) {
        rejectCall(id, disconnectReason ?? "IPC disconnected");
        return;
      }
      trace?.(`request:${id}:${method}:send`);
      try {
        child.send({ id, method, params }, error => {
          if (error) rejectCall(id, error.message);
        });
      } catch (error) {
        rejectCall(id, String(error));
      }
    }),
    close: () => {
      closing ??= (async () => {
        const stop = child.connected ? new Promise<Error | null>(resolve => {
          trace?.("shutdown:send");
          child.send({ method: "stop" }, resolve);
        }).catch((error: Error) => error) : undefined;
        const failure = await exited;
        trace?.("shutdown:joined");
        const sendError = await stop;
        if (failure || sendError) {
          throw new Error(`Owner shutdown failed: ${failure ?? sendError?.message}\n${output}`);
        }
      })();
      return closing;
    },
  };
}

async function removeOwnerFixture(root: string, owner?: Awaited<ReturnType<typeof connectOwnerDriver>>) {
  try { await owner?.close(); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

async function expectLostOwnerRepliesToReject(requestCount: number, exitCode: number) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pa-owner-ipc-"));
  const driver = path.join(root, "driver.cjs");
  fs.writeFileSync(driver, `
    let remaining = Number(process.argv[2]);
    process.stdin.resume();
    process.on("message", request => {
      if (request.method === "echo") {
        process.send({ id: request.id, result: request.params });
      } else if (--remaining === 0) {
        process.exitCode = Number(process.argv[3]);
        process.disconnect();
      }
    });
    process.send({ ready: true });
  `);
  const child = fork(driver, [String(requestCount), String(exitCode)], { execArgv: [], stdio: ["pipe", "pipe", "pipe", "ipc"] });
  const disconnected = once(child, "disconnect");
  const exited = once(child, "exit");
  const nextTurn = () => new Promise<string>(resolve => setImmediate(() => resolve("pending")));
  try {
    const owner = await connectOwnerDriver(child);
    expect(await owner.call("echo", "ready")).toBe("ready");
    const replies = Array.from({ length: requestCount }, () => owner.call("listThreads", {}).then(
      () => "resolved",
      (error: Error) => error.message,
    ));
    // The child disconnects only after receiving all the requests. Its stdin
    // remains open so IPC loss and process exit are separate observations.
    await disconnected;
    expect(await Promise.race([Promise.all(replies), nextTurn()])).toEqual(
      Array.from({ length: requestCount }, () => expect.stringMatching(/listThreads.*IPC disconnected/)),
    );
    const cleanup = removeOwnerFixture(root, owner).then(
      () => "cleaned up",
      (error: Error) => error.message,
    );
    expect(await Promise.race([cleanup, nextTurn()])).toBe("pending");
    expect(fs.existsSync(root)).toBe(true);
    child.stdin?.end();
    expect(await cleanup).toEqual(exitCode ? expect.stringContaining(`code ${exitCode}`) : "cleaned up");
    expect(fs.existsSync(root)).toBe(false);
  } finally {
    child.stdin?.end();
    await exited;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

it("rejects a lost owner reply after IPC disconnect and joins the child before cleanup", async () => {
  await expectLostOwnerRepliesToReject(1, 23);
});

it("settles every outstanding owner request when the IPC connection is lost", async () => {
  await fc.assert(fc.asyncProperty(
    fc.integer({ min: 2, max: 5 }),
    fc.constantFrom(0, 23),
    expectLostOwnerRepliesToReject,
  ), { numRuns: 4 });
});

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
    } finally { await removeOwnerFixture(root, host); }
  }), { numRuns: 3 });
}, 120_000);

it("a refused headless startup cannot rewrite a live owner's profile configuration", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "pa-profile-owner-")));
  for (const name of ["workspace", "fixture"]) fs.mkdirSync(path.join(root, name));
  let owner: Awaited<ReturnType<typeof openOwner>> | undefined;
  try {
    owner = await openOwner(root, "desktop");
    const file = path.join(root, "profiles/t/config.toml"), before = fs.readFileSync(file);
    await expect(openOwner(root, "headless", { command: "/fixture/different-codex" })).rejects.toThrow(/lease is held/);
    expect(fs.readFileSync(file)).toEqual(before);
  } finally { await removeOwnerFixture(root, owner); }
}, 120_000);

it("the Outpost spawn home stays equal to the explicit preflight home despite saved desktop mappings", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "pa-profile-home-")));
  for (const name of ["workspace", "fixture", "dedicated", "profiles/t"]) fs.mkdirSync(path.join(root, name), { recursive: true });
  fs.writeFileSync(path.join(root, "profiles/t/config.toml"), '[models.codex]\nprofile = "work"\n');
  let owner: Awaited<ReturnType<typeof openOwner>> | undefined;
  try {
    owner = await openOwner(root, "headless", { home: path.join(root, "dedicated") });
    expect((await owner.call<NodeJS.ProcessEnv>("resolveCodexSpawnEnvAsync", undefined)).CODEX_HOME).toBe(path.join(root, "dedicated"));
    expect(fs.readFileSync(path.join(root, "profiles/t/config.toml"), "utf8")).toContain('profile = "work"');
  } finally { await removeOwnerFixture(root, owner); }
}, 120_000);

// The persisted owner is the oracle: reads by a host without these providers
// must leave every stored byte intact, including provenance and observation time.
it("desktop → Codex-only headless → desktop preserves unsupported providers byte-for-byte", async ({ onTestFailed, onTestFinished }) => {
  const startedAt = performance.now();
  const phases: Array<[number, string]> = [];
  let activeRoot: string | undefined;
  let sample = 0;
  const trace: TraceOwnerPhase = phase => {
    phases.push([Math.round(performance.now() - startedAt), phase]);
    if (phases.length > 512) phases.shift();
  };
  let failed = false;
  onTestFailed(() => {
    failed = true;
    trace("test:failed");
    console.error("headless-profile-oracle-trace", JSON.stringify({ phases }));
    // The owner writes its shutdown barrier's phase outcomes to the profile
    // log. Read only the disposable fixture's tail before it can be removed.
    if (activeRoot) {
      try {
        const file = fs.openSync(path.join(activeRoot, "profiles/t/logs", resolveMainLogFileNameForProfile("t")), "r");
        try {
          const size = fs.fstatSync(file).size;
          const tail = Buffer.alloc(Math.min(size, 6000));
          const read = fs.readSync(file, tail, 0, tail.length, size - tail.length);
          console.error("headless-profile-oracle-owner-log", tail.toString("utf8", 0, read));
        } finally { fs.closeSync(file); }
      } catch (error) {
        console.error("headless-profile-oracle-owner-log unavailable", (error as NodeJS.ErrnoException).code);
      }
    }
  });
  if (process.env.PWRAGENT_HEADLESS_PROFILE_ORACLE_TRACE === "1") {
    onTestFinished(() => {
      if (!failed) console.error("headless-profile-oracle-trace", JSON.stringify({ phases }));
    });
  }

  // Each example builds and starts three owners. Report the first failure
  // and its seed before shrinking can spend the Vitest deadline.
  await fc.assert(fc.asyncProperty(fc.uuid(), fc.stringMatching(/^[A-Z][a-z]{0,8}$/), async (threadId, suffix) => {
    const example = ++sample;
    trace(`${example} setup:start`);
    const root = fs.realpathSync(fs.mkdtempSync(path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "pa-unsupported-")));
    activeRoot = root;
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
      trace(`${example} setup:done`);
      for (const [index, kind] of (["desktop", "headless", "desktop"] as const).entries()) {
        const ownerTrace: TraceOwnerPhase = phase => trace(`${example}:${index + 1}:${kind} ${phase}`);
        host = await openOwner(root, kind, { trace: ownerTrace });
        await host.call("listThreads", { forceRefresh: true, enrichDirectories: false });
        for (const backend of ["claude", "acp:gemini"]) {
          ownerTrace(`provider:${backend}`);
          await host.call("getNavigationSelectedDetail", { protocol: 2, ref: { backend, threadId } });
          await expect(host.call("startTurn", { backend, threadId, input: [{ type: "text", text: "Must refuse" }] })).rejects.toThrow(/disabled/);
        }
        ownerTrace("running-snapshot:start");
        expect(snapshot(), `${kind} changed unsupported provider state`).toBe(expected);
        ownerTrace("running-snapshot:done");
        await host.close(); host = undefined;
        ownerTrace("stopped-snapshot:start");
        expect(snapshot(), `${kind} shutdown changed unsupported provider state`).toBe(expected);
        ownerTrace("stopped-snapshot:done");
      }
    } catch (error) {
      trace(`${example} failed: ${String(error).slice(0, 900)}`);
      throw error;
    } finally {
      trace(`${example} cleanup:start`);
      await removeOwnerFixture(root, host);
      activeRoot = undefined;
      trace(`${example} cleanup:done`);
    }
  }), { numRuns: 3, endOnFailure: true });
}, 120_000);
