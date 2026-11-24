import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { FakeAcpAgentTransport } from "../acp/testing/fake-acp-agent";
import { createDesktopBackendRegistry, registryModules } from "../app-server/backend-registry-wiring";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { StateDb } from "../state/state-db";
import { AcpAgentStore } from "../storage/acp-agent-store";
import { AcpSessionStore } from "../storage/acp-session-store";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import {
  createAcpAgentStoreMock,
  createAcpSessionStoreMock,
  createKimiAgentRecord,
  createOverlayStoreMock,
  MockBackendClient,
  nonRepositoryCwd,
} from "./helpers/backend-registry-fixture";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

const backend = "acp:antigravity";
type Access = "default" | "full-access";
type Model = { access: Access; active: boolean; mode: "default" | "plan"; pending?: Access };
type Action = { type: "select"; access: Access } | { type: "start" } | { type: "finish" }
  | { type: "failed-load" } | { type: "plan" } | { type: "overlay-failure" }
  | { type: "lower-access-prompt" } | { type: "finish-with-blocked-close" } | { type: "retry-downgrade" }
  | { type: "inherit"; child: "review" | "monitor" };

async function exercise(
  initial: Access,
  commands: Iterable<fc.AsyncCommand<Model, Real>>,
  options?: { db?: StateDb; legacy?: boolean },
) {
  const db = options?.db;
  const sessionId = "test-session";
  const sessions = db ? new AcpSessionStore(db) : createAcpSessionStoreMock([]);
  const base = createKimiAgentRecord(backend);
  const record = {
    ...base, registryId: "antigravity", name: "Antigravity", version: "1.5.15",
    launchDescriptor: { ...base.launchDescriptor!, registryId: "antigravity", command: "agy", args: ["acp", "--process-per-session"] },
  };
  const agents = db ? new AcpAgentStore(db) : createAcpAgentStoreMock([]);
  agents.upsertInstalledAgent(record);
  const workers = new Set<Access>();
  const modes = new Map<Access, Model["mode"]>();
  const modeOptions = (currentValue: Model["mode"]) => [{
    type: "select", id: "mode", category: "mode", name: "Mode", currentValue,
    options: [{ value: "default", name: "Default" }, { value: "plan", name: "Plan" }],
  }];
  const prompts: Access[] = [];
  let failNextLoad = false;
  let closeBlocked = false;
  let closeAttempts = 0;
  let active: { reply: () => void; done: Promise<void> } | undefined;
  let expectTerminal: (() => void) | undefined;
  const start = (executionMode?: Access) => registry.startTurn({
    backend, threadId: sessionId, input: [{ type: "text", text: "Test prompt" }], executionMode,
  });
  const overlayStore = db ? new SqliteOverlayStore(db) : createOverlayStoreMock();
  const registry = createDesktopBackendRegistry({
    codexClient: new MockBackendClient({ threads: [] }),
    overlayStore,
    acpAgentStore: agents,
    acpSessionStore: sessions,
    createAcpTransport: (agent) => {
      const access = agent.launchDescriptor?.args.includes("--dangerously-skip-permissions") ? "full-access" : "default";
      return new class extends FakeAcpAgentTransport {
        override async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
          switch (method) {
            case "initialize":
              return { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } } };
            case "session/new":
            case "session/load":
              expect(workers.size).toBe(0);
              workers.add(access);
              modes.set(access, "default");
              if (method === "session/load" && failNextLoad) {
                failNextLoad = false;
                throw new Error("Lost the load reply after opening the worker");
              }
              return { sessionId, configOptions: modeOptions("default") };
            case "session/close":
              expect(active).toBeUndefined();
              closeAttempts += 1;
              if (closeBlocked) throw new Error("A background command is still running");
              expect(workers.delete(access)).toBe(true);
              return {};
            case "session/set_config_option":
              expect(workers.has(access)).toBe(true);
              expect(params).toMatchObject({ sessionId, configId: "mode", value: "plan" });
              modes.set(access, "plan");
              return { configOptions: modeOptions("plan") };
            case "session/prompt": {
              expect([...workers]).toEqual([access]);
              expect(access).toBe(sessions.getSession(backend, sessionId)?.executionMode);
              prompts.push(access);
              const reply = Promise.withResolvers<void>();
              const done = Promise.withResolvers<void>();
              expectTerminal = done.resolve;
              active = {
                done: done.promise,
                reply: () => {
                  this.emitSessionUpdate(String(params?.sessionId), {
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: "Test reply" },
                  });
                  reply.resolve();
                },
              };
              await reply.promise;
              return { stopReason: "end_turn" };
            }
            default:
              return await super.request(method, params);
          }
        }
      }();
    },
  });
  const accessUpdates: unknown[] = [];
  const unsubscribe = registry.onEvent((event) => {
    if (event.notification.method === "turn/completed") expectTerminal?.();
    if (event.notification.method === "thread/executionMode/updated") {
      accessUpdates.push(event.notification.params.executionMode);
    }
  });
  try {
    const catalog = (await registry.listBackends({ includeUnavailable: true })).backends.find(
      (entry) => entry.kind === backend,
    );
    expect(catalog?.executionModes.map((entry) => entry.mode)).toEqual(["default", "full-access"]);
    if (options?.legacy) {
      sessions.upsertSession({
        backendId: backend, sessionId, cwd: nonRepositoryCwd, title: "Legacy session",
        executionMode: "full-access", status: "idle", createdAt: 1, updatedAt: 1,
      });
      await registry.readThread({ backend, threadId: sessionId });
    } else {
      await registry.startThread({ backend, cwd: nonRepositoryCwd, executionMode: initial });
    }
    if (db) {
      db.raw.pragma("wal_checkpoint(TRUNCATE)");
      const { writes } = await measureSqliteWrites(async () => {
        await registry.setThreadExecutionMode({ backend, threadId: sessionId, executionMode: "full-access" });
      });
      expectSqliteWriteBudget({
        scenario: "antigravity-access-session-move",
        note: "One idle Antigravity access change, including the session reload and the applied permission audit entry",
        writes,
      });
      return;
    }
    const real: Real = {
      dispatch: async (model, action) => {
        switch (action.type) {
          case "select":
            await registry.setThreadExecutionMode({ backend, threadId: sessionId, executionMode: action.access });
            if (model.active) {
              model.pending = action.access !== model.access ? action.access : undefined;
            } else {
              model.access = action.access;
            }
            break;
          case "failed-load": {
            const target = model.access === "default" ? "full-access" : "default";
            failNextLoad = true;
            await expect(registry.setThreadExecutionMode({ backend, threadId: sessionId, executionMode: target }))
              .rejects.toThrow("Lost the load reply");
            expect(sessions.getSession(backend, sessionId)?.executionMode).toBe(model.access);
            // Reading after a failed move must release the possibly-open
            // target before reloading the session through the applied process.
            await registry.readThread({ backend, threadId: sessionId });
            break;
          }
          case "plan":
            await registry.setAcpSessionRuntimeOption({
              backend, threadId: sessionId, source: "configOption", optionId: "mode", value: "plan",
            });
            model.mode = "plan";
            break;
          case "overlay-failure": {
            const target = model.access === "default" ? "full-access" : "default";
            await overlayStore.setThreadExecutionMode({ backend, threadId: sessionId, executionMode: model.access });
            const project = vi.spyOn(overlayStore, "setThreadExecutionMode")
              .mockRejectedValueOnce(new Error("Cannot write the permission overlay"));
            try {
              await registry.setThreadExecutionMode({ backend, threadId: sessionId, executionMode: target });
              expect(accessUpdates.at(-1)).toBe(target);
              model.access = target;
            } finally {
              project.mockRestore();
            }
            break;
          }
          case "inherit": {
            const overlay = await overlayStore.getThreadOverlayState({ backend, threadId: sessionId });
            expect(overlay?.executionMode).toBe(model.access === "default" ? "full-access" : "default");
            const modules = registryModules(registry);
            const stop = new Error("Child access observed");
            const startChild = vi.spyOn(registry as unknown as {
              startAcpSession: typeof registry["startAcpSession"];
            }, "startAcpSession").mockRejectedValueOnce(stop);
            try {
              const child = action.child === "review"
                ? modules.managedReviewService["startManagedReviewChild"]({
                    backend, parentBackend: backend, parentThreadId: sessionId, overlay,
                    modelSettings: {}, target: { type: "baseBranch", branch: "main" }, tokenMiserEnabled: false,
                  })
                : modules.subAgentMonitorService["startManagedTaskMonitor"]({
                    context: { backend, threadId: sessionId, turnId: "parent-turn" },
                    cwd: nonRepositoryCwd, monitorBackend: backend, monitorId: "test-monitor",
                    preferredModel: "default", preferredReasoningEffort: "provider-default", prompt: "Monitor the job",
                  });
              await expect(child).rejects.toBe(stop);
              expect(startChild).toHaveBeenCalledWith(expect.objectContaining({ backend, executionMode: model.access }));
            } finally {
              startChild.mockRestore();
            }
            break;
          }
          case "start":
            await start();
            expect(prompts.at(-1)).toBe(model.access);
            model.active = true;
            break;
          case "lower-access-prompt": {
            const previousPrompts = prompts.length;
            if (model.access === "full-access") {
              await expect(start("default")).rejects.toThrow("lower access mode");
              expect(prompts).toHaveLength(previousPrompts);
            } else {
              await start("default");
              expect(prompts.slice(previousPrompts)).toEqual(["default"]);
              model.active = true;
            }
            break;
          }
          case "finish-with-blocked-close": {
            closeBlocked = true;
            const previous = active!;
            active = undefined;
            previous.reply();
            await previous.done;
            model.active = false;
            break;
          }
          case "retry-downgrade": {
            const previousPrompts = prompts.length;
            for (let attempt = 0; attempt < 4; attempt++) {
              await expect(start()).rejects.toThrow("switching to Default Access");
              expect(prompts).toHaveLength(previousPrompts);
            }
            const attempts = closeAttempts;
            closeBlocked = false;
            await start();
            expect(closeAttempts).toBe(attempts + 1);
            expect(prompts.slice(previousPrompts)).toEqual(["default"]);
            model.access = "default";
            model.pending = undefined;
            model.active = true;
            break;
          }
          case "finish": {
            const previous = active!;
            active = undefined;
            const moves = model.pending !== undefined;
            const applied = moves ? Promise.withResolvers<void>() : undefined;
            const stopWatching = registry.onEvent((event) => {
              if (event.notification.method === "thread/executionMode/queueCleared") applied?.resolve();
            });
            try {
              previous.reply();
              await previous.done;
              await applied?.promise;
            } finally {
              stopWatching();
            }
            model.active = false;
            model.access = model.pending ?? model.access;
            model.pending = undefined;
            break;
          }
        }
        expect([...workers]).toEqual([model.access]);
        expect(modes.get(model.access)).toBe(model.mode);
        expect(sessions.getSession(backend, sessionId)?.executionMode).toBe(model.access);
        expect(Object.keys(registry.getQueuedExecutionModesSnapshot()).length).toBe(model.pending ? 1 : 0);
      },
    };
    expect([...workers]).toEqual([initial]);
    const model: Model = { access: initial, active: false, mode: "default" };
    await fc.asyncModelRun(() => ({ model, real }), commands);
  } finally {
    unsubscribe();
    active?.reply();
    await registry.close();
  }
}

