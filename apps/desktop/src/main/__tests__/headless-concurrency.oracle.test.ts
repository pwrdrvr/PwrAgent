import { fork } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import type { AppServerBackendKind } from "@pwragent/shared";
import { afterAll, beforeAll, expect, it, onTestFinished } from "vitest";
import { buildHeadless } from "../../../scripts/build-headless.mjs";
import { ensureNamedProfileExists } from "../profile";
import { DesktopConfigStore } from "../settings/config-store/desktop-config-store";

type Thread = { backend: AppServerBackendKind; threadId: string };
type Turn = { turnId: string; queueEntryId?: string; queueStatus?: string };
type QueueEvent = { threadId: string; queueEntryId: string; turnId?: string; status: string; terminalStatus?: string };
type Host = {
  startThread(): Promise<Thread>;
  startTurn(thread: Thread, queueEntryId: string): Promise<Turn>;
  readThread(thread: Thread): Promise<{ threadStatus?: string; replay?: { lastAssistantMessage?: string } }>;
  policyProbe(): Promise<unknown>;
  requests(): Promise<Array<{ method: string; params: Record<string, unknown> }>>;
  complete(threads: Thread[], ids: string[]): Promise<QueueEvent[]>;
  stopDuringRequest(method: string, values: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
};

type Runtime = { root: string; outputDirectory: string; guard: string };

// The bundle is shared fixture setup, not the behavior under test. Building it
// once keeps each test's budget for the driver it forks.
let runtime: Runtime;
let runtimeRoot: string | undefined;
beforeAll(async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "headless-concurrency-")));
  runtimeRoot = root;
  const outputDirectory = path.join(root, "runtime");
  const fixture = path.join(import.meta.dirname, "fixtures/owner-conformance-codex-transport.ts");
  await buildHeadless({ outputDirectory, plugins: [{ name: "conformance-provider", setup(builder) {
    builder.onResolve({ filter: /(?:^|\/)stdio-transport$/ }, () => ({ path: "fixture-codex", namespace: "owned-codex" }));
    builder.onLoad({ filter: /.*/, namespace: "owned-codex" }, () => ({
      contents: `export { OwnerConformanceCodexTransport as StdioJsonRpcTransport } from ${JSON.stringify(fixture)};`, loader: "ts", resolveDir: import.meta.dirname,
    }));
    builder.onLoad({ filter: /headless[\\/]index\.ts$/ }, (args) => ({
      contents: fs.readFileSync(args.path, "utf8") + `\nexport { OwnerConformanceCodexTransport as fixtureCodex } from ${JSON.stringify(fixture)};`, loader: "ts",
    }));
  } }] });
  const guard = path.join(root, "guard.cjs");
  await build({
    entryPoints: [path.join(import.meta.dirname, "setup/agent-cli-spawn-guard.ts")], outfile: guard,
    bundle: true, platform: "node", format: "cjs", logLevel: "silent",
    plugins: [{ name: "child-hooks", setup(builder) {
      builder.onResolve({ filter: /^vitest$/ }, () => ({ path: "hooks", namespace: "child-test" }));
      builder.onLoad({ filter: /.*/, namespace: "child-test" }, () => ({
        contents: `export const afterEach = () => {}; export const afterAll = fn => process.once("exit", () => { try { fn(); } catch (error) { console.error(error.message); process.exitCode = 1; } });`, loader: "js",
      }));
    } }],
  });
  runtime = { root, outputDirectory, guard };
});
afterAll(() => {
  if (runtimeRoot) fs.rmSync(runtimeRoot, { recursive: true, force: true });
});

