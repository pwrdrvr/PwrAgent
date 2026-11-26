import type { BrowserWindow } from "electron";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FederationRemoteTarget } from "@pwragent/shared/contracts/federation";
import {
  RESEARCH_CHANGES_CHANNEL,
  RESEARCH_EVENTS_CHANNEL,
  RESEARCH_HARNESS_CHECK_CHANNEL,
  RESEARCH_HARNESS_RECONCILE_CHANNEL,
  RESEARCH_HARNESS_START_CHANNEL,
  RESEARCH_HARNESS_STATUS_CHANNEL,
  RESEARCH_ITEM_CHANNEL,
  RESEARCH_MATHOS_SWARMS_CHANNEL,
  RESEARCH_OPEN_EVIDENCE_CHANNEL,
  RESEARCH_OPEN_WINDOW_CHANNEL,
  RESEARCH_PREPARE_CHANNEL,
  RESEARCH_PROFILE_RUNS_CHANNEL,
  RESEARCH_SEARCH_CHANNEL,
  RESEARCH_SNAPSHOT_CHANNEL,
  RESEARCH_UPDATE_CHANNEL,
  RESEARCH_WITHDRAW_CHANNEL,
  RESEARCH_WORK_CHANNEL,
  RESEARCH_HARNESS_REVEAL_CONFIG_CHANNEL,
  RESEARCH_HARNESS_SETTINGS_CHECK_CHANNEL,
  RESEARCH_HARNESS_PICK_BRIDGE_CHANNEL,
  RESEARCH_MATHOS_TEAMS_CHANNEL,
} from "../../shared/ipc";