type Real = { dispatch: (model: Model, action: Action) => Promise<void> };

function command(action: Action): fc.AsyncCommand<Model, Real> {
  return {
    check: (model) => action.type === "select"
      || model.active === (action.type === "finish" || action.type === "finish-with-blocked-close"),
    run: async (model, real) => await real.dispatch(model, action),
    toString: () => action.type === "select" ? "select " + action.access : action.type,
  };
}

describe("Antigravity session access", () => {
  it("moves the only worker at turn boundaries and uses the applied access for every prompt", async () => {
    await fc.assert(fc.asyncProperty(
      fc.constantFrom<Access>("default", "full-access"),
      fc.commands([
        fc.constant(command({ type: "select", access: "default" })),
        fc.constant(command({ type: "select", access: "full-access" })),
        fc.constant(command({ type: "start" })),
        fc.constant(command({ type: "lower-access-prompt" })),
        fc.constant(command({ type: "finish" })),
        fc.constant(command({ type: "failed-load" })),
        fc.constant(command({ type: "plan" })),
        fc.constant(command({ type: "overlay-failure" })),
      ], { maxCommands: 20, size: "max" }),
      (initial, commands) => exercise(initial, commands),
    ), { numRuns: 30 });
  });

  it("refuses a lower-access prompt on a Full Access worker", async () => {
    await exercise("full-access", [command({ type: "lower-access-prompt" })]);
  });

  it("blocks prompts while a queued downgrade cannot close the worker and retries before starting", async () => {
    await exercise("full-access", [
      command({ type: "start" }), command({ type: "select", access: "default" }),
      command({ type: "finish-with-blocked-close" }), command({ type: "retry-downgrade" }), command({ type: "finish" }),
    ]);
  });

  it("loads an unconfirmed legacy Full Access session with permissions enabled until escalation", async () => {
    await exercise("default", [
      command({ type: "start" }), command({ type: "finish" }), command({ type: "select", access: "full-access" }),
      command({ type: "start" }), command({ type: "finish" }),
    ], { legacy: true });
  });

  it("publishes the committed access when the overlay write fails", async () => {
    await exercise("default", [command({ type: "overlay-failure" }), command({ type: "start" }), command({ type: "finish" })]);
  });

  it.each(["review", "monitor"] as const)(
    "inherits committed session access for a %s child when the overlay write fails",
    async (child) => {
      await fc.assert(fc.asyncProperty(
        fc.constantFrom<Access>("default", "full-access"),
        (initial) => exercise(initial, [command({ type: "overlay-failure" }), command({ type: "inherit", child })]),
      ), { numRuns: 6 });
    },
  );

  it("keeps access moves within their SQLite write budget", async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const { dbPath, tempDir } = createTempStateDb("antigravity-access-");
    const db = StateDb.open(dbPath);
    try {
      await exercise("default", [], { db });
    } finally {
      db.close();
      removeTempStateDbDir(tempDir);
      vi.unstubAllEnvs();
    }
  });
});