async function builtHost(): Promise<Host> {
  const { outputDirectory, guard } = runtime;
  const root = fs.realpathSync(fs.mkdtempSync(path.join(runtime.root, "host-")));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  const env = { ...process.env, PWRAGENT_HOME: path.join(root, "home"), PWRAGENT_PROFILE: "fixture", CLAUDE_CONFIG_DIR: path.join(root, "claude") };
  const profile = ensureNamedProfileExists("fixture", { env });
  const config = new DesktopConfigStore({ configPath: path.join(profile.profileDir, "config.toml") });
  config.recordProviderDiscovery("codex", { candidates: [], selectedCommand: process.execPath, selectedVersion: "0.159.2" });
  config.dispose();
  const driver = path.join(root, "driver.cjs");
  fs.writeFileSync(driver, `const app = require(${JSON.stringify(path.join(outputDirectory, "index.js"))});
    // The parent owns the channel. A reply that finishes after it disconnected
    // has no reader, so it is dropped instead of crashing the driver.
    const reply = message => {
      if (process.connected) process.send(message);
      else process.stderr.write("dropped reply after disconnect: " + message.id + "\\n");
    };
    app.startHeadlessHost().then(async services => {
      await services.config.write({ onboarding: { completed: true } }, ["onboarding"]);
      services.config.recordProviderDiscovery("codex", { candidates: [], selectedCommand: process.execPath, selectedVersion: "0.159.2" });
      const events = [], waiting = new Map();
      services.registry.onEvent(event => {
        if (event.notification.method !== "thread/turnQueue/updated") return;
        const value = event.notification.params;
        events.push(value);
        if (value.terminalStatus) waiting.get(value.queueEntryId)?.(value);
      });
      process.on("message", async request => {
        if (request.method === "stop") { process.disconnect(); process.emit("SIGTERM", "SIGTERM"); return; }
        try {
          let result;
          if (request.method === "requests") result = app.fixtureCodex.requests;
          else if (request.method === "policyProbe") {
            result = [];
            for (const values of [{ backend: "claude" }, { backend: "codex", executionMode: "full-access" }, { backend: "codex", approvalPolicy: "on-request" }, { backend: "codex", sandbox: "danger-full-access" }]) {
              try { await services.registry.startThread({ ...values, cwd: ${JSON.stringify(workspace)} }); result.push("admitted"); }
              catch { result.push("refused"); }
            }
          } else if (request.method === "complete") {
            const done = request.ids.map(id => new Promise(resolve => waiting.set(id, resolve)));
            for (const thread of request.threads) app.fixtureCodex.completeHeldTurn(thread.threadId);
            await Promise.all(done);
            result = events;
          } else result = await services.registry[request.method](request.params);
          reply({ id: request.id, result });
        } catch (error) { reply({ id: request.id, error: error.message }); }
      });
      reply({ ready: true });
    }).catch(error => { console.error(error.stack); process.exitCode = 1; if (process.connected) process.disconnect(); });`);
  const child = fork(driver, [], { env, execArgv: ["--require", guard], stdio: ["ignore", "pipe", "pipe", "ipc"] });
  // "close" waits for stdio to drain, so `output` is complete when it fires.
  const exited = once(child, "close");
  let output = "";
  child.stdout?.on("data", chunk => { output += chunk.toString(); });
  child.stderr?.on("data", chunk => { output += chunk.toString(); });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    if (child.connected) child.send({ method: "stop" });
    const [code] = await exited;
    fs.rmSync(root, { recursive: true, force: true });
    expect(code, output).toBe(0);
  };
  onTestFinished(close);
  await Promise.race([once(child, "message"), exited.then(([code]) => { throw new Error(`Node owner exited (${code}): ${output}`); })]);
  let id = 0;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  child.on("message", (raw) => {
    const message = raw as { id: number; result?: unknown; error?: string };
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) waiter?.reject(new Error(message.error));
    else waiter?.resolve(message.result);
  });
  void exited.then(([code]) => {
    for (const waiter of pending.values()) waiter.reject(new Error(`Node owner exited (${code}) before replying: ${output}`));
    pending.clear();
  });
  const call = <T>(method: string, values: Record<string, unknown>): Promise<T> => new Promise((resolve, reject) => {
    if (!child.connected) {
      reject(new Error(`Node owner disconnected before ${method}: ${output}`));
      return;
    }
    const requestId = ++id;
    pending.set(requestId, { resolve: value => resolve(value as T), reject });
    child.send({ id: requestId, method, ...values });
  });
  return {
    startThread: () => call("startThread", { params: { backend: "codex", cwd: workspace, executionMode: "auto" } }),
    startTurn: async (thread, queueEntryId) => {
      const turn = await call<{ status: string; entry: { id: string }; turnId?: string }>("submitTurn", {
        params: { ...thread, queueEntryId, delivery: "new_turn", input: [{ type: "text", text: "slow" }] },
      });
      return { turnId: turn.turnId ?? turn.entry.id, queueStatus: turn.status, queueEntryId: turn.entry.id };
    },
    readThread: thread => call("readThread", { params: thread }),
    policyProbe: () => call("policyProbe", {}), requests: () => call("requests", {}),
    complete: (threads, ids) => call("complete", { threads, ids }),
    stopDuringRequest: async (method, values) => {
      child.send({ id: ++id, method, ...values });
      await close();
      return output;
    },
    close,
  };
}