const fixture = vi.hoisted(() => {
  const handlers = new Map<string, (event: { sender: unknown }, request?: unknown) => unknown>();
  const localCalls: Array<{ operation: string; args: unknown[] }> = [];
  const remoteCalls: Array<{ target: FederationRemoteTarget; operation: string; request: unknown }> = [];
  const recordLocal = (operation: string) => vi.fn((...args: unknown[]) => {
    localCalls.push({ operation, args });
    if (operation === "prepare") return { intentId: "local-intent" };
    if (operation === "update" || operation === "harnessStart" || operation === "harnessReconcile") {
      return { id: "run-local", revision: 2, status: "running" };
    }
    if (operation === "harnessCheck") {
      return { ok: true, checkedAt: 1, capabilities: { import: true, execute: false, cancel: false, discovery: false, researchFunctions: false } };
    }
    if (operation === "harnessStatus") {
      return { configured: false, source: "mathos" };
    }
    if (operation === "listMathosSwarms") {
      return { ok: true, swarms: [], sessions: 0, truncated: false };
    }
    if (operation === "snapshot") return { runs: [], writableRunIds: [] };
    if (operation === "changes") return { runId: "run-local", revision: 1, state: {}, items: [], writable: true };
    if (operation === "events") return { runId: "run-local", revision: 1, events: [] };
    if (operation === "search") return { runId: "run-local", revision: 1, total: 0, items: [] };
    if (operation === "readItem") return { run: { id: "run-local" }, item: { id: "item-1" } };
    return undefined;
  });
  return {
    handlers,
    localCalls,
    remoteCalls,
    remoteFailure: undefined as Error | undefined,
    localResearch: {
      snapshot: recordLocal("snapshot"),
      changes: recordLocal("changes"),
      readEvents: recordLocal("events"),
      search: recordLocal("search"),
      readItem: recordLocal("readItem"),
      work: recordLocal("work"),
      prepare: recordLocal("prepare"),
      withdraw: recordLocal("withdraw"),
      update: recordLocal("update"),
      revisionDelivery: vi.fn(() => undefined),
      readEvidence: recordLocal("readEvidence"),
      profileRuns: recordLocal("profileRuns"),
    },
    localHarness: {
      check: recordLocal("harnessCheck"),
      start: recordLocal("harnessStart"),
      reconcile: recordLocal("harnessReconcile"),
    },
    localHarnessStatus: recordLocal("harnessStatus"),
    localListMathosSwarms: recordLocal("listMathosSwarms"),
    localListMathosTeams: recordLocal("listMathosTeams"),
    localOpenWindow: vi.fn(),
    localOpenDialog: vi.fn(async (..._args: unknown[]) => ({ canceled: true, filePaths: [] })),
    localRevealConfig: vi.fn(),
    requestResearchOperation: vi.fn(async (target: FederationRemoteTarget, operation: string, request: unknown) => {
      remoteCalls.push({ target, operation, request });
      if (fixture.remoteFailure) throw fixture.remoteFailure;
      return { ok: true, owner: target.instanceId, operation };
    }),
  };
});

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: () => undefined },
  dialog: { showOpenDialog: (...args: unknown[]) => fixture.localOpenDialog(...args) },
  ipcMain: {
    handle: (name: string, handler: (event: { sender: unknown }, request?: unknown) => unknown) => fixture.handlers.set(name, handler),
    removeHandler: (name: string) => fixture.handlers.delete(name),
  },
  shell: {
    openPath: vi.fn(async () => ""),
    showItemInFolder: (...args: unknown[]) => fixture.localRevealConfig(...args),
  },
}));
vi.mock("../settings/desktop-settings-singleton", () => ({
  getDesktopSettingsService: () => ({
    resolveResearchEnabled: () => true,
    resolveCodexToolDiscovery: () => true,
  }),
}));
vi.mock("../research/research-runtime", () => ({
  getResearchService: () => fixture.localResearch,
  getResearchHarnessService: () => fixture.localHarness,
  researchHarnessPlatformKeyStored: vi.fn(async () => false),
  researchHarnessStatus: (...args: unknown[]) => fixture.localHarnessStatus(...args),
  listResearchMathosSwarms: (...args: unknown[]) => fixture.localListMathosSwarms(...args),
  listResearchMathosTeams: (...args: unknown[]) => fixture.localListMathosTeams(...args),
}));
vi.mock("../app-server/backend-registry", () => ({
  getDesktopBackendRegistry: () => ({
    resolveThreadWorkspaceCwd: vi.fn(async () => process.cwd()),
    getCachedThreadSummary: vi.fn(() => undefined),
  }),
}));
vi.mock("../shell/research-window", () => ({
  researchWindowRunId: (id?: string) => id,
  showResearchWindow: (...args: unknown[]) => fixture.localOpenWindow(...args),
}));
vi.mock("../federation/federation-runtime", () => ({
  getDesktopFederationRuntime: () => ({
    requestResearchOperation: fixture.requestResearchOperation,
  }),
}));

import { disposeResearchIpcHandlers, registerResearchIpcHandlers } from "../shell/ipc/research-ipc";
import {
  FEDERATION_RESEARCH_CAPABILITIES,
  FEDERATION_RESEARCH_METHODS,
  registerFederationResearchHandlers,
  type ResearchOperations,
} from "../federation/federation-research";
import { FederationRouter } from "../federation/federation-router";
import { mainWindowEventChannels } from "../shell/main-window-channels";
import { WINDOW_KIND_MAIN, _resetWindowChannelsForTests, registerWindowChannels } from "../shell/window-channels";

type ActionSpec = {
  operation: string;
  channel: string;
  makeRequest: (backend: "codex" | "claude" | "acp:kimi", threadId: string) => Record<string, unknown>;
};

