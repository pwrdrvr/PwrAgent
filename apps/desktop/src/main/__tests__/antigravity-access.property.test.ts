import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { FakeAcpAgentTransport } from "../acp/testing/fake-acp-agent";
import { createDesktopBackendRegistry, registryModules } from "../app-server/backend-registry-wiring";
import { MAX_QUEUE_FLUSH_ATTEMPTS } from "../app-server/backend-registry-runtime-helpers";
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
import {
  normalizeAntigravityAccessTarget,
  sameAntigravityAccessState,
  type AntigravityAccessState,
} from "@pwragent/shared/provider-access-mode";

const backend = "acp:antigravity";
type Access = "default" | "full-access";
type NativeMode = "default" | "accept-edits" | "auto" | "plan";
type Model = {
  applied: AntigravityAccessState;
  active: boolean;
  pending?: AntigravityAccessState;
};
type Action =
  | { type: "select"; access: Access; nativeMode?: NativeMode }
  | { type: "legacy-runtime-mode"; nativeMode: NativeMode }
  | { type: "start" }
  | { type: "finish" }
  | { type: "failed-load" }
  | { type: "overlay-failure" }
  | { type: "lower-access-prompt" }
  | { type: "finish-with-blocked-close" }
  | { type: "reject-queued-native-mode"; turns: number }
  | { type: "retry-downgrade" }
  | { type: "inherit"; child: "review" | "monitor" };

