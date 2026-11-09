import { LocalOwnerNavigationTransport } from "../federation/local-owner-navigation-transport";
import fc from "fast-check";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import type { AgentEvent, FederationCapability } from "@pwragent/shared";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import { CodexAppServerClient } from "../codex-app-server/desktop-client";
import {
  FEDERATION_BACKEND_METHOD_CAPABILITIES,
  FederationRemoteBackendClient,
  registerFederationBackendHandlers,
} from "../federation/federation-backend-bridge";
import { FederationRouter } from "../federation/federation-router";
import { FederationRpcEndpoint } from "../federation/federation-rpc";
import {
  DesktopFederationRuntime,
  federationEventClassForMethod,
  navigationInvalidationForLocalEvent,
  projectLocalEventForFederation,
  unsequencedFederationEventPayload,
} from "../federation/federation-runtime";
import { resetDesktopOverlayStoreForTests, setDesktopOverlayStoreForTests } from "../storage/desktop-overlay-store";
import { DesktopConfigStore } from "../settings/config-store/desktop-config-store";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { AcpAgentStore } from "../storage/acp-agent-store";
import { AcpSessionStore } from "../storage/acp-session-store";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { ScheduledThreadActionService } from "../scheduled-actions/scheduled-thread-action-service";
import { ScheduledThreadActionStore } from "../storage/scheduled-thread-action-store";
import { admitSteerTurn } from "../scheduled-actions/steer-turn-admission";
import { OwnerConformanceCodexTransport } from "./fixtures/owner-conformance-codex-transport";
import {
  compareStep,
  describeBaselineChange,
  type OwnerConformanceBaseline,
  type OwnerHostName,
  type OwnerStepRecord,
} from "./helpers/owner-conformance";
import { OUTPOST_PACKAGE_ROOT, OUTPOST_VIEWER_CAPABILITIES, startOutpostDaemon } from "./helpers/outpost-daemon";
import { createTempStateDb } from "./sqlite-test-utils";

// Desktop serves peers from process singletons; point them at this owner.
const desktopOwner = vi.hoisted(() => ({ registry: undefined as unknown }));
vi.mock("../app-server/backend-registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../app-server/backend-registry")>()),
  getDesktopBackendRegistry: () => desktopOwner.registry,
}));
// Each test replaces the fixture owner. Its detail service must follow that owner,
// rather than retaining the first registry in the production process singleton.
vi.mock("../app-server/navigation-detail-service", async (importOriginal) => {
  const original = await importOriginal<typeof import("../app-server/navigation-detail-service")>();
  return { ...original, getDesktopNavigationDetailService: () =>
    new original.NavigationDetailService(desktopOwner.registry as DesktopBackendRegistry) };
});
vi.mock("../acp/acp-instance-discovery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../acp/acp-instance-discovery")>()),
  discoverLocalAcpAgentRecords: vi.fn(async () => []),
}));
vi.mock("../log", () => ({ getMainLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }));
vi.mock("../codex-app-server/stdio-transport", async () => ({
  StdioJsonRpcTransport: (await import("./fixtures/owner-conformance-codex-transport")).OwnerConformanceCodexTransport,
}));

const BASELINE_PATH = path.join(process.cwd(), "apps/desktop/src/main/__tests__/fixtures/owner-conformance-baseline.json");
/** The event classes the Outpost publishes. */
const EVENT_CLASSES = ["navigation", "transcript"];
const VIEWER_CAPABILITIES: FederationCapability[] = [...OUTPOST_VIEWER_CAPABILITIES, "event_subscriptions"];

/** One owner, reached the way a remote viewer reaches it. */
type OwnerHost = {
  name: OwnerHostName;
  client: FederationRemoteBackendClient;
  /** `backend.*` methods this owner answers. */
  methods: Set<string>;
  events: AgentEvent[];
  workspace: string;
  local?: LocalOwnerNavigationTransport;
  close(): Promise<void>;
};

/**
 * Desktop's real owner: the operations its federation runtime serves a peer,
 * over BackendRegistry, the real Codex client and a real state database,
 * registered with the real federation handlers behind a router that enforces
 * the shared capability table. Provider subprocesses use protocol fixtures.
 */