const ROUTED_RESEARCH_ACTIONS: readonly ActionSpec[] = [
  { operation: "snapshot", channel: RESEARCH_SNAPSHOT_CHANNEL, makeRequest: (backend, threadId) => ({ backend, threadId }) },
  { operation: "changes", channel: RESEARCH_CHANGES_CHANNEL, makeRequest: (backend, threadId) => ({ backend, threadId, runId: "run-1", sinceRevision: 0 }) },
  { operation: "events", channel: RESEARCH_EVENTS_CHANNEL, makeRequest: (backend, threadId) => ({ backend, threadId, runId: "run-1", range: { limit: 10 } }) },
  { operation: "search", channel: RESEARCH_SEARCH_CHANNEL, makeRequest: (backend, threadId) => ({ backend, threadId, runId: "run-1", query: { type: "finding" } }) },
  { operation: "readItem", channel: RESEARCH_ITEM_CHANNEL, makeRequest: (backend, threadId) => ({ backend, threadId, runId: "run-1", itemId: "f-1" }) },
  {
    operation: "work",
    channel: RESEARCH_WORK_CHANNEL,
    makeRequest: (backend, threadId) => ({
      backend, threadId, runId: "run-1", requestId: "req-work",
      command: { action: "work", itemId: "f-1", expectedVersion: 1, state: "claimed", reason: "Check result" },
    }),
  },
  {
    operation: "prepare",
    channel: RESEARCH_PREPARE_CHANNEL,
    makeRequest: (backend, threadId) => ({ backend, threadId, objective: "Test objective", workers: 2, workspaceMode: "none" }),
  },
  { operation: "withdraw", channel: RESEARCH_WITHDRAW_CHANNEL, makeRequest: (backend, threadId) => ({ backend, threadId }) },
  {
    operation: "update",
    channel: RESEARCH_UPDATE_CHANNEL,
    makeRequest: (backend, threadId) => ({
      backend, threadId, runId: "run-1", requestId: "req-stop",
      command: { action: "stop", reason: "Stopped by viewer" },
    }),
  },
  { operation: "harnessStatus", channel: RESEARCH_HARNESS_STATUS_CHANNEL, makeRequest: (backend, threadId) => ({ backend, threadId }) },
  { operation: "harnessCheck", channel: RESEARCH_HARNESS_CHECK_CHANNEL, makeRequest: (backend, threadId) => ({ backend, threadId }) },
  {
    operation: "harnessStart",
    channel: RESEARCH_HARNESS_START_CHANNEL,
    makeRequest: (backend, threadId) => ({
      backend, threadId, requestId: "req-harness", mode: "import", source: "swarm",
      project: "proj", session: "sess", swarm: "sw", objective: "Import swarm", budgetAcknowledged: false,
    }),
  },
  { operation: "harnessReconcile", channel: RESEARCH_HARNESS_RECONCILE_CHANNEL, makeRequest: (backend, threadId) => ({ backend, threadId, runId: "run-1" }) },
  { operation: "listMathosSwarms", channel: RESEARCH_MATHOS_SWARMS_CHANNEL, makeRequest: () => ({}) },
];

const LOCAL_ONLY_CHANNELS = [
  RESEARCH_OPEN_EVIDENCE_CHANNEL,
  RESEARCH_PROFILE_RUNS_CHANNEL,
  RESEARCH_OPEN_WINDOW_CHANNEL,
  RESEARCH_HARNESS_REVEAL_CONFIG_CHANNEL,
  RESEARCH_HARNESS_SETTINGS_CHECK_CHANNEL,
  RESEARCH_HARNESS_PICK_BRIDGE_CHANNEL,
  RESEARCH_MATHOS_TEAMS_CHANNEL,
] as const;

const localSender = { id: 1, isDestroyed: () => false, send: vi.fn() };
const ownerATarget: FederationRemoteTarget = { scope: "remote", instanceId: "owner-alpha" };
const ownerBTarget: FederationRemoteTarget = { scope: "remote", instanceId: "owner-beta" };
const remoteWindowSender = { id: 2, isDestroyed: () => false, send: vi.fn() };

function resetLogs(): void {
  fixture.localCalls.length = 0;
  fixture.remoteCalls.length = 0;
  fixture.remoteFailure = undefined;
  fixture.requestResearchOperation.mockClear();
  fixture.localOpenWindow.mockClear();
  fixture.localOpenDialog.mockClear();
  fixture.localRevealConfig.mockClear();
}