async function exercise(
  initial: Access,
  commands: Iterable<fc.AsyncCommand<Model, Real>>,
  options?: {
    db?: StateDb;
    legacy?: boolean;
    legacyFullAccess?: { mode: NativeMode; openWithPicker: boolean };
    shellEnvironment?: Record<string, string>;
    verifyQueuedProjection?: boolean;
  },
) {
  const db = options?.db;
  const sessionId = "test-session";
  const sessions = db ? new AcpSessionStore(db) : createAcpSessionStoreMock([]);
  const base = createKimiAgentRecord(backend);
  const modeValues = [
    { value: "default", name: "Default" },
    { value: "accept-edits", name: "Accept Edits" },
    { value: "auto", name: "Auto" },
    { value: "plan", name: "Plan" },
  ];
  const record = {
    ...base, registryId: "antigravity", name: "Antigravity", version: "1.5.15",
    launchDescriptor: { ...base.launchDescriptor!, registryId: "antigravity", command: "agy", args: ["acp", "--process-per-session"] },
    runtimeCapabilities: {
      schemaVersion: 1 as const,
      status: "discovered" as const,
      configOptions: [{
        id: "mode",
        label: "Mode",
        type: "select" as const,
        category: "mode" as const,
        currentValue: "default",
        values: modeValues.map((entry) => ({ value: entry.value, label: entry.name })),
      }],
      modes: {
        availableModes: modeValues.map((entry) => ({ id: entry.value, label: entry.name })),
        currentModeId: "default",
      },
    },
  };
  const agents = db ? new AcpAgentStore(db) : createAcpAgentStoreMock([]);
  agents.upsertInstalledAgent(record);
  const workers = new Set<Access>();
  const modes = new Map<Access, string>();
  const modeOptions = (currentValue: string) => [{
    type: "select", id: "mode", category: "mode", name: "Mode", currentValue,
    options: modeValues,
  }];
  const prompts: Array<{ access: Access; mode: string }> = [];
  let failNextLoad = false;
  let closeBlocked = false;
  let closeAttempts = 0;
  let rejectNativeMode = false;
  let rejectedModeAttempts = 0;
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
              if (method === "session/load" && options?.legacyFullAccess && access === "full-access") {
                modes.set(access, options.legacyFullAccess.mode);
              }
              if (method === "session/load" && failNextLoad) {
                failNextLoad = false;
                throw new Error("Lost the load reply after opening the worker");
              }
              return { sessionId, configOptions: modeOptions(modes.get(access)!) };
            case "session/close":
              expect(active).toBeUndefined();
              closeAttempts += 1;
              if (closeBlocked) throw new Error("A background command is still running");
              expect(workers.delete(access)).toBe(true);
              return {};
            case "session/set_config_option": {
              expect(workers.has(access)).toBe(true);
              const nextMode = String(params?.value ?? "default");
              expect(params).toMatchObject({ sessionId, configId: "mode", value: nextMode });
              if (rejectNativeMode) {
                rejectedModeAttempts += 1;
                throw new Error("Worker rejected the native mode");
              }
              modes.set(access, nextMode);
              return { configOptions: modeOptions(nextMode) };
            }
            case "session/prompt": {
              expect([...workers]).toEqual([access]);
              expect(access).toBe(sessions.getSession(backend, sessionId)?.executionMode);
              prompts.push({ access, mode: modes.get(access) ?? "default" });
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
  const queuedNotifications: unknown[] = [];
  const unsubscribe = registry.onEvent((event) => {
    if (event.notification.method === "turn/completed") expectTerminal?.();
    if (event.notification.method === "thread/executionMode/updated") {
      accessUpdates.push(event.notification.params.executionMode);
    }
    if (event.notification.method === "thread/executionMode/queued") {
      queuedNotifications.push(event.notification.params);
    }
  });
  try {
    const catalog = (await registry.listBackends({ includeUnavailable: true })).backends.find(
      (entry) => entry.kind === backend,
    );
    expect(catalog?.executionModes.map((entry) => entry.mode)).toEqual(["default", "full-access"]);
    if (options?.legacy || options?.legacyFullAccess) {
      const mode = options.legacyFullAccess?.mode;
      sessions.upsertSession({
        backendId: backend, sessionId, cwd: nonRepositoryCwd, title: "Legacy session",
        executionMode: "full-access", status: "idle", createdAt: 1, updatedAt: 1,
        ...(mode ? {
          antigravityFullAccessConfirmed: true,
          acpRuntime: { currentModeId: mode, configValues: { mode }, updatedAt: 1 },
        } : {}),
      });
      if (options.legacyFullAccess?.openWithPicker) {
        await registry.setThreadExecutionMode({ backend, threadId: sessionId, executionMode: "full-access" });
      } else {
        await registry.readThread({ backend, threadId: sessionId });
      }
    } else {
      await registry.startThread({ backend, cwd: nonRepositoryCwd, executionMode: initial });
    }
    if (options?.shellEnvironment) {
      await registry.constructionPorts().acpBackend.prepareSessionEnvironment(backend, sessionId, options.shellEnvironment);
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
          case "select": {
            const target = normalizeAntigravityAccessTarget({
              executionMode: action.access,
              nativeMode: action.nativeMode,
            });
            await registry.setThreadExecutionMode({
              backend,
              threadId: sessionId,
              executionMode: action.access,
              ...(action.nativeMode
                ? { acpMode: { source: "configOption", optionId: "mode", value: action.nativeMode } }
                : {}),
            });
            if (sameAntigravityAccessState(target, model.applied)) {
              model.pending = undefined;
            } else if (model.active) {
              model.pending = target;
            } else {
              model.applied = target;
              model.pending = undefined;
            }
            break;
          }
          case "legacy-runtime-mode": {
            const target = normalizeAntigravityAccessTarget({
              executionMode: "default",
              nativeMode: action.nativeMode,
            });
            await registry.setAcpSessionRuntimeOption({
              backend,
              threadId: sessionId,
              source: "configOption",
              optionId: "mode",
              value: action.nativeMode,
            });
            if (sameAntigravityAccessState(target, model.applied)) {
              model.pending = undefined;
            } else if (model.active) {
              model.pending = target;
            } else {
              model.applied = target;
              model.pending = undefined;
            }
            break;
          }
          case "failed-load": {
            const target = model.applied.executionMode === "default" ? "full-access" : "default";
            failNextLoad = true;
            await expect(registry.setThreadExecutionMode({ backend, threadId: sessionId, executionMode: target }))
              .rejects.toThrow("Lost the load reply");
            expect(sessions.getSession(backend, sessionId)?.executionMode).toBe(model.applied.executionMode);
            // Reading after a failed move must release the possibly-open
            // target before reloading the session through the applied process.
            await registry.readThread({ backend, threadId: sessionId });
            break;
          }
          case "overlay-failure": {
            const targetAccess: Access = model.applied.executionMode === "default" ? "full-access" : "default";
            const target = normalizeAntigravityAccessTarget({ executionMode: targetAccess });
            await overlayStore.setThreadExecutionMode({
              backend,
              threadId: sessionId,
              executionMode: model.applied.executionMode,
            });
            const project = vi.spyOn(overlayStore, "setThreadExecutionMode")
              .mockRejectedValueOnce(new Error("Cannot write the permission overlay"));
            try {
              await registry.setThreadExecutionMode({ backend, threadId: sessionId, executionMode: targetAccess });
              expect(accessUpdates.at(-1)).toBe(targetAccess);
              model.applied = target;
            } finally {
              project.mockRestore();
            }
            break;
          }
          case "inherit": {
            const overlay = await overlayStore.getThreadOverlayState({ backend, threadId: sessionId });
            expect(overlay?.executionMode).toBe(model.applied.executionMode === "default" ? "full-access" : "default");
            const modules = registryModules(registry);
            const stop = new Error("Child access observed");
            const startChild = vi.spyOn(registry as unknown as {
              startAcpSession: typeof registry["startAcpSession"];
            }, "startAcpSession").mockRejectedValueOnce(stop);
            try {
              const child = action.child === "review"
                ? modules.managedReviewService["startManagedReviewChild"]({
                    backend, parentBackend: backend, parentThreadId: sessionId, overlay,
                    modelSettings: {}, target: { type: "baseBranch", branch: "main" },
                    terminals: { backend, threadId: sessionId }, tokenMiserEnabled: false,
                  })
                : modules.subAgentMonitorService["startManagedTaskMonitor"]({
                    context: { backend, threadId: sessionId, turnId: "parent-turn" },
                    cwd: nonRepositoryCwd, monitorBackend: backend, monitorId: "test-monitor",
                    preferredModel: "default", preferredReasoningEffort: "provider-default", prompt: "Monitor the job",
                  });
              await expect(child).rejects.toBe(stop);
              expect(startChild).toHaveBeenCalledWith(expect.objectContaining({
                backend,
                executionMode: model.applied.executionMode,
              }));
            } finally {
              startChild.mockRestore();
            }
            break;
          }
          case "start":
            await start();
            expect(prompts.at(-1)).toEqual({
              access: model.applied.executionMode,
              mode: model.applied.nativeMode,
            });
            model.active = true;
            break;
          case "lower-access-prompt": {
            const previousPrompts = prompts.length;
            if (model.applied.executionMode === "full-access") {
              await expect(start("default")).rejects.toThrow("lower access mode");
              expect(prompts).toHaveLength(previousPrompts);
            } else {
              await start("default");
              expect(prompts.slice(previousPrompts)).toEqual([{
                access: "default",
                mode: model.applied.nativeMode,
              }]);
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
            const target = model.pending ?? { executionMode: "default" as const, nativeMode: "default" };
            for (let attempt = 0; attempt < 4; attempt++) {
              await expect(start()).rejects.toThrow("switching to Default Access");
              expect(prompts).toHaveLength(previousPrompts);
            }
            const attempts = closeAttempts;
            closeBlocked = false;
            await start();
            expect(closeAttempts).toBe(attempts + 1);
            expect(prompts.slice(previousPrompts)).toEqual([{
              access: target.executionMode,
              mode: target.nativeMode,
            }]);
            model.applied = target;
            model.pending = undefined;
            model.active = true;
            break;
          }
          case "reject-queued-native-mode": {
            rejectNativeMode = true;
            for (let turn = 0; turn < action.turns; turn++) {
              const previous = active!;
              active = undefined;
              previous.reply();
              await previous.done;
              await start();
            }
            expect(rejectedModeAttempts).toBe(MAX_QUEUE_FLUSH_ATTEMPTS);
            model.pending = undefined;
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
            model.applied = model.pending ?? model.applied;
            model.pending = undefined;
            break;
          }
        }
        expect([...workers]).toEqual([model.applied.executionMode]);
        expect(modes.get(model.applied.executionMode)).toBe(model.applied.nativeMode);
        if (model.applied.executionMode === "full-access") {
          expect(model.applied.nativeMode).toBe("default");
        }
        expect(sessions.getSession(backend, sessionId)?.executionMode).toBe(model.applied.executionMode);
        expect(Object.keys(registry.getQueuedExecutionModesSnapshot()).length).toBe(model.pending ? 1 : 0);
        if (model.pending && options?.verifyQueuedProjection) {
          const queue = registry.getQueuedExecutionModeForThread({ backend, threadId: sessionId });
          expect(queuedNotifications.at(-1)).toMatchObject({
            queuedExecutionMode: model.pending.executionMode,
            queuedNativeMode: model.pending.nativeMode,
          });
          expect(queue).toMatchObject({ mode: model.pending.executionMode, nativeMode: model.pending.nativeMode });
          expect(Object.values(registry.getQueuedExecutionModesSnapshot())).toEqual([queue]);
        }
      },
    };
    expect([...workers]).toEqual([initial]);
    expect(modes.get(initial)).toBe("default");
    if (options?.legacyFullAccess) {
      expect(sessions.getSession(backend, sessionId)?.acpRuntime?.configValues?.mode).toBe("default");
    }
    const model: Model = {
      applied: { executionMode: initial, nativeMode: "default" },
      active: false,
    };
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
    check: (model) =>
      action.type === "select"
      || action.type === "legacy-runtime-mode"
      || model.active === (
        action.type === "finish" || action.type === "finish-with-blocked-close" || action.type === "reject-queued-native-mode"
      ),
    run: async (model, real) => await real.dispatch(model, action),
    toString: () =>
      action.type === "select"
        ? `select ${action.access}:${action.nativeMode ?? "default"}`
        : action.type === "legacy-runtime-mode"
          ? `legacy-runtime-mode ${action.nativeMode}`
          : action.type,
  };
}

