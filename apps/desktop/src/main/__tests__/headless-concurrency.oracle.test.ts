import { fork } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import type { AppServerBackendKind } from "@pwragent/shared";
import { expect, it, onTestFinished } from "vitest";
import { buildHeadless } from "../../../scripts/build-headless.mjs";
import { ensureNamedProfileExists } from "../profile";
import { DesktopConfigStore } from "../settings/config-store/desktop-config-store";
import { startOutpostDaemon } from "./helpers/outpost-daemon";

type Thread = { backend: AppServerBackendKind; threadId: string };
type Turn = { turnId: string; queueEntryId?: string; queueStatus?: string };
type QueueEvent = { threadId: string; queueEntryId: string; turnId?: string; status: string; terminalStatus?: string };
type Host = {
  startThread(): Promise<Thread>;
  startTurn(thread: Thread, queueEntryId: string): Promise<Turn>;
  readThread(thread: Thread): Promise<{ threadStatus?: string; replay?: { lastAssistantMessage?: string } }>;
  complete(threads: Thread[], ids: string[]): Promise<QueueEvent[]>;
  close(): Promise<void>;
};

async function builtHost(): Promise<Host> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "headless-concurrency-")));
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
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  const env = { ...process.env, PWRAGENT_HOME: path.join(root, "home"), PWRAGENT_PROFILE: "fixture", CLAUDE_CONFIG_DIR: path.join(root, "claude") };
  const profile = ensureNamedProfileExists("fixture", { env });
  const config = new DesktopConfigStore({ configPath: path.join(profile.profileDir, "config.toml") });
  config.recordProviderDiscovery("codex", { candidates: [], selectedCommand: process.execPath, selectedVersion: "0.159.2" });
  config.dispose();
  const driver = path.join(root, "driver.cjs");
  fs.writeFileSync(driver, `const app = require(${JSON.stringify(path.join(outputDirectory, "index.js"))});
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
          if (request.method === "complete") {
            const done = request.ids.map(id => new Promise(resolve => waiting.set(id, resolve)));
            for (const thread of request.threads) app.fixtureCodex.completeHeldTurn(thread.threadId);
            await Promise.all(done);
            result = events;
          } else result = await services.registry[request.method](request.params);
          process.send({ id: request.id, result });
        } catch (error) { process.send({ id: request.id, error: error.message }); }
      });
      process.send({ ready: true });
    }).catch(error => { console.error(error.stack); process.exitCode = 1; process.disconnect(); });`);
  const child = fork(driver, [], { env, execArgv: ["--require", guard], stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const exited = once(child, "exit");
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
  const call = <T>(method: string, values: Record<string, unknown>): Promise<T> => new Promise((resolve, reject) => {
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
    complete: (threads, ids) => call("complete", { threads, ids }), close,
  };
}

// Run this unchanged scenario against the old owner before its deletion:
// PWRAGENT_CONCURRENCY_BASELINE=legacy pnpm test <this file>
async function legacyHost(): Promise<Host> {
  const old = await startOutpostDaemon();
  onTestFinished(old.close);
  return {
    startThread: () => old.client.startThread({ backend: "codex", cwd: old.workspace, executionMode: "auto" }),
    startTurn: (thread, queueEntryId) => old.client.startTurn({ ...thread, queueEntryId, delivery: "new_turn", input: [{ type: "text", text: "slow" }] }),
    readThread: thread => old.client.readThread(thread),
    complete: async () => { throw new Error("The old owner must fail the overlap oracle before completion"); },
    close: old.close,
  };
}

it("admits a new thread and two independently identified turns while both threads are active", async () => {
  const host = process.env.PWRAGENT_CONCURRENCY_BASELINE === "legacy" ? await legacyHost() : await builtHost();
  const a = await host.startThread();
  const b = await host.startThread();
  const turnA = await host.startTurn(a, "concurrent-a");
  const turnB = await host.startTurn(b, "concurrent-b");
  const newThread = await host.startThread().then(thread => ({ thread }), error => ({ error: String(error) }));
  const active = await Promise.all([host.readThread(a), host.readThread(b)]);
  expect({ queueA: turnA.queueStatus, queueB: turnB.queueStatus, states: active.map(value => value.threadStatus), newThread })
    .toMatchObject({ queueA: "started", queueB: "started", states: ["active", "active"], newThread: { thread: { backend: "codex", threadId: expect.any(String) } } });
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
