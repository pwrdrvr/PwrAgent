import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppServerBackendKind } from "@pwragent/shared/contracts/normalized-app-server";
import { expect, inject, it, onTestFinished, vi } from "vitest";
import fc from "fast-check";
// Keep the build script in Vitest's watch graph. Global setup runs the build.
import "../../../scripts/build-headless.mjs";
import { requireOracleFixture } from "../../test-setup/oracle-fixture-context";
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

async function builtHost(
  signal: AbortSignal,
  observe?: (child: ChildProcess, close: () => Promise<void>) => void,
): Promise<Host> {
  const { outputDirectory, guard } = requireOracleFixture(inject("headlessDriver"));
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "headless-concurrency-host-")));
  let closeHost: (() => Promise<void>) | undefined;
  onTestFinished(async () => {
    try { await closeHost?.(); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  const env = { ...process.env, PWRAGENT_HOME: path.join(root, "home"), PWRAGENT_PROFILE: "fixture", CLAUDE_CONFIG_DIR: path.join(root, "claude") };
  const profile = ensureNamedProfileExists("fixture", { env });
  const config = new DesktopConfigStore({ configPath: path.join(profile.profileDir, "config.toml") });
  config.recordProviderDiscovery("codex", { candidates: [], selectedCommand: process.execPath, selectedVersion: "0.159.2" });
  config.dispose();
  const driver = path.join(root, "driver.cjs");
  // A synchronous file write survives the driver exiting right after it.
  // Windows can drop a stderr pipe write that is still pending at exit.
  const droppedReplies = path.join(root, "dropped-replies.log");
  // Startup redirects console.error to a file and Vitest mutes its console
  // transport. Write failures to stderr directly so the parent can report them.
  fs.writeFileSync(driver, `const app = require(${JSON.stringify(path.join(outputDirectory, "index.js"))});
    // The parent owns the channel. A reply that finishes after it disconnected
    // has no reader, so it is dropped instead of crashing the driver.
    const reply = message => {
      if (process.connected) process.send(message);
      else require("node:fs").appendFileSync(${JSON.stringify(droppedReplies)}, "dropped reply after disconnect: " + message.id + "\\n");
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
          else if (request.method === "replyAfterDisconnect") {
            await new Promise(resolve => process.once("disconnect", resolve));
            result = "late";
          }
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
    }).catch(error => { require("node:fs").writeSync(2, error.stack + "\\n"); process.exitCode = 1; if (process.connected) process.disconnect(); });`);
  const child = fork(driver, [], { env, execArgv: ["--require", guard], stdio: ["ignore", "pipe", "pipe", "ipc"] });
  // "close" waits for stdio to drain, so `output` is complete when it fires.
  const exited = once(child, "close");
  let output = "";
  child.stdout?.on("data", chunk => { output += chunk.toString(); });
  child.stderr?.on("data", chunk => { output += chunk.toString(); });
  const send = (message: object): Promise<void> => new Promise((resolve, reject) => {
    child.send(message, error => { if (error) reject(error); else resolve(); });
  });
  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= (async () => {
      // Keep a failed stop write visible, but still join process and pipe
      // retirement before the test can remove the driver's state.
      const stopped = child.connected ? send({ method: "stop" }).then(() => undefined, (error: Error) => error) : undefined;
      const [code] = await exited;
      const error = await stopped;
      if (error) throw error;
      expect(code, output).toBe(0);
    })();
    return closing;
  };
  closeHost = close;
  observe?.(child, close);
  try {
    await Promise.race([once(child, "message"), exited.then(([code]) => { throw new Error(`Node owner exited (${code}): ${output}`); })]);
    signal.throwIfAborted();
    if (closing) throw new Error("Node owner retired during startup");
  } catch (error) {
    await close();
    throw error;
  }
  let id = 0;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  child.on("message", (raw) => {
    const message = raw as { id: number; result?: unknown; error?: string };
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) waiter?.reject(new Error(message.error));
    else waiter?.resolve(message.result);
  });
  const rejectPending = (error: Error) => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  void exited.then(([code]) => {
    rejectPending(new Error(`Node owner exited (${code}) before replying: ${output}`));
  }, rejectPending);
  const assertOpen = (method: string) => {
    signal.throwIfAborted();
    if (closing) throw new Error(`Node owner is closing before ${method}`);
    if (!child.connected) throw new Error(`Node owner disconnected before ${method}: ${output}`);
  };
  const call = <T>(method: string, values: Record<string, unknown>): Promise<T> => new Promise((resolve, reject) => {
    assertOpen(method);
    const requestId = ++id;
    pending.set(requestId, { resolve: value => resolve(value as T), reject });
    void send({ id: requestId, method, ...values }).catch(error => {
      const waiter = pending.get(requestId);
      pending.delete(requestId);
      waiter?.reject(error);
    });
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
      assertOpen(method);
      await send({ id: ++id, method, ...values });
      await close();
      return fs.readFileSync(droppedReplies, "utf8");
    },
    close,
  };
}