describe("Antigravity session access", () => {
  it("moves the only worker at turn boundaries and uses the applied access and native mode for every prompt", async () => {
    await fc.assert(fc.asyncProperty(
      fc.constantFrom<Access>("default", "full-access"),
      fc.commands([
        fc.constant(command({ type: "select", access: "default", nativeMode: "default" })),
        fc.constant(command({ type: "select", access: "default", nativeMode: "accept-edits" })),
        fc.constant(command({ type: "select", access: "default", nativeMode: "auto" })),
        fc.constant(command({ type: "select", access: "default", nativeMode: "plan" })),
        fc.constant(command({ type: "select", access: "full-access", nativeMode: "default" })),
        fc.constant(command({ type: "legacy-runtime-mode", nativeMode: "plan" })),
        fc.constant(command({ type: "legacy-runtime-mode", nativeMode: "accept-edits" })),
        fc.constant(command({ type: "start" })),
        fc.constant(command({ type: "lower-access-prompt" })),
        fc.constant(command({ type: "finish" })),
        fc.constant(command({ type: "failed-load" })),
        fc.constant(command({ type: "overlay-failure" })),
      ], { maxCommands: 20, size: "max" }),
      (initial, commands) => exercise(initial, commands, { verifyQueuedProjection: true }),
    ), { numRuns: 8 });
  });

  it("resets Plan back to Default when escalating to Full Access and restores native modes when leaving Full Access", async () => {
    await exercise("default", [
      command({ type: "select", access: "default", nativeMode: "plan" }),
      command({ type: "start" }),
      command({ type: "select", access: "full-access", nativeMode: "default" }),
      command({ type: "finish" }),
      command({ type: "start" }),
      command({ type: "select", access: "default", nativeMode: "accept-edits" }),
      command({ type: "finish" }),
      command({ type: "start" }),
      command({ type: "finish" }),
    ]);
  });

  it("confirms the requested native mode when moving an environment-specific worker", async () => {
    await fc.assert(fc.asyncProperty(
      fc.constantFrom<NativeMode>("plan", "auto", "accept-edits"),
      (nativeMode) => exercise("default", [
        command({ type: "select", access: "default", nativeMode }),
        command({ type: "select", access: "full-access" }),
        command({ type: "select", access: "default", nativeMode }),
        command({ type: "start" }),
        command({ type: "finish" }),
      ], { shellEnvironment: { FIXTURE_TOOLCHAIN: "enabled" } }),
    ), { numRuns: 6 });
  });

  it("publishes the same native queue target in events and owner reads", async () => {
    await exercise("default", [
      command({ type: "start" }),
      command({ type: "select", access: "default", nativeMode: "plan" }),
      command({ type: "finish" }),
    ], { verifyQueuedProjection: true });
  });

  it("reconciles the worker and stored runtime on the first use of a legacy Full Access session", async () => {
    await fc.assert(fc.asyncProperty(
      fc.constantFrom<NativeMode>("plan", "auto", "accept-edits"),
      fc.boolean(),
      (mode, openWithPicker) => exercise("full-access", [
        command({ type: "start" }), command({ type: "finish" }),
      ], { legacyFullAccess: { mode, openWithPicker } }),
    ), { numRuns: 8 });
  });

  it("stops retrying rejected native-only selections at the queue attempt limit", async () => {
    await fc.assert(fc.asyncProperty(
      fc.constantFrom<NativeMode>("plan", "auto", "accept-edits"),
      fc.integer({ min: MAX_QUEUE_FLUSH_ATTEMPTS + 1, max: MAX_QUEUE_FLUSH_ATTEMPTS + 4 }),
      (nativeMode, turns) => exercise("default", [
        command({ type: "start" }),
        command({ type: "select", access: "default", nativeMode }),
        command({ type: "reject-queued-native-mode", turns }),
        command({ type: "finish" }),
      ]),
    ), { numRuns: 8 });
  });

  it("refuses a lower-access prompt on a Full Access worker", async () => {
    await exercise("full-access", [command({ type: "lower-access-prompt" })]);
  });

  it("blocks prompts while a queued downgrade to Accept Edits cannot close the worker and retries before starting", async () => {
    await exercise("full-access", [
      command({ type: "start" }),
      command({ type: "select", access: "default", nativeMode: "accept-edits" }),
      command({ type: "finish-with-blocked-close" }),
      command({ type: "retry-downgrade" }),
      command({ type: "finish" }),
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