beforeEach(() => {
  _resetWindowChannelsForTests();
  registerWindowChannels({ webContents: localSender, on: () => {} } as unknown as BrowserWindow, WINDOW_KIND_MAIN, mainWindowEventChannels(undefined), undefined);
  registerWindowChannels({ webContents: remoteWindowSender, on: () => {} } as unknown as BrowserWindow, WINDOW_KIND_MAIN, mainWindowEventChannels(ownerATarget), ownerATarget);
  registerResearchIpcHandlers();
  resetLogs();
});

afterEach(() => {
  disposeResearchIpcHandlers();
  _resetWindowChannelsForTests();
});

describe("federated research IPC routing property", () => {
  const actionArb = fc.constantFrom(...ROUTED_RESEARCH_ACTIONS);
  const backendArb = fc.constantFrom("codex" as const, "claude" as const, "acp:kimi" as const);
  const threadIdArb = fc.constantFrom("colliding-thread", "thread-2");
  const stepArb = fc.record({
    action: actionArb,
    backend: backendArb,
    threadId: threadIdArb,
    surface: fc.constantFrom(
      "remote-window-implicit" as const,
      "remote-window-explicit" as const,
      "mounted-remote-thread" as const,
      "local-thread" as const,
    ),
  });

  it("routes every research action from a remote viewer to its owning instance and never locally", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(stepArb, { minLength: 1, maxLength: 20, size: "max" }), async (steps) => {
        resetLogs();
        for (const step of steps) {
          const handler = fixture.handlers.get(step.action.channel)!;
          const base = step.action.makeRequest(step.backend, step.threadId);
          const beforeLocal = fixture.localCalls.length;
          const beforeRemote = fixture.remoteCalls.length;

          if (step.surface === "remote-window-implicit") {
            const result = await handler({ sender: remoteWindowSender }, base);
            expect(result).toEqual({ ok: true, owner: ownerATarget.instanceId, operation: step.action.operation });
            expect(fixture.localCalls.length).toBe(beforeLocal);
            expect(fixture.remoteCalls.length).toBe(beforeRemote + 1);
            expect(fixture.remoteCalls.at(-1)).toEqual({
              target: ownerATarget,
              operation: step.action.operation,
              request: base,
            });
          } else if (step.surface === "remote-window-explicit") {
            const result = await handler({ sender: remoteWindowSender }, { ...base, federationTarget: ownerATarget });
            expect(result).toEqual({ ok: true, owner: ownerATarget.instanceId, operation: step.action.operation });
            expect(fixture.localCalls.length).toBe(beforeLocal);
            expect(fixture.remoteCalls.length).toBe(beforeRemote + 1);
            expect(fixture.remoteCalls.at(-1)).toEqual({
              target: ownerATarget,
              operation: step.action.operation,
              request: base,
            });
          } else if (step.surface === "mounted-remote-thread") {
            const result = await handler({ sender: localSender }, { ...base, federationTarget: ownerBTarget });
            expect(result).toEqual({ ok: true, owner: ownerBTarget.instanceId, operation: step.action.operation });
            expect(fixture.localCalls.length).toBe(beforeLocal);
            expect(fixture.remoteCalls.length).toBe(beforeRemote + 1);
            expect(fixture.remoteCalls.at(-1)).toEqual({
              target: ownerBTarget,
              operation: step.action.operation,
              request: base,
            });
          } else {
            await handler({ sender: localSender }, base);
            expect(fixture.remoteCalls.length).toBe(beforeRemote);
            expect(fixture.localCalls.length).toBeGreaterThan(beforeLocal);
          }
        }
      }),
      { numRuns: 40 },
    );
  });

  it("never falls back to local research when the remote owner fails or is mismatched", async () => {
    await fc.assert(
      fc.asyncProperty(actionArb, backendArb, threadIdArb, async (action, backend, threadId) => {
        resetLogs();
        const handler = fixture.handlers.get(action.channel)!;
        const base = action.makeRequest(backend, threadId);

        fixture.remoteFailure = new Error("Owner offline");
        await expect(Promise.resolve().then(() => handler({ sender: remoteWindowSender }, base))).rejects.toThrow("Owner offline");
        await expect(Promise.resolve().then(() => handler({ sender: localSender }, { ...base, federationTarget: ownerBTarget }))).rejects.toThrow("Owner offline");
        expect(fixture.localCalls).toEqual([]);

        fixture.remoteFailure = undefined;
        await expect(Promise.resolve().then(() => handler({ sender: remoteWindowSender }, { ...base, federationTarget: ownerBTarget }))).rejects.toThrow(/owner does not match/i);
        await expect(Promise.resolve().then(() => handler({ sender: remoteWindowSender }, { ...base, federationTarget: { scope: "local" } }))).rejects.toThrow(/owner does not match/i);
        expect(fixture.localCalls).toEqual([]);
      }),
      { numRuns: 25 },
    );
  });

  it.each(LOCAL_ONLY_CHANNELS)("refuses local-only channel %s from a remote viewer window without running locally or remotely", async (channel) => {
    const handler = fixture.handlers.get(channel)!;
    await expect(Promise.resolve().then(() => handler({ sender: remoteWindowSender }, {
      backend: "codex", threadId: "colliding-thread", runId: "run-1", itemId: "f-1", pathIndex: 0,
    }))).rejects.toThrow();
    expect(fixture.localCalls).toEqual([]);
    expect(fixture.remoteCalls).toEqual([]);
    expect(fixture.localOpenWindow).not.toHaveBeenCalled();
    expect(fixture.localOpenDialog).not.toHaveBeenCalled();
    expect(fixture.localRevealConfig).not.toHaveBeenCalled();
  });

  it("regression counterexample: remote viewer snapshot runs on the owning instance and never locally", async () => {
    const snapshot = fixture.handlers.get(RESEARCH_SNAPSHOT_CHANNEL)!;
    const result = await snapshot({ sender: remoteWindowSender }, { backend: "codex", threadId: "colliding-thread" });
    expect(result).toEqual({ ok: true, owner: ownerATarget.instanceId, operation: "snapshot" });
    expect(fixture.localCalls).toEqual([]);
    expect(fixture.remoteCalls).toEqual([{
      target: ownerATarget,
      operation: "snapshot",
      request: { backend: "codex", threadId: "colliding-thread" },
    }]);
  });

  it("regression counterexample: mounted remote thread action in local main window routes to owner instead of colliding local thread", async () => {
    const update = fixture.handlers.get(RESEARCH_UPDATE_CHANNEL)!;
    const request = {
      backend: "codex",
      threadId: "colliding-thread",
      runId: "run-1",
      requestId: "req-1",
      command: { action: "stop", reason: "Stop remote run" },
    };
    const result = await update({ sender: localSender }, { ...request, federationTarget: ownerBTarget });
    expect(result).toEqual({ ok: true, owner: ownerBTarget.instanceId, operation: "update" });
    expect(fixture.localCalls).toEqual([]);
    expect(fixture.remoteCalls).toEqual([{ target: ownerBTarget, operation: "update", request }]);
  });
});