it("admits a new thread and two independently identified turns while both threads are active", async ({ signal }) => {
  const host = await builtHost(signal);
  // Claude, an unallowed mode and a sandbox above the mode's are refused. An
  // approval policy is not: the default Outpost asks for approval as a desktop does.
  expect(await host.policyProbe()).toEqual(["refused", "refused", "admitted", "refused"]);
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
    expect(request.params).toMatchObject({ approvalPolicy: "on-request", permissions: "pwragent-outpost-workspace-write" });
    expect(request.params).not.toHaveProperty("sandboxPolicy");
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

it("exits cleanly when the parent stops the driver before a reply is sent", async ({ signal }) => {
  const host = await builtHost(signal);
  // The request settles only once the channel is closed, so its reply always
  // comes after the disconnect. A registry call could settle on either side
  // of the stop depending on the platform.
  const dropped = await host.stopDuringRequest("replyAfterDisconnect", {});
  // Without this, a driver that never replies would pass without the race.
  expect(dropped).toContain("dropped reply after disconnect");
});

it("joins every close caller to the actual process and pipe retirement", async ({ signal }) => {
  let retired = false;
  const host = await builtHost(signal, child => { child.once("close", () => { retired = true; }); });
  const stopping = host.close();
  try {
    await host.close();
    expect(retired).toBe(true);
  } finally {
    await stopping;
  }
});

it("rejects readiness when its test aborts at the child's ready message", async () => {
  const aborted = new AbortController();
  const reason = new Error("controlled test abort at native readiness");
  let retire: (() => Promise<void>) | undefined;
  try {
    const host = builtHost(aborted.signal, (child, close) => {
      retire = close;
      // This is the real child's protocol event, before the readiness await
      // resumes. No deadline or scheduling delay chooses the interleaving.
      child.prependOnceListener("message", () => { aborted.abort(reason); });
    });
    await expect(host).rejects.toBe(reason);
  } finally {
    await retire?.();
  }
});

it.for(["abort", "stop"] as const)("admits no generated request after %s, even while IPC is connected", async (action, { signal }) => {
  let child!: ChildProcess;
  const aborted = new AbortController();
  const reason = new Error("controlled test abort before next request");
  const host = await builtHost(AbortSignal.any([signal, aborted.signal]), value => { child = value; });
  const sends = vi.spyOn(child, "send");
  const errors: Error[] = [];
  child.on("error", error => { errors.push(error); });
  if (action === "abort") aborted.abort(reason);
  else void host.close();
  // The minimal regression is a first thread request after abort or stop.
  const late = host.startThread().then(() => "admitted", error => error);
  try {
    if (action === "abort") expect(await late).toBe(reason);
    else expect(await late).toMatchObject({ message: "Node owner is closing before startThread" });
    await fc.assert(fc.asyncProperty(
      fc.array(fc.constantFrom("startThread", "requests", "policyProbe"), { minLength: 1, maxLength: 12 }),
      async methods => {
        signal.throwIfAborted();
        for (const method of methods) {
          if (action === "abort") await expect(host[method]()).rejects.toBe(reason);
          else await expect(host[method]()).rejects.toThrow("Node owner is closing");
        }
      },
    ));
    // Forward every real native send. A stop is the only write admitted once
    // closing; an aborted owner admits none before its cleanup starts.
    expect(sends.mock.calls.map(args => (args[0] as { method: string }).method)).toEqual(action === "stop" ? ["stop"] : []);
  } finally {
    await host.close();
    sends.mockRestore();
  }
  expect(errors).toEqual([]);
});