async function startDesktopOwner(
  threadTitleGenerationService: NonNullable<ConstructorParameters<typeof DesktopBackendRegistry>[0]>["threadTitleGenerationService"] = null,
  prepareAcp?: (db: StateDb, workspace: string) => Promise<void>,
): Promise<OwnerHost> {
  OwnerConformanceCodexTransport.reset();
  const workspace = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-conformance-")));
  const { dbPath, tempDir } = createTempStateDb("pwragent-conformance-db-");
  const db = StateDb.open(dbPath);
  const codexClient = new CodexAppServerClient({ directoryResolver: async () => [] });
  const overlayStore = new SqliteOverlayStore(db);
  await prepareAcp?.(db, workspace);
  setDesktopOverlayStoreForTests(overlayStore);
  // Desktop lists Codex once discovery has selected an executable. The
  // transport fixture stands in for that executable.
  const configPath = path.join(tempDir, "config.toml");
  await writeFile(configPath, "");
  const configStore = new DesktopConfigStore({ configPath });
  configStore.recordProviderDiscovery("codex", { candidates: [], selectedCommand: "/fixture/codex", selectedVersion: "0.159.2" });
  const registry = new DesktopBackendRegistry({ codexClient, configStore, overlayStore, messagingStore: null,
    ...(prepareAcp ? { acpAgentStore: new AcpAgentStore(db), acpSessionStore: new AcpSessionStore(db) } : {}),
    threadTitleGenerationService, pdfToolMcpServer: null, runtimeInstanceId: "conformance-desktop",
    resolveLiveProfileRuntimeInstanceIds: () => [], discoverLocalAcpAgents: async () => [] });
  desktopOwner.registry = registry;
  const scheduler = new ScheduledThreadActionService({ registry, store: new ScheduledThreadActionStore(db) });
  registry.setScheduledThreadActionCreator((request, options) => scheduler.create(request, options));
  scheduler.start();
  // A running desktop has reconciled its window's full navigation snapshot
  // before any viewer connects. Until then it puts no thread in Inbox.
  await overlayStore.reconcileNavigationSnapshot({ backend: "all", fetchedAt: Date.now(),
    threads: await registry.listThreads({ callerReason: "navigation-snapshot" }), workspaceRoots: [] });
  const events: AgentEvent[] = [];
  // What the federation runtime sends a viewer subscribed to every thread in
  // these classes; the rest of its fan-out is per-subscriber routing.
  const forward = (event: AgentEvent): void => {
    const invalidation = navigationInvalidationForLocalEvent(event);
    if (invalidation) forward(invalidation);
    if (EVENT_CLASSES.includes(federationEventClassForMethod(event.notification.method))) {
      events.push(unsequencedFederationEventPayload(projectLocalEventForFederation(event, "desktop-owner")));
    }
  };
  const stopEvents = registry.onEvent(forward);
  const router = new FederationRouter({ localInstanceId: "desktop-owner", methodCapabilities: FEDERATION_BACKEND_METHOD_CAPABILITIES });
  const methods = new Set<string>();
  const registerHandler = router.registerHandler.bind(router);
  router.registerHandler = (method, handler) => {
    if (method.startsWith("backend.")) methods.add(method);
    registerHandler(method, handler);
  };
  let rpc: FederationRpcEndpoint;
  router.registerConnection({ peerId: "viewer", capabilities: VIEWER_CAPABILITIES,
    sendEnvelope: (envelope) => { rpc.receiveEnvelope(envelope); } });
  const backend = new DesktopFederationRuntime().localBackend();
  // Bind the production admission path to this owner's real scheduler/store;
  // the app's process singleton belongs to an initialized desktop profile.
  backend.steerTurn = (request) => admitSteerTurn(registry, scheduler, request);
  registerFederationBackendHandlers({ router, backend });
  rpc = new FederationRpcEndpoint({ localInstanceId: "viewer", remoteInstanceId: "desktop-owner", defaultTimeoutMs: 5000,
    sendEnvelope: (envelope) => { void router.routeEnvelope({ envelope, sourcePeerId: "viewer" }); } });
  return {
    name: "desktop", client: new FederationRemoteBackendClient(rpc), methods, events, workspace,
    local: new LocalOwnerNavigationTransport(backend),
    close: async () => {
      stopEvents();
      scheduler.dispose();
      await registry.close();
      await codexClient.close();
      desktopOwner.registry = undefined;
      resetDesktopOverlayStoreForTests();
      configStore.dispose();
      db.close();
      await rm(workspace, { recursive: true, force: true });
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

/** The Outpost daemon on its Codex fixture, enrolled through a real invite. */
async function startOutpostOwner(): Promise<OwnerHost> {
  const outpost = await startOutpostDaemon({ capabilities: VIEWER_CAPABILITIES });
  outpost.subscribe(EVENT_CLASSES);
  const backend = await import(pathToFileURL(path.join(OUTPOST_PACKAGE_ROOT, "src/federation-backend.js")).href) as {
    METHOD_CAPABILITIES: Record<string, FederationCapability>;
  };
  return { name: "outpost", client: outpost.client, methods: new Set(Object.keys(backend.METHOD_CAPABILITIES)),
    events: outpost.events, workspace: outpost.workspace, close: outpost.close };
}

/**
 * Waits until the owner has sent nothing for a while, so each event is
 * counted against the step that caused it. The window allows for an Outpost
 * event crossing its socket late on a loaded runner.
 */
async function settle(host: OwnerHost): Promise<void> {
  let seen = -1;
  for (let attempt = 0; attempt < 25 && seen !== host.events.length; attempt++) {
    seen = host.events.length;
    await delay(400);
  }
}

type Step = {
  name: string;
  method: string;
  run(host: OwnerHost, context: Record<string, string>): Promise<unknown>;
  values?(response: any): Record<string, unknown>;
};

const FIRST_PROMPT = "Could you fix the flaky login test";
const inbox = (host: OwnerHost) => host.client.getNavigationQueryPage({ protocol: 2, consumer: "remote-window",
  query: { kind: "lens", lens: "inbox" } });
const ref = (context: Record<string, string>) => ({ backend: "codex" as const, threadId: context.threadId! });
const rowValues = (page: any) => {
  const row = page.entries?.[0]?.row;
  return { rows: page.entries?.length, title: row?.title, titleSource: row?.titleSource, inInbox: row?.inbox?.inInbox };
};

/**
 * A thread's life through the owner methods both hosts implement: created,
 * named by its first prompt, listed, read, renamed and marked seen.
 */
const FIRST_PROMPT_SCENARIO: Step[] = [
  { name: "list providers", method: "backend.listBackends", run: (host) => host.client.listBackends({}),
    values: (response) => ({ backends: response.backends?.map((backend: any) => backend.kind) }) },
  { name: "start a thread", method: "backend.startThread",
    run: async (host, context) => {
      const started = await host.client.startThread({ backend: "codex", cwd: host.workspace, executionMode: "auto" });
      context.threadId = started.threadId;
      return started;
    } },
  // A viewer's sidebar is open before the first turn; the owner sees that read.
  { name: "list it before its first turn", method: "backend.getNavigationQueryPage", run: (host) => inbox(host), values: rowValues },
  { name: "start its first turn", method: "backend.startTurn",
    run: async (host, context) => {
      const turn = await host.client.startTurn({ ...ref(context), input: [{ type: "text", text: FIRST_PROMPT }] });
      // Both fixtures complete a turn with one agent message.
      for (let attempt = 0; attempt < 100; attempt++) {
        if ((await host.client.readThread(ref(context))).replay.lastAssistantMessage === "Fixture result") return turn;
        await delay(50);
      }
      throw new Error("The first turn did not complete.");
    } },
  { name: "list it in Inbox", method: "backend.getNavigationQueryPage", run: (host) => inbox(host), values: rowValues },
  { name: "rank it in Attention", method: "backend.getNavigationQueryPage",
    run: (host) => host.client.getNavigationQueryPage({ protocol: 2, consumer: "remote-window",
      query: { kind: "lens", lens: "attention" }, attentionView: { id: "conformance", promoteOnTurnEnd: true } }),
    values: (page) => ({ rows: page.entries?.length, ranked: page.entries?.map((entry: any) => typeof entry.attentionRank) }) },
  { name: "read its selected detail", method: "backend.getNavigationSelectedDetail",
    run: (host, context) => host.client.getNavigationSelectedDetail({ protocol: 2, ref: ref(context) }),
    values: (response) => ({ title: response.thread?.title, executionMode: response.thread?.executionMode }) },
  { name: "read its transcript", method: "backend.readThread",
    run: (host, context) => host.client.readThread(ref(context)),
    values: (response) => ({ lastAssistantMessage: response.replay?.lastAssistantMessage }) },
  { name: "rename it", method: "backend.renameThread",
    run: (host, context) => host.client.renameThread({ ...ref(context), name: "Release checklist" }) },
  { name: "mark it seen", method: "backend.markThreadSeen",
    run: (host, context) => host.client.markThreadSeen(ref(context)) },
  { name: "list it renamed", method: "backend.getNavigationQueryPage", run: (host) => inbox(host), values: rowValues },
];

async function runScenario(host: OwnerHost, steps: Step[]): Promise<OwnerStepRecord[]> {
  const context: Record<string, string> = {};
  const records: OwnerStepRecord[] = [];
  for (const step of steps) {
    const before = host.events.length;
    let response: unknown;
    try {
      response = await step.run(host, context);
    } catch (error) {
      // A failed step is a broken owner or harness, never a difference to record.
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${host.name} failed ${step.method} [${step.name}]: ${message}`, { cause: error });
    }
    await settle(host);
    records.push({ step: step.name, method: step.method, response,
      values: step.values ? step.values(response) : {}, events: host.events.slice(before) });
  }
  return records;
}

describe.skipIf(process.platform === "win32")("owner conformance: desktop and the Outpost", () => {
  it("serves native and remote navigation from the real desktop owner with the same bounded results", async () => {
    const desktop = await startDesktopOwner();
    try {
      const thread = await desktop.client.startThread({ backend: "codex", cwd: desktop.workspace });
      const ref = { backend: "codex" as const, threadId: thread.threadId };
      const query = { protocol: 2 as const, consumer: "main-sidebar" as const, inventory: "owner" as const,
        query: { kind: "lens" as const, lens: "inbox" as const } };
      const page = await desktop.client.getNavigationQueryPage(query);
      const native = await desktop.local!.request({ method: "backend.getNavigationQueryPage", params: query }, "sidebar");
      // Cursors are scoped to the caller. Compare the owner data, never another caller's cursor.
      expect(native).toMatchObject({ entries: page.entries, counts: page.counts });
      const detail = { protocol: 2 as const, ref };
      expect(await desktop.local!.request({ method: "backend.getNavigationSelectedDetail", params: detail }, "detail"))
        .toEqual(await desktop.client.getNavigationSelectedDetail(detail));
      expect(await desktop.local!.request({ method: "backend.getNavigationQueueProjection", params: detail }, "queue"))
        .toEqual(await desktop.client.getNavigationQueueProjection(detail));
      const launchpad = { protocol: 2 as const };
      expect(await desktop.local!.request({ method: "backend.getNavigationLaunchpadConfig", params: launchpad }, "launchpad"))
        .toEqual(await desktop.client.getNavigationLaunchpadConfig(launchpad));
    } finally { await desktop.close(); }
  });

  it("coordinates helper results and explicit renames through the real desktop owner", async () => {
    let started!: () => void;
    let release!: () => void;
    let blocked = Promise.resolve();
    let helperTitle = "";
    const generateTitle = vi.fn(async () => {
      started();
      await blocked;
      return { status: "generated" as const, title: helperTitle };
    });
    const desktop = await startDesktopOwner({ generateTitle });
    const registry = desktopOwner.registry as DesktopBackendRegistry;
    const operators = fc.sample(fc.boolean(), 6);
    // Include each side of the precedence rule whatever the generated sample.
    operators.push(false, true);
    try {
      for (const [i, operator] of operators.entries()) {
        const ready = new Promise<void>((resolve) => { started = resolve; });
        blocked = new Promise<void>((resolve) => { release = resolve; });
        helperTitle = `Helper fixture ${i}`;
        const ref = { backend: "codex" as const, threadId: (await desktop.client.startThread({
          backend: "codex", cwd: desktop.workspace, executionMode: "auto",
        })).threadId };
        await desktop.client.startTurn({ ...ref, input: [{ type: "text", text: "Prompt fixture" }] });
        await ready;
        if (operator) await desktop.client.renameThread({ ...ref, name: "Prompt fixture" });
        release();
        await registry.whenThreadTitleGenerationSettledForTests();
        const detail = await desktop.client.getNavigationSelectedDetail({ protocol: 2, ref });
        const expectedTitle = operator ? "Prompt fixture" : helperTitle;
        const expectedSource = operator ? "explicit" : "derived";
        expect(detail.thread).toMatchObject({ title: expectedTitle, titleSource: expectedSource });
        const names = desktop.events.flatMap((event) => event.notification.method === "thread/name/updated"
          && event.notification.params.threadId === ref.threadId
          ? [{ name: event.notification.params.threadName, source: event.notification.params.titleSource }] : []);
        expect(names).toEqual([
          { name: "Prompt fixture", source: "derived" },
          { name: expectedTitle, source: expectedSource },
        ]);
      }
      expect(generateTitle).toHaveBeenCalledTimes(operators.length);
      await settle(desktop);
    } finally {
      release?.();
      await desktop.close();
    }
  });

  it("keeps generated steering responses equal and retains desktop acceptance through host effect failures", async () => {
    const desktop = await startDesktopOwner();
    let outpost: OwnerHost | undefined;
    try {
      outpost = await startOutpostOwner();
      const hosts = [desktop, outpost];
      const turns = await Promise.all(hosts.map(async (host) => {
        const { threadId } = await host.client.startThread({ backend: "codex", cwd: host.workspace, executionMode: "auto" });
        return await host.client.startTurn({ backend: "codex", threadId, input: [{ type: "text", text: "slow" }] });
      }));
      const retain = vi.spyOn(desktopOwner.registry as unknown as {
        rememberTurnInputAttachments: () => Promise<void>;
      }, "rememberTurnInputAttachments");
      const commands = fc.sample(fc.record({ copies: fc.integer({ min: 2, max: 6 }), text: fc.string({ maxLength: 30 }),
        failures: fc.integer({ min: 1, max: 3 }) }), 8);
      for (const [i, command] of commands.entries()) {
        const requests = turns.map((turn) => ({ backend: "codex" as const, threadId: turn.threadId,
          expectedTurnId: turn.turnId, requestId: `steer-${i}`, input: [{ type: "text" as const, text: `Steer ${command.text}` }] }));
        const before = OwnerConformanceCodexTransport.requests.filter((item) => item.method === "turn/steer").length;
        for (let failure = 0; failure < command.failures; failure += 1) {
          retain.mockRejectedValueOnce(new Error("Fixture attachment retention failed"));
          const attempts = await Promise.allSettled(Array.from({ length: command.copies }, () => desktop.client.steerTurn(requests[0])));
          expect(attempts.map((attempt) => attempt.status)).toEqual(Array(command.copies).fill("rejected"));
          expect(OwnerConformanceCodexTransport.requests.filter((item) => item.method === "turn/steer")).toHaveLength(before + 1);
        }
        const [desktopResults, outpostResult] = await Promise.all([
          Promise.all(Array.from({ length: command.copies }, () => desktop.client.steerTurn(requests[0]))),
          outpost.client.steerTurn(requests[1]),
        ]);
        for (const [index, results] of [[0, desktopResults], [1, [outpostResult]]] as const) {
          for (const result of results) expect(result).toEqual({ backend: "codex", threadId: turns[index].threadId,
            turnId: turns[index].turnId, disposition: "steered" });
        }
        await expect(desktop.client.steerTurn({ ...requests[0], input: [{ type: "text", text: "Changed input" }] }))
          .rejects.toThrow("reused with different input");
        expect(OwnerConformanceCodexTransport.requests.filter((item) => item.method === "turn/steer")).toHaveLength(before + 1);
      }
      await Promise.all(hosts.map((host, index) => host.client.interruptTurn(turns[index])));
      await Promise.all(hosts.map(settle));
    } finally {
      await outpost?.close();
      await desktop.close();
    }
  }, 120_000);

  it("retires rejected desktop preparations before subsequent starts agree with the real Outpost", async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const desktop = await startDesktopOwner();
    let outpost: OwnerHost | undefined;
    try {
      outpost = await startOutpostOwner();
      const hosts = [desktop, outpost];
      const identities = await Promise.all(hosts.map((host) => host.client.startThread({
        backend: "codex", cwd: host.workspace, executionMode: "auto",
      })));
      await Promise.all(hosts.map(settle));
      const register = vi.spyOn(desktopOwner.registry as unknown as {
        registerPendingThreadMessageContext: () => Promise<string | undefined>;
      }, "registerPendingThreadMessageContext");
      for (const failures of fc.sample(fc.integer({ min: 1, max: 3 }), 5)) {
        const before = OwnerConformanceCodexTransport.requests.filter((request) => request.method === "turn/start").length;
        for (let i = 0; i < failures; i += 1) {
          const offset = desktop.events.length;
          register.mockRejectedValueOnce(new Error("Fixture context preparation rejected"));
          const { writes } = await measureSqliteWrites(async () => {
            await expect(desktop.client.startTurn({ backend: "codex", threadId: identities[0].threadId,
              input: [{ type: "text", text: "slow" }] })).rejects.toThrow("Fixture context preparation rejected");
          });
          // Thread creation and its asynchronous metadata effects are setup.
          // Rejected preparation and reservation retirement write no SQLite.
          expect(writes, JSON.stringify(writes)).toMatchObject({ commits: 0, statements: 0, rowsChanged: 0 });
          expect(OwnerConformanceCodexTransport.requests.filter((request) => request.method === "turn/start")).toHaveLength(before);
          const pendingTurnId = `pending:${identities[0].threadId}`;
          const lifecycle = desktop.events.slice(offset).filter((event) => {
            const notification = event.notification;
            return (notification.method === "turn/started" || notification.method === "turn/failed")
              && notification.params.threadId === identities[0].threadId
              && notification.params.turnId === pendingTurnId;
          });
          expect(lifecycle.map((event) => event.notification.method)).toEqual([]);
        }
        const turns = await Promise.all(hosts.map((host, index) => host.client.startTurn({
          backend: "codex", threadId: identities[index].threadId, input: [{ type: "text", text: "slow" }],
        })));
        expect(OwnerConformanceCodexTransport.requests.filter((request) => request.method === "turn/start")).toHaveLength(before + 1);
        for (const [index, turn] of turns.entries()) expect(turn).toMatchObject({
          backend: "codex", threadId: identities[index].threadId, turnId: turns[0].turnId,
        });
        await Promise.all(hosts.map((host, index) => host.client.interruptTurn(turns[index])));
        await Promise.all(hosts.map(settle));
      }
    } finally {
      await outpost?.close();
      await desktop.close();
      vi.unstubAllEnvs();
    }
  }, 120_000);

  it("returns matching accepted turns through desktop finalization failures without resubmitting", async () => {
    const desktop = await startDesktopOwner();
    let outpost: OwnerHost | undefined;
    try {
      outpost = await startOutpostOwner();
      const hosts = [desktop, outpost];
      const identities = await Promise.all(hosts.map((host) => host.client.startThread({
        backend: "codex", cwd: host.workspace, executionMode: "auto",
      })));
      await Promise.all(hosts.map(settle));
      const registry = desktopOwner.registry as DesktopBackendRegistry;
      const internal = registry as unknown as {
        persistStartingTurnOrigin: () => Promise<void>;
        rememberTurnInputAttachments: () => Promise<void>;
        reservedCodexStartThreadIds: Set<string>;
        startingTurnOrigins: Set<unknown>;
      };
      const origin = vi.spyOn(internal, "persistStartingTurnOrigin");
      const retention = vi.spyOn(internal, "rememberTurnInputAttachments");
      const commands = ["origin", "attachments", ...fc.sample(fc.constantFrom("origin", "attachments"), 4)];
      for (const command of commands) {
        const before = OwnerConformanceCodexTransport.requests.filter((request) => request.method === "turn/start").length;
        (command === "origin" ? origin : retention).mockRejectedValueOnce(new Error(`Fixture ${command} finalization failed`));
        const turns = await Promise.all(hosts.map((host, index) => host.client.startTurn({
          backend: "codex", threadId: identities[index].threadId, input: [{ type: "text", text: "slow" }],
          messageOrigin: { kind: "messaging" },
        })));
        for (const [index, turn] of turns.entries()) expect(turn).toMatchObject({
          backend: "codex", threadId: identities[index].threadId, turnId: turns[0].turnId,
        });
        expect(OwnerConformanceCodexTransport.requests.filter((request) => request.method === "turn/start")).toHaveLength(before + 1);
        expect(internal.reservedCodexStartThreadIds.has(identities[0].threadId)).toBe(false);
        expect(internal.startingTurnOrigins.size).toBe(0);
        expect(desktop.events.filter((event) => event.notification.method === "turn/failed")).toEqual([]);
        const interruptions = await Promise.all(hosts.map((host, index) => host.client.interruptTurn(turns[index])));
        for (const [index, interruption] of interruptions.entries()) expect(interruption).toMatchObject({
          threadId: turns[index].threadId, turnId: turns[index].turnId,
        });
        await Promise.all(hosts.map(settle));
      }
    } finally {
      await outpost?.close();
      await desktop.close();
    }
  }, 120_000);

  it("returns real ACP provider acceptance through refused SQLite review-context consumption", async () => {
    const backend = "acp:gemini" as const;
    const threadId = "accepted-acp";
    let db!: StateDb;
    const desktop = await startDesktopOwner(null, async (stateDb, workspace) => {
      db = stateDb;
      // Record protocol requests in this test's workspace, never provider storage.
      const script = `
        const fs = require("node:fs");
        const rl = require("node:readline").createInterface({ input: process.stdin });
        const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
        rl.on("line", (line) => {
          const message = JSON.parse(line);
          fs.appendFileSync(${JSON.stringify(path.join(workspace, "acp-requests.jsonl"))}, line + "\\n");
          let result = {};
          if (message.method === "initialize") result = { protocolVersion: 1 };
          if (message.method === "session/prompt") {
            send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: message.params.sessionId,
              update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Accepted ACP fixture." } } } });
          }
          send({ jsonrpc: "2.0", id: message.id, result });
        });`;
      new AcpAgentStore(db).upsertInstalledAgent({ backendId: backend, registryId: "gemini", name: "ACP fixture",
        distributionKind: "local", distributionSource: "fixture", installStatus: "installed", authStatus: "not-required",
        verificationStatus: "not-applicable", allowlistRuleId: "fixture", installedAt: 1000, updatedAt: 1000,
        launchDescriptor: { backendId: backend, registryId: "gemini", distributionKind: "local",
          command: process.execPath, args: ["-e", script], env: {} },
      });
      new AcpSessionStore(db).upsertSession({ backendId: backend, sessionId: threadId, title: "ACP fixture",
        cwd: workspace, createdAt: 1000, updatedAt: 1000, executionMode: "default", status: "idle" });
    });
    try {
      const registry = desktopOwner.registry as DesktopBackendRegistry;
      const internal = registry as unknown as { reservedAcpStartThreadKeys: Set<string>; startingTurnOrigins: Set<unknown> };
      const overlay = new SqliteOverlayStore(db);
      const failures = [true, false, ...fc.sample(fc.boolean(), 3)];
      for (const [index, fails] of failures.entries()) {
        const entryId = `review-${index}`;
        await overlay.upsertManagedReviewEntry({ backend, threadId, pendingContext: true,
          entry: { type: "review", id: entryId, review: `Fixture review ${index}`, createdAt: 1000 + index } });
        if (fails) db.raw.exec(`CREATE TRIGGER reject_acp_review BEFORE UPDATE OF payload ON threads
          WHEN json_extract(OLD.payload, '$.threadId') = 'accepted-acp'
            AND json_array_length(json_extract(OLD.payload, '$.pendingManagedReviewContextEntryIds')) > 0
            AND json_extract(NEW.payload, '$.pendingManagedReviewContextEntryIds') IS NULL
          BEGIN SELECT RAISE(ABORT, 'Fixture accepted ACP review refused'); END`);
        try {
          const turn = await desktop.client.startTurn({ backend, threadId,
            input: [{ type: "text", text: `Continue ${index}` }], messageOrigin: { kind: "messaging" } });
          expect(turn).toMatchObject({ backend, threadId, turnId: expect.any(String) });
          expect(internal.reservedAcpStartThreadKeys.size).toBe(0);
          expect(internal.startingTurnOrigins.size).toBe(0);
          await settle(desktop);
          const requests = readFileSync(path.join(desktop.workspace, "acp-requests.jsonl"), "utf8")
            .trim().split("\n").map((line) => JSON.parse(line));
          const prompts = requests.filter((request) => request.method === "session/prompt");
          expect(prompts).toHaveLength(index + 1);
          expect(JSON.stringify(prompts.at(-1).params)).toContain(`Fixture review ${index}`);
          expect(JSON.stringify(prompts.at(-1).params)).toContain(`Continue ${index}`);
          expect(desktop.events.filter((event) => event.notification.method === "turn/failed")).toEqual([]);
          expect(desktop.events.filter((event) => event.notification.method === "turn/completed"
            && event.notification.params.turnId === turn.turnId)).toHaveLength(1);
          const state = await overlay.getThreadOverlayState({ backend, threadId });
          expect(state?.pendingManagedReviewContextEntryIds?.includes(entryId) ?? false).toBe(fails);
        } finally {
          if (fails) db.raw.exec("DROP TRIGGER reject_acp_review");
        }
      }
    } finally {
      await desktop.close();
    }
  });

  it("retires protocol-refused desktop submissions through notification rejection before matching Outpost", async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const desktop = await startDesktopOwner();
    let outpost: OwnerHost | undefined;
    try {
      outpost = await startOutpostOwner();
      const hosts = [desktop, outpost];
      const identities = await Promise.all(hosts.map((host) => host.client.startThread({
        backend: "codex", cwd: host.workspace, executionMode: "auto",
      })));
      await Promise.all(hosts.map(settle));
      const registry = desktopOwner.registry as DesktopBackendRegistry;
      const internal = registry as unknown as { emit: (event: AgentEvent, sequence?: number) => Promise<void> };
      const emit = internal.emit.bind(registry);
      let rejectTerminal = false;
      vi.spyOn(internal, "emit").mockImplementation(async (event, sequence) => {
        if (rejectTerminal && event.notification.method === "turn/failed") {
          rejectTerminal = false;
          throw new Error("Fixture terminal delivery rejected");
        }
        return await emit(event, sequence);
      });
      const commands = [{ failures: 1, reject: true }, ...fc.sample(fc.record({
        failures: fc.integer({ min: 1, max: 3 }), reject: fc.boolean(),
      }), 4)];
      for (const command of commands) {
        const before = OwnerConformanceCodexTransport.requests.filter((request) => request.method === "turn/start").length;
        OwnerConformanceCodexTransport.refusedStarts = command.failures;
        for (let i = 0; i < command.failures; i += 1) {
          rejectTerminal = command.reject;
          const { writes } = await measureSqliteWrites(async () => {
            await expect(desktop.client.startTurn({ backend: "codex", threadId: identities[0].threadId,
              input: [{ type: "text", text: "slow" }] })).rejects.toThrow(command.reject
                ? "Fixture terminal delivery rejected" : "Fixture provider refused submission");
          });
          // A rejected notification reaches no existing terminal persistence.
          // Ownership cleanup adds no compensating database write.
          if (command.reject) expect(writes, JSON.stringify(writes)).toMatchObject({ commits: 0, statements: 0, rowsChanged: 0 });
          expect(OwnerConformanceCodexTransport.requests.filter((request) => request.method === "turn/start")).toHaveLength(before + i + 1);
        }
        const turns = await Promise.all(hosts.map((host, index) => host.client.startTurn({
          backend: "codex", threadId: identities[index].threadId, input: [{ type: "text", text: "slow" }],
        })));
        expect(OwnerConformanceCodexTransport.requests.filter((request) => request.method === "turn/start"), JSON.stringify(turns)).toHaveLength(before + command.failures + 1);
        for (const [index, turn] of turns.entries()) expect(turn).toMatchObject({
          backend: "codex", threadId: identities[index].threadId, turnId: turns[0].turnId,
        });
        await Promise.all(hosts.map((host, index) => host.client.interruptTurn(turns[index])));
        await Promise.all(hosts.map(settle));
      }
    } finally {
      await outpost?.close();
      await desktop.close();
      vi.unstubAllEnvs();
    }
  }, 120_000);

  it("interrupts generated live turns through both real owners and preserves provider terminal order", async () => {
    const desktop = await startDesktopOwner();
    let outpost: OwnerHost | undefined;
    try {
      outpost = await startOutpostOwner();
      const hosts = [desktop, outpost];
      const identities = await Promise.all(hosts.map((host) => host.client.startThread({
        backend: "codex", cwd: host.workspace, executionMode: "auto",
      })));
      for (const turnsToRun of fc.sample(fc.integer({ min: 1, max: 3 }), 3)) {
        for (let i = 0; i < turnsToRun; i += 1) {
          const offsets = hosts.map((host) => host.events.length);
          const turns = await Promise.all(hosts.map((host, index) => host.client.startTurn({
            backend: "codex", threadId: identities[index].threadId, input: [{ type: "text", text: "slow" }],
          })));
          const replies = await Promise.all(hosts.map((host, index) => host.client.interruptTurn(turns[index])));
          await Promise.all(hosts.map(settle));
          for (const [index, host] of hosts.entries()) {
            expect(replies[index]).toEqual({ backend: "codex", threadId: turns[index].threadId, turnId: turns[index].turnId });
            const lifecycle = host.events.slice(offsets[index]).flatMap((event) => {
              const notification = event.notification;
              if (notification.method !== "turn/started" && notification.method !== "turn/completed") return [];
              const turn = notification.params.turn as { id?: string; status?: string } | undefined;
              if (notification.params.threadId !== turns[index].threadId
                || (notification.params.turnId ?? turn?.id) !== turns[index].turnId) return [];
              return [{ method: notification.method, status: turn?.status }];
            });
            // The unchanged conformance baseline already records Outpost's
            // missing start event. Both owners must deliver exactly one terminal.
            expect(lifecycle.map((notification) => notification.method)).toEqual(host.name === "desktop"
              ? ["turn/started", "turn/completed"] : ["turn/completed"]);
            expect(lifecycle.at(-1)?.status).toBe("interrupted");
          }
          const delivered = OwnerConformanceCodexTransport.requests.filter((item) => item.method === "turn/interrupt");
          expect(delivered.at(-1)?.params).toMatchObject({ threadId: turns[0].threadId, turnId: turns[0].turnId });
        }
      }
    } finally {
      await outpost?.close();
      await desktop.close();
    }
  }, 120_000);

  it("keeps generated explicit rename sequences and events equal on both real owners", async () => {
    const desktop = await startDesktopOwner();
    let outpost: OwnerHost | undefined;
    try {
      outpost = await startOutpostOwner();
      const hosts = [desktop, outpost];
      const refs = await Promise.all(hosts.map(async (host) => ({ backend: "codex" as const,
        threadId: (await host.client.startThread({ backend: "codex", cwd: host.workspace, executionMode: "auto" })).threadId,
      })));
      await Promise.all(hosts.map(settle));
      hosts.forEach((host) => { host.events.length = 0; });
      const titles = fc.sample(fc.integer({ min: 0, max: 1_000_000 }), 25).map((value, index) => `Fixture ${index} ${value}`);
      for (const title of titles) {
        await Promise.all(hosts.map((host, index) => host.client.renameThread({ ...refs[index], name: title })));
        for (const [index, host] of hosts.entries()) {
          const detail = await host.client.getNavigationSelectedDetail({ protocol: 2, ref: refs[index] });
          expect(detail.thread?.title, host.name).toBe(title);
          expect(detail.thread?.titleSource, host.name).toBe("explicit");
        }
      }
      await Promise.all(hosts.map(settle));
      for (const [index, host] of hosts.entries()) {
        const names = host.events.flatMap((event) => {
          if (event.notification.method !== "thread/name/updated"
            || event.notification.params.threadId !== refs[index].threadId) return [];
          return [{ name: event.notification.params.threadName, source: event.notification.params.titleSource }];
        });
        expect(names, host.name).toEqual(titles.map((name) => ({ name, source: "explicit" })));
      }
    } finally {
      await outpost?.close();
      await desktop.close();
    }
  }, 120_000);

  it("answer a thread's life the same way, or the baseline records the difference", async () => {
    const desktop = await startDesktopOwner();
    let outpost: OwnerHost | undefined;
    try {
      outpost = await startOutpostOwner();
      const used = [...new Set(FIRST_PROMPT_SCENARIO.map((step) => step.method))];
      for (const host of [desktop, outpost]) {
        const missing = used.filter((method) => !host.methods.has(method));
        expect(missing, `${host.name} does not implement methods the scenario uses`).toEqual([]);
      }
      // The Outpost implements a subset of desktop's owner methods, never one desktop lacks.
      expect([...outpost.methods].filter((method) => !desktop.methods.has(method)), "outpost-only owner methods").toEqual([]);
      const desktopRecords = await runScenario(desktop, FIRST_PROMPT_SCENARIO);
      const outpostRecords = await runScenario(outpost, FIRST_PROMPT_SCENARIO);
      const measured: OwnerConformanceBaseline = {
        sharedMethods: [...outpost.methods].filter((method) => desktop.methods.has(method)).sort(),
        differences: desktopRecords.flatMap((record, index) => compareStep(record, outpostRecords[index]!)),
      };
      if (process.env.UPDATE_OWNER_CONFORMANCE === "1") {
        writeFileSync(BASELINE_PATH, JSON.stringify(measured, null, 2) + "\n");
        return;
      }
      const baseline: OwnerConformanceBaseline = existsSync(BASELINE_PATH)
        ? JSON.parse(readFileSync(BASELINE_PATH, "utf8"))
        : { sharedMethods: [], differences: [] };
      const change = describeBaselineChange(baseline, measured);
      if (change) throw new Error(change);
    } finally {
      await outpost?.close();
      await desktop.close();
    }
  }, 120_000);
});