it("admits a new thread and two independently identified turns while both threads are active", async () => {
  const host = await builtHost();
  expect(await host.policyProbe()).toEqual(["refused", "refused", "refused", "refused"]);
  const a = await host.startThread();
  const b = await host.startThread();
  const turnA = await host.startTurn(a, "concurrent-a");
  const turnB = await host.startTurn(b, "concurrent-b");
  const newThread = await host.startThread().then(thread => ({ thread }), error => ({ error: String(error) }));
  const active = await Promise.all([host.readThread(a), host.readThread(b)]);
  expect({ queueA: turnA.queueStatus, queueB: turnB.queueStatus, states: active.map(value => value.threadStatus), newThread })
    .toMatchObject({ queueA: "started", queueB: "started", states: ["active", "active"], newThread: { thread: { backend: "codex", threadId: expect.any(String) } } });
  const providerRequests = await host.requests();
  for (const request of providerRequests.filter(value => value.method === "turn/start")) {
    expect(request.params).toMatchObject({ approvalPolicy: "never", sandboxPolicy: { type: "workspaceWrite", networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true } });
  }
  expect(providerRequests.filter(value => value.method === "turn/start")).toHaveLength(2);
  expect(turnA.queueEntryId).toBeTruthy();
  expect(turnB.queueEntryId).toBeTruthy();
  expect(turnB.queueEntryId).not.toBe(turnA.queueEntryId);
  const events = await host.complete([a, b], [turnA.queueEntryId!, turnB.queueEntryId!]);
  for (const [thread, turn] of [[a, turnA], [b, turnB]] as const) {
    expect(events).toContainEqual(expect.objectContaining({ threadId: thread.threadId, queueEntryId: turn.queueEntryId, turnId: turn.turnId, terminalStatus: "turn/completed" }));
    expect(events.filter(event => event.queueEntryId === turn.queueEntryId).some(event => ["blocked", "failed", "queued"].includes(event.status))).toBe(false);
  }
  const completed = await Promise.all([host.readThread(a), host.readThread(b)]);
  expect(completed.map(value => value.threadStatus)).toEqual(["idle", "idle"]);
  expect(completed.map(value => value.replay?.lastAssistantMessage)).toEqual(["Fixture result", "Fixture result"]);
});

it("exits cleanly when the parent stops the driver before a reply is sent", async () => {
  const host = await builtHost();
  const thread = await host.startThread();
  // readThread awaits the registry, so stop is handled first and the channel
  // is closed by the time the reply is ready.
  const output = await host.stopDuringRequest("readThread", { params: thread });
  // Without this, a driver that never replies would pass without the race.
  expect(output).toContain("dropped reply after disconnect");
});
