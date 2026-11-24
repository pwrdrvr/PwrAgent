import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { FakeAcpAgentTransport } from "../acp/testing/fake-acp-agent";
import { createDesktopBackendRegistry } from "../app-server/backend-registry-wiring";
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
  | { type: "failed-load" } | { type: "plan" } | { type: "overlay-failure" };

async function exercise(initial: Access, commands: Iterable<fc.AsyncCommand<Model, Real>>, db?: StateDb) {
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
  let active: { reply: () => void; done: Promise<void> } | undefined;
  let expectTerminal: (() => void) | undefined;
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
    await registry.startThread({ backend, cwd: nonRepositoryCwd, executionMode: initial });
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
          case "start":
            await registry.startTurn({ backend, threadId: sessionId, input: [{ type: "text", text: "Test prompt" }] });
            expect(prompts.at(-1)).toBe(model.access);
            model.active = true;
            break;
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
    check: (model) => action.type === "select" || model.active === (action.type === "finish"),
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
        fc.constant(command({ type: "finish" })),
        fc.constant(command({ type: "failed-load" })),
        fc.constant(command({ type: "plan" })),
        fc.constant(command({ type: "overlay-failure" })),
      ], { maxCommands: 20, size: "max" }),
      (initial, commands) => exercise(initial, commands),
    ), { numRuns: 30 });
  });

  it("publishes the committed access when the overlay write fails", async () => {
    await exercise("default", [command({ type: "overlay-failure" }), command({ type: "start" }), command({ type: "finish" })]);
  });

  it("keeps access moves within their SQLite write budget", async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const { dbPath, tempDir } = createTempStateDb("antigravity-access-");
    const db = StateDb.open(dbPath);
    try {
      await exercise("default", [], db);
    } finally {
      db.close();
      removeTempStateDbDir(tempDir);
      vi.unstubAllEnvs();
    }
  });
});