describe("research federation protocol authorization and secret safety", () => {
  function ownerOperations(): ResearchOperations {
    return {
      snapshot: vi.fn(() => ({ runs: [], writableRunIds: [] })),
      changes: vi.fn(() => ({ runId: "run-1", revision: 1, state: {} as never, items: [], writable: true })),
      events: vi.fn(() => ({ runId: "run-1", revision: 1, events: [] })),
      search: vi.fn(() => ({ runId: "run-1", revision: 1, total: 0, items: [] })),
      readItem: vi.fn(() => ({ run: {} as never, item: {} as never })),
      work: vi.fn(async () => ({ run: {} as never, item: {} as never })),
      prepare: vi.fn(() => ({ intentId: "intent-1" })),
      withdraw: vi.fn(() => undefined),
      update: vi.fn(async () => ({ runId: "run-1", revision: 2, status: "stopped" as const })),
      harnessStatus: vi.fn(async () => ({
        configured: true,
        source: "mathos" as const,
        platformOrigin: "https://os.openmathmodel.org",
        platformTeam: "o-11111111-1111-1111-1111-111111111111",
        platformKeyStored: true,
        workspace: "/owner/workspace",
      })),
      harnessCheck: vi.fn(async () => ({
        ok: true as const,
        checkedAt: 1,
        capabilities: { import: true, execute: false, cancel: false, discovery: false, researchFunctions: false },
      })),
      harnessStart: vi.fn(async () => ({ runId: "run-2", revision: 1, status: "running" as const })),
      harnessReconcile: vi.fn(async () => ({ runId: "run-2", revision: 2, status: "running" as const })),
      listMathosSwarms: vi.fn(async () => ({ ok: true as const, swarms: [], sessions: 0, truncated: false })),
    };
  }

  it("enforces thread_detail for reads, turn_control for writes, blocks contained peers, and rejects recursive targets", async () => {
    const ops = ownerOperations();
    const router = new FederationRouter({
      localInstanceId: "owner",
      methodCapabilities: FEDERATION_RESEARCH_CAPABILITIES,
      peerRole: (peerId) => (peerId === "contained-peer" ? "contained" : "full"),
    });
    registerFederationResearchHandlers(router, ops);
    router.registerConnection({ peerId: "reader", capabilities: ["thread_detail"], sendEnvelope: () => {} });
    router.registerConnection({ peerId: "controller", capabilities: ["thread_detail", "turn_control"], sendEnvelope: () => {} });
    router.registerConnection({ peerId: "contained-peer", capabilities: ["thread_detail", "turn_control"], sendEnvelope: () => {} });

    const send = (peerId: string, method: string, params: unknown) => router.routeEnvelope({
      sourcePeerId: peerId,
      envelope: {
        id: "req",
        protocolVersion: 1,
        createdAt: Date.now(),
        kind: "request",
        sourceInstanceId: peerId,
        targetInstanceId: "owner",
        method,
        params,
      },
    });

    const readOps = ["snapshot", "changes", "events", "search", "readItem", "harnessStatus", "harnessCheck", "listMathosSwarms"] as const;
    const writeOps = ["work", "prepare", "withdraw", "update", "harnessStart", "harnessReconcile"] as const;

    for (const op of readOps) {
      const result = await send("reader", FEDERATION_RESEARCH_METHODS[op], { backend: "codex", threadId: "t1" });
      expect(result.status).toBe("handled");
      expect((await send("contained-peer", FEDERATION_RESEARCH_METHODS[op], { backend: "codex", threadId: "t1" })).status).toBe("rejected");
    }
    for (const op of writeOps) {
      expect((await send("reader", FEDERATION_RESEARCH_METHODS[op], { backend: "codex", threadId: "t1" })).status).toBe("rejected");
      expect(ops[op]).not.toHaveBeenCalled();
      expect((await send("contained-peer", FEDERATION_RESEARCH_METHODS[op], { backend: "codex", threadId: "t1" })).status).toBe("rejected");
      expect((await send("controller", FEDERATION_RESEARCH_METHODS[op], { backend: "codex", threadId: "t1" })).status).toBe("handled");
    }
    // Reject recursive forwarding on the owner.
    expect((await send("controller", FEDERATION_RESEARCH_METHODS.snapshot, {
      backend: "codex", threadId: "t1", federationTarget: ownerBTarget,
    })).status).toBe("rejected");
  });
});
