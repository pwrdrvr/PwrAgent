import { createDesktopBackendRegistry } from "../app-server/backend-registry-wiring";
import { buildOwnerFixture } from "./helpers/built-owner-fixture";
import { LocalOwnerNavigationTransport } from "../federation/local-owner-navigation-transport";
import fc from "fast-check";
import { ThreadTitleGenerationService } from "@pwragent/owner-core/thread-title-generation-service";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentEvent, AppServerBackendKind, FederationCapability } from "@pwragent/shared";
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
import { ProviderThreadSnapshotStore } from "../storage/provider-thread-snapshot-store";
import { RetainedOwnerThreadStore } from "../storage/retained-owner-thread-store";
import { ClaudeSessionStore } from "../claude/claude-session-store";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { ScheduledThreadActionService } from "../scheduled-actions/scheduled-thread-action-service";
import { ScheduledThreadActionStore } from "../storage/scheduled-thread-action-store";
import { admitSteerTurn } from "../scheduled-actions/steer-turn-admission";
import { OwnerConformanceCodexTransport } from "./fixtures/owner-conformance-codex-transport";
import {
  compareStep,
  type OwnerConformanceBaseline,
  type OwnerHostName,
  type OwnerStepRecord,
} from "./helpers/owner-conformance";
import { OUTPOST_VIEWER_CAPABILITIES, startOutpostDaemon } from "./helpers/outpost-daemon";
import { createTempStateDb } from "./sqlite-test-utils";
import { createFederatedThreadMessageHandler } from "../federation/federated-thread-message-service";
import { canonicalDurableSteerRequest, canonicalDurableTurnRequest, type SubmitDurableSteerRequest, type SubmitDurableTurnRequest } from "@pwragent/shared";
import { DurableTurnRequestService } from "@pwragent/owner-core/durable-turn-request-service";
import { SqliteDurableTurnRequestStore } from "../storage/durable-turn-request-store";
import { authenticateMessageOrigin } from "@pwragent/federation/federation-message-origin";
import { parseThreadCorrespondenceMessage, threadLockRefusalMessage } from "@pwragent/shared";
import type { ThreadTurnQueue } from "@pwragent/owner-core/thread-turn-queue";
import { publishSelfStartedWakes } from "../../../e2e/fixtures/self-started-wake-publication";
import { withOwnerPauseState } from "../../renderer/src/features/composer/queued-turn-pause";

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
const fixturePackages = new Map<"desktop" | "headless", { directory: string; preload: string }>();

async function startConformanceDaemon(options: Parameters<typeof startOutpostDaemon>[0] = {}) {
  const fixture = fixturePackages.get(options.hostKind ?? "headless");
  if (!fixture) throw new Error("The conformance suite must build its owner fixture before starting a daemon.");
  return await startOutpostDaemon({ ...options, packageRoot: fixture.directory, fixturePreload: fixture.preload });
}

/** One owner, reached the way a remote viewer reaches it. */
type OwnerHost = {
  name: OwnerHostName;
  ownerInstanceId: string;
  client: FederationRemoteBackendClient;
  /** `backend.*` methods this owner answers. */
  methods: Set<string>;
  events: AgentEvent[];
  workspace: string;
  providerSteerCount(): number;
  local?: LocalOwnerNavigationTransport;
  scheduler?: ScheduledThreadActionService;
  close(): Promise<void>;
};

/**
 * Desktop's real owner: the operations its federation runtime serves a peer,
 * over BackendRegistry, the real Codex client and a real state database,
 * registered with the real federation handlers behind a router that enforces
 * the shared capability table. Provider subprocesses use protocol fixtures.
 */
async function startDesktopOwner(
  threadTitleGenerationService: NonNullable<Parameters<typeof createDesktopBackendRegistry>[0]>["threadTitleGenerationService"] = null,
  prepareAcp?: (db: StateDb, workspace: string) => Promise<void>,
  claudeOptions?: (workspace: string) => NonNullable<Parameters<typeof createDesktopBackendRegistry>[0]>["claudeBackendOptions"],
  profileRoot?: string,
  protocolHelperTitle?: string,
): Promise<OwnerHost> {
  OwnerConformanceCodexTransport.reset();
  OwnerConformanceCodexTransport.helperTitle = protocolHelperTitle;
  const workspace = profileRoot ? path.join(profileRoot, "w") : await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-conformance-")));
  const { dbPath, tempDir } = profileRoot
    ? { dbPath: path.join(profileRoot, "profiles/t/state/state.db"), tempDir: path.join(profileRoot, "desktop") }
    : createTempStateDb("pwragent-conformance-db-");
  if (profileRoot) {
    for (const dir of [workspace, tempDir, path.join(profileRoot, "f")]) mkdirSync(dir, { recursive: true });
    OwnerConformanceCodexTransport.recordsFile = path.join(profileRoot, "f/fixture-threads.json");
  }
  const db = StateDb.open(dbPath, profileRoot ? { profileName: "t" } : undefined);
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
  const registry = createDesktopBackendRegistry({ codexClient, configStore, overlayStore, messagingStore: null,
    ...(profileRoot ? { providerThreadSnapshotStore: new ProviderThreadSnapshotStore(db) } : {}),
    ...(profileRoot ? { retainedOwnerThreadStorage: new RetainedOwnerThreadStore(db, path.join(profileRoot, "profiles/t/state/headless")) } : {}),
    ...(prepareAcp ? { acpAgentStore: new AcpAgentStore(db), acpSessionStore: new AcpSessionStore(db) } : {}),
    ...(claudeOptions ? { claudeBackendOptions: claudeOptions(workspace) } : {}),
    threadTitleGenerationService: protocolHelperTitle ? new ThreadTitleGenerationService({ generators: { codex: codexClient } }) : threadTitleGenerationService,
    pdfToolMcpServer: null, runtimeInstanceId: "conformance-desktop",
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
  let durableTurnRequests: DurableTurnRequestService;
  // What the federation runtime sends a viewer subscribed to every thread in
  // these classes; the rest of its fan-out is per-subscriber routing.
  const forward = (event: AgentEvent): void => {
    if (event.notification.method === "thread/turnQueue/updated") {
      const params = event.notification.params as { threadId: string; queueEntryId: string; status: string; turnId?: string; terminalStatus?: string };
      durableTurnRequests?.observeQueueEvent({ backend: event.backend, ...params });
    }
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
    registerHandler(method, async envelope => {
      try { return await handler(envelope); }
      catch (error) { throw new Error(`${method}: ${error instanceof Error ? error.stack : String(error)}`); }
    });
  };
  let rpc: FederationRpcEndpoint;
  router.registerConnection({ peerId: "viewer", capabilities: [...VIEWER_CAPABILITIES, "thread_grouping"],
    sendEnvelope: (envelope) => { rpc.receiveEnvelope(envelope); } });
  const backend = new DesktopFederationRuntime().localBackend();
  // Bind the production admission path to this owner's real scheduler/store;
  // the app's process singleton belongs to an initialized desktop profile.
  backend.steerTurn = (request) => admitSteerTurn(registry, scheduler, request);
  // This isolated profile has no mounted peers to promote during archive.
  // Keep archive/restore on its real registry and storage, like the scheduler.
  backend.archiveThread = (request) => registry.archiveThread(request);
  backend.restoreThread = (request) => registry.restoreThread(request);
  durableTurnRequests = new DurableTurnRequestService({
    storage: new SqliteDurableTurnRequestStore(db), ownerInstanceId: "desktop-owner",
    authorize: async (_scope, request) => { if (!(await backend.resolveThread(request)).thread) throw new Error("Destination unavailable"); },
    dispatch: (request, scope) => backend.startTurn({ ...request, messageOrigin: authenticateMessageOrigin({
      messageOrigin: request.messageOrigin, sourceInstanceId: JSON.parse(scope)[1], resolveSourceInstance: () => undefined,
    }) }),
    isQueued: async receipt => { await backend.readQueuedTurn(receipt); return true; },
    steer: request => backend.controlActiveTurn!({ ...request, operation: "steer" }),
  });
  registerFederationBackendHandlers({ router, backend, durableTurnRequests });
  rpc = new FederationRpcEndpoint({ localInstanceId: "viewer", remoteInstanceId: "desktop-owner", defaultTimeoutMs: 5000,
    sendEnvelope: (envelope) => { void router.routeEnvelope({ envelope, sourcePeerId: "viewer" }); } });
  return {
    name: "desktop", ownerInstanceId: "desktop-owner", client: new FederationRemoteBackendClient(rpc), methods, events, workspace,
    providerSteerCount: () => OwnerConformanceCodexTransport.requests.filter(item => item.method === "turn/steer").length,
    local: new LocalOwnerNavigationTransport(backend), scheduler,
    close: async () => {
      stopEvents();
      scheduler.dispose();
      await registry.close();
      await codexClient.close();
      desktopOwner.registry = undefined;
      resetDesktopOverlayStoreForTests();
      configStore.dispose();
      db.close();
      if (!profileRoot) {
        await rm(workspace, { recursive: true, force: true });
        await rm(tempDir, { recursive: true, force: true });
      }
    },
  };
}

/** The Outpost daemon on its Codex fixture, enrolled through a real invite. */
async function startOutpostOwner(hostKind: "desktop" | "headless" = "headless"): Promise<OwnerHost> {
  const outpost = await startConformanceDaemon({ capabilities: VIEWER_CAPABILITIES, hostKind });
  outpost.subscribe(EVENT_CLASSES);
  return { name: hostKind === "desktop" ? "desktop" : "outpost", ownerInstanceId: outpost.ownerInstanceId, client: outpost.client, methods: new Set(Object.keys(FEDERATION_BACKEND_METHOD_CAPABILITIES)),
    providerSteerCount: () => readFileSync(path.join(outpost.env.PWRAGENT_TEST_DATA!, "calls.jsonl"), "utf8")
      .trim().split("\n").map(line => JSON.parse(line)).filter(item => item.method === "turn/steer").length,
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

/**
 * Waits until an owner has finished the provider refresh it starts at boot,
 * then for its events to go quiet. Both hosts end that refresh with one
 * `navigation/invalidated` + `navigation/providerThreads/refreshed` pair, and
 * whether it lands before the viewer subscribes or inside the first step
 * depends on load, not on either owner. `listBackends` reports the refresh.
 * The owner records the outcome before it publishes the refreshed threads and
 * emits, so wait for the pair too, unless it went by before the viewer's
 * subscription took effect.
 */
async function awaitStartupProviderRefresh(host: OwnerHost): Promise<void> {
  const refreshed = () => host.events.some(event => event.notification.method === "navigation/providerThreads/refreshed");
  for (const deadline = Date.now() + 30_000; ; await delay(50)) {
    const state = (await host.client.listBackends({})).providerRefresh?.state;
    if (state === "ready" || state === "degraded") break;
    if (Date.now() >= deadline) throw new Error(`${host.name} never finished its startup provider refresh (${state ?? "not started"}).`);
  }
  for (const deadline = Date.now() + 5_000; !refreshed() && Date.now() < deadline;) await delay(50);
  await settle(host);
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
    run: async (host, context) => {
      const detail = await host.client.getNavigationSelectedDetail({ protocol: 2, ref: ref(context) });
      context.detailRevision = detail.revision;
      return detail;
    },
    values: (response) => ({ title: response.thread?.title, executionMode: response.thread?.executionMode }) },
  { name: "retain its selected revision", method: "backend.getNavigationSelectedDetail",
    run: (host, context) => host.client.getNavigationSelectedDetail({ protocol: 2, ref: ref(context), knownRevision: context.detailRevision }),
    values: response => ({ unchanged: response.unchanged }) },
  { name: "read its selected collection", method: "backend.getNavigationSelectedDetail",
    run: (host, context) => host.client.getNavigationSelectedDetail({ protocol: 2, ref: ref(context), collection: { name: "subthreadOrder" } }) },
  { name: "read its queue projection", method: "backend.getNavigationQueueProjection",
    run: (host, context) => host.client.getNavigationQueueProjection({ protocol: 2, ref: ref(context) }) },
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
  beforeAll(async () => {
    await Promise.all((["desktop", "headless"] as const).map(async kind => {
      const directory = await mkdtemp(path.join(os.tmpdir(), `pa-conformance-${kind}-`));
      const preload = await buildOwnerFixture(directory, kind);
      fixturePackages.set(kind, { directory, preload });
    }));
  });
  afterAll(async () => {
    await Promise.all([...fixturePackages.values()].map(fixture => rm(fixture.directory, { recursive: true, force: true })));
    fixturePackages.clear();
  });

  it.each([false, true])("scheduler retries its original acceptance after provider refusal or a thread lock (locked=%s)", async locked => {
    const host = await startDesktopOwner();
    const registry = desktopOwner.registry as DesktopBackendRegistry;
    try {
      await fc.assert(fc.asyncProperty(fc.string({ maxLength: 12 }), async suffix => {
        const created = await host.client.startThread({ backend: "codex", cwd: host.workspace });
        const identity = { backend: "codex" as const, threadId: created.threadId };
        const id = randomUUID(), queueEntryId = `scheduled-turn:${id}`;
        const input = [{ type: "text" as const, text: `Scheduled retry ${suffix}` }];
        const active = locked ? undefined : await host.client.startTurn({ ...identity, input: [{ type: "text", text: "slow" }] });
        if (locked) await registry.setThreadLock({ ...identity, locked: true }, { source: "operator" });
        await host.scheduler!.create({ ...identity, kind: "turn", scheduledFor: Date.now() + 60_000,
          displayText: "Scheduled retry", turn: { input } }, { id });
        const admitted = await host.scheduler!.sendNow({ id });
        expect(admitted.action.status).toBe(locked ? "held" : "queued");
        const original = await host.client.readQueuedTurn({ ...identity, queueEntryId });
        if (active) {
          OwnerConformanceCodexTransport.refusedStarts = 1;
          await host.client.interruptTurn({ ...identity, turnId: active.turnId! });
          await vi.waitFor(() => expect(host.scheduler!.get(id)?.status).toBe("held"));
        }
        const before = registry.getQueuedTurnsForThread(identity);
        const retried = await host.scheduler!.sendNow({ id });
        expect(retried.action.status).toBe(locked ? "held" : "started");
        expect(retried.action.queueEntryId).toBe(queueEntryId);
        if (locked) {
          expect(await host.client.readQueuedTurn({ ...identity, queueEntryId })).toEqual(original);
          expect(registry.getQueuedTurnsForThread(identity)).toEqual(before);
          await registry.setThreadLock({ ...identity, locked: false }, { source: "operator" }, { resumeQueue: false });
          expect((await host.scheduler!.sendNow({ id })).action.status).toBe("started");
        }
        const requests = OwnerConformanceCodexTransport.requests.filter(request => request.method === "turn/start"
          && request.params.threadId === identity.threadId
          && (request.params.input as Array<{ type: string; text?: string }>).some(item => item.type === "text" && item.text === input[0]!.text));
        expect(requests).toHaveLength(locked ? 1 : 2);
        expect((await host.client.getNavigationQueueProjection({ protocol: 2, ref: identity })).entries).toEqual([]);
        const turnId = host.scheduler!.get(id)!.turnId;
        await vi.waitFor(() => expect(host.events.some(event => event.notification.method === "turn/completed"
          && (event.notification.params as { turn?: { id?: string } }).turn?.id === turnId)).toBe(true));
      }), { numRuns: 4, examples: [[""]] });
    } finally { await host.close(); }
  });

  it("scheduled held admission refuses another acceptance's stable identity", async () => {
    const host = await startDesktopOwner();
    try {
      const identity = await host.client.startThread({ backend: "codex", cwd: host.workspace });
      await host.client.startTurn({ ...identity, input: [{ type: "text", text: "slow" }] });
      await fc.assert(fc.asyncProperty(fc.string({ maxLength: 30 }), async suffix => {
        const id = randomUUID();
        const queueEntryId = `scheduled-turn:${id}`;
        const text = `Same independent acceptance ${suffix}`;
        await host.client.startTurn({ ...identity, queueEntryId, delivery: "new_turn", input: [{ type: "text", text }] });
        const original = await host.client.readQueuedTurn({ ...identity, queueEntryId });
        try {
          await host.scheduler!.create({ ...identity, kind: "turn", scheduledFor: Date.now() + 60_000,
            manualReleaseRequired: true, displayText: text, turn: { input: [{ type: "text", text }] } }, { id });
          await expect(host.scheduler!.sendNow({ id })).rejects.toThrow(/reused|identity/);
          expect(host.scheduler!.get(id)?.status).toBe("failed");
          await host.scheduler!.cancel({ id });
          expect(await host.client.readQueuedTurn({ ...identity, queueEntryId })).toEqual(original);
          const rows = (await host.client.getNavigationQueueProjection({ protocol: 2, ref: identity })).entries;
          expect(rows.map(row => row.queueEntryId)).toEqual([queueEntryId]);
          expect(Boolean(rows[0]!.manualReleaseRequired)).toBe(false);
        } finally { await host.client.cancelQueuedTurn({ queueEntryId }); }
      }), { numRuns: 6, examples: [[""]] });
    } finally { await host.close(); }
  });

  it("scheduler retry controls have measured SQLite write budgets", async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const host = await startDesktopOwner();
    const registry = desktopOwner.registry as DesktopBackendRegistry;
    try {
      for (const locked of [true, false]) {
        const created = await host.client.startThread({ backend: "codex", cwd: host.workspace });
        const identity = { backend: "codex" as const, threadId: created.threadId };
        const id = `measured-scheduled-retry:${locked}`;
        const active = locked ? undefined : await host.client.startTurn({ ...identity, input: [{ type: "text", text: "slow" }] });
        if (locked) await registry.setThreadLock({ ...identity, locked: true }, { source: "operator" });
        await host.scheduler!.create({ ...identity, kind: "turn", scheduledFor: Date.now() + 60_000,
          displayText: "Measured scheduled retry", turn: { input: [{ type: "text", text: "Measured retry" }] } }, { id });
        await host.scheduler!.sendNow({ id });
        if (active) {
          OwnerConformanceCodexTransport.refusedStarts = 1;
          await host.client.interruptTurn({ ...identity, turnId: active.turnId! });
          await vi.waitFor(() => expect(host.scheduler!.get(id)?.status).toBe("held"));
        }
        const measured = await measureSqliteWrites(async () => {
          const retried = await host.scheduler!.sendNow({ id });
          expect(retried.action.status).toBe(locked ? "held" : "started");
          if (!locked) await vi.waitFor(() => expect(host.events.some(event => event.notification.method === "turn/completed"
            && (event.notification.params as { turn?: { id?: string } }).turn?.id === retried.action.turnId)).toBe(true));
        });
        expectSqliteWriteBudget({ budgetFile: "desktop-scheduler-held-retry-write-budgets.json",
          scenario: locked ? "locked-existing-retry" : "refused-existing-retry-through-terminal",
          note: locked ? "One scheduler-owned retry while locked, excluding creation and original admission"
            : "One scheduler-owned provider-refusal retry through its real terminal, excluding creation, original admission and refusal",
          writes: measured.writes });
      }
    } finally { await host.close(); vi.unstubAllEnvs(); }
  });

  it("registered held retries preserve sender, independent holds, native controls and durable neighbors through restart", async () => {
    const root = await realpath(await mkdtemp("/tmp/pa-held-id-"));
    let host = await startDesktopOwner(null, undefined, undefined, root);
    try {
      const registry = desktopOwner.registry as DesktopBackendRegistry;
      const created = await host.client.startThread({ backend: "codex", cwd: host.workspace });
      const identity = { backend: "codex" as const, threadId: created.threadId };
      const active = await host.client.startTurn({ ...identity, queueEntryId: "active-held-owner", input: [{ type: "text", text: "slow" }] });
      await host.client.startTurn({ ...identity, queueEntryId: "paused-neighbor", delivery: "new_turn", input: [{ type: "text", text: "Paused neighbor" }] });
      await host.client.setQueuedTurnPaused({ queueEntryId: "paused-neighbor", paused: true });
      const request = { ...identity, queueEntryId: "held-owner", origin: "scheduled" as const, holdReason: "Alice review",
        input: [{ type: "text" as const, text: "Same independent acceptance" }],
        messageOrigin: { kind: "agent" as const, sourceThread: { backend: "codex" as const, threadId: "alice" } } };
      await registry.submitHeldTurn(request);
      const queue = (registry as unknown as { threadTurnQueue: ThreadTurnQueue }).threadTurnQueue;
      await queue.submitGroupedSteer({ ...identity, origin: "manual", input: [{ type: "text", text: "Legacy grouped neighbor" }],
        messageOrigin: { kind: "agent", sourceThread: { backend: "codex", threadId: "bob" } } });
      const durable: SubmitDurableTurnRequest = { clientRequest: { version: 1, id: randomUUID(), createdAt: Date.now(), payloadHash: "" },
        request: { ...identity, delivery: "new_turn", input: [{ type: "text", text: "Durable neighbor" }] } };
      durable.clientRequest.payloadHash = createHash("sha256").update(canonicalDurableTurnRequest(host.ownerInstanceId, durable)).digest("hex");
      const receipt = await host.client.submitTurnRequest(durable);
      const original = await host.client.readQueuedTurn(request);
      await registry.setThreadLock({ ...identity, locked: true }, { source: "operator" });
      const before = (await host.client.getNavigationQueueProjection({ protocol: 2, ref: identity })).entries;
      const offset = host.events.length;
      await Promise.all([registry.submitHeldTurn(request), registry.submitHeldTurn(request), registry.submitHeldTurn(request)]);
      await expect(registry.submitHeldTurn({ ...request, origin: "manual",
        messageOrigin: { kind: "agent", sourceThread: { backend: "codex", threadId: "bob" } } })).rejects.toThrow(/reused/);
      await expect(registry.submitHeldTurn({ ...request, holdReason: "Bob review" })).rejects.toThrow(/reused/);
      await expect(registry.submitHeldTurn({ ...request, queueEntryId: receipt.queueEntryId })).rejects.toThrow(/reused/);
      await expect(registry.submitHeldTurn({ ...request, queueEntryId: "active-held-owner" })).rejects.toThrow(/already admitted/);
      expect(await host.client.readQueuedTurn(request)).toEqual(original);
      expect((await host.client.getNavigationQueueProjection({ protocol: 2, ref: identity })).entries).toEqual(before);
      expect(host.events.slice(offset).filter(event => event.notification.method === "thread/turnQueue/updated")).toEqual([]);
      await registry.setThreadLock({ ...identity, locked: false }, { source: "operator" });
      expect((await host.client.getNavigationQueueProjection({ protocol: 2, ref: identity })).entries.every(entry => entry.manualReleaseRequired)).toBe(true);
      expect(await host.client.submitTurnRequest(durable)).toEqual(receipt);
      expect(OwnerConformanceCodexTransport.requests.filter(item => item.method === "turn/start")).toHaveLength(1);
      expect(host.providerSteerCount()).toBe(0);
      expect(await host.client.cancelQueuedTurn({ queueEntryId: request.queueEntryId, expectedContentHash: original.contentHash })).toMatchObject({ cancelled: true });
      await host.client.interruptTurn({ ...identity, turnId: active.turnId! });
      await host.close();
      host = await startDesktopOwner(null, undefined, undefined, root);
      expect((await host.client.getNavigationQueueProjection({ protocol: 2, ref: identity })).entries).toEqual([]);
      expect(await host.client.submitTurnRequest(durable)).toMatchObject({ queueEntryId: receipt.queueEntryId });
      expect(OwnerConformanceCodexTransport.requests.filter(item => item.method === "turn/start")).toEqual([]);
    } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
  });

  it("held identity admissions and scheduled collision refusal have explicit SQLite budgets", async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const host = await startDesktopOwner();
    try {
      const registry = desktopOwner.registry as DesktopBackendRegistry;
      const identity = await host.client.startThread({ backend: "codex", cwd: host.workspace });
      await host.client.startTurn({ ...identity, input: [{ type: "text", text: "slow" }] });
      const { writes } = await measureSqliteWrites(async () => {
        for (let index = 0; index < 100; index++) {
          const request = { ...identity, queueEntryId: `held-budget:${index}`, origin: "scheduled" as const,
            input: [{ type: "text" as const, text: `Held acceptance ${index}` }], holdReason: "Original review" };
          await Promise.all([registry.submitHeldTurn(request), registry.submitHeldTurn(request), registry.submitHeldTurn(request)]);
          const original = await host.client.readQueuedTurn(request);
          await expect(registry.submitHeldTurn({ ...request, holdReason: "Different review" })).rejects.toThrow(/reused/);
          await expect(registry.submitHeldTurn({ ...request, origin: "manual" })).rejects.toThrow(/reused/);
          await host.client.setQueuedTurnPaused({ queueEntryId: request.queueEntryId, paused: true });
          expect(await host.client.readQueuedTurn(request)).toEqual(original);
          expect(await host.client.cancelQueuedTurn({ queueEntryId: request.queueEntryId, expectedContentHash: original.contentHash })).toMatchObject({ cancelled: true });
        }
      });
      expectSqliteWriteBudget({ budgetFile: "desktop-held-queue-identity-write-budgets.json", scenario: "held-admissions-100",
        note: "100 registered held admissions with three matching calls, refused owner/cause changes, immutable reads, pause attempts and hash cancellation; native setup excluded", writes });
      const id = "budget-held-collision", queueEntryId = `scheduled-turn:${id}`;
      const input = [{ type: "text" as const, text: "Independent ordinary acceptance" }];
      await host.client.startTurn({ ...identity, queueEntryId, delivery: "new_turn", input });
      await host.scheduler!.create({ ...identity, kind: "turn", scheduledFor: Date.now() + 60_000, manualReleaseRequired: true,
        displayText: "Independent ordinary acceptance", turn: { input } }, { id });
      const collision = await measureSqliteWrites(async () => {
        await expect(host.scheduler!.sendNow({ id })).rejects.toThrow(/reused/);
        expect(host.scheduler!.get(id)?.status).toBe("failed");
      });
      expectSqliteWriteBudget({ budgetFile: "desktop-held-queue-identity-write-budgets.json", scenario: "scheduled-collision-refusal",
        note: "Actual scheduled held identity collision: existing claim and failed outcome, excluding action creation and native/ordinary admission", writes: collision.writes });
    } finally { await host.close(); vi.unstubAllEnvs(); }
  });

  it("explicit waiting identities name one immutable acceptance across registered caller retries", async () => {
    const host = await startDesktopOwner();
    try {
      const identity = await host.client.startThread({ backend: "codex", cwd: host.workspace });
      await host.client.startTurn({ ...identity, input: [{ type: "text", text: "slow" }] });
      await fc.assert(fc.asyncProperty(fc.string({ maxLength: 30 }), fc.boolean(), async (suffix, local) => {
        const queueEntryId = `explicit:${randomUUID()}`;
        const request = { ...identity, queueEntryId, delivery: "new_turn" as const,
          input: [{ type: "text" as const, text: `Original acceptance ${suffix}` }] };
        const call = (value: typeof request) => local
          ? (desktopOwner.registry as DesktopBackendRegistry).submitTurn(value)
          : host.client.startTurn(value);
        try {
          await call(request);
          const original = await host.client.readQueuedTurn({ ...identity, queueEntryId });
          const offset = host.events.length;
          await expect(call({ ...request, input: [{ type: "text", text: `Different acceptance ${suffix}` }] }))
            .rejects.toThrow(/reused|identity/i);
          await call(request);
          expect(await host.client.readQueuedTurn({ ...identity, queueEntryId })).toEqual(original);
          expect((await host.client.getNavigationQueueProjection({ protocol: 2, ref: identity })).entries
            .filter(entry => entry.queueEntryId === queueEntryId)).toHaveLength(1);
          expect(host.events.slice(offset).filter(event => event.notification.method === "thread/turnQueue/updated"
            && event.notification.params.queueEntryId === queueEntryId)).toEqual([]);
        } finally { await host.client.cancelQueuedTurn({ queueEntryId }); }
      }), { numRuns: 6, examples: [["", false], ["", true]] });
    } finally { await host.close(); }
  });

  it("explicit identity retries preserve paused and held neighbors, sender ownership and durable receipts through restart", async () => {
    const root = await realpath(await mkdtemp("/tmp/pa-identity-"));
    let host = await startDesktopOwner(null, undefined, undefined, root);
    try {
      const registry = desktopOwner.registry as DesktopBackendRegistry;
      const created = await host.client.startThread({ backend: "codex", cwd: host.workspace });
      const identity = { backend: "codex" as const, threadId: created.threadId };
      const active = await host.client.startTurn({ ...identity, queueEntryId: "active-identity", input: [{ type: "text", text: "slow" }] });
      const request = { ...identity, delivery: "new_turn" as const, queueEntryId: "original-identity",
        input: [{ type: "text" as const, text: "Original immutable input" }],
        messageOrigin: { kind: "agent" as const, sourceThread: { backend: "codex" as const, threadId: "alice" } } };
      await host.client.startTurn(request);
      await host.client.setQueuedTurnPaused({ queueEntryId: request.queueEntryId, paused: true });
      const queue = (registry as unknown as { threadTurnQueue: ThreadTurnQueue }).threadTurnQueue;
      await queue.submitGroupedSteer({ ...identity, origin: "manual", input: [{ type: "text", text: "Legacy Bob input" }],
        messageOrigin: { kind: "agent", sourceThread: { backend: "codex", threadId: "bob" } } });
      await registry.submitHeldTurn({ ...identity, queueEntryId: "independent-review", input: [{ type: "text", text: "Review first" }], holdReason: "Independent review" });
      const receiptRequest: SubmitDurableTurnRequest = { clientRequest: { version: 1, id: randomUUID(), createdAt: Date.now(), payloadHash: "" },
        request: { ...identity, delivery: "new_turn", input: [{ type: "text", text: "Durable immutable neighbor" }] } };
      receiptRequest.clientRequest.payloadHash = createHash("sha256").update(canonicalDurableTurnRequest(host.ownerInstanceId, receiptRequest)).digest("hex");
      const receipt = await host.client.submitTurnRequest(receiptRequest);
      const before = await host.client.getNavigationQueueProjection({ protocol: 2, ref: identity });
      const original = await host.client.readQueuedTurn(request);
      await Promise.all([host.client.startTurn(request), host.client.startTurn(request), host.client.startTurn(request)]);
      await expect(host.client.startTurn({ ...request, messageOrigin: { kind: "agent", sourceThread: { backend: "codex", threadId: "bob" } } })).rejects.toThrow(/reused/);
      const other = await host.client.startThread({ backend: "codex", cwd: host.workspace });
      await expect(host.client.startTurn({ ...request, threadId: other.threadId })).rejects.toThrow(/reused/);
      await expect(host.client.startTurn({ ...request, queueEntryId: receipt.queueEntryId })).rejects.toThrow(/reused/);
      await expect(host.client.startTurn({ ...request, queueEntryId: "active-identity" })).rejects.toThrow(/already admitted/);
      await registry.setThreadLock({ ...identity, locked: true }, { source: "operator" });
      await expect(host.client.startTurn(request)).rejects.toThrow(/locked/i);
      await registry.setThreadLock({ ...identity, locked: false }, { source: "operator" });
      expect(await host.client.readQueuedTurn(request)).toEqual(original);
      expect((await host.client.getNavigationQueueProjection({ protocol: 2, ref: identity })).entries).toEqual(before.entries);
      expect(await host.client.submitTurnRequest(receiptRequest)).toEqual(receipt);
      expect(host.providerSteerCount()).toBe(0);
      expect(OwnerConformanceCodexTransport.requests.filter(item => item.method === "turn/start")).toHaveLength(1);
      expect(await host.client.cancelQueuedTurn({ queueEntryId: request.queueEntryId, expectedContentHash: original.contentHash })).toMatchObject({ cancelled: true });
      await expect(host.client.readQueuedTurn(request)).rejects.toThrow();
      await host.client.interruptTurn({ ...identity, turnId: active.turnId! });
      await host.close();
      host = await startDesktopOwner(null, undefined, undefined, root);
      expect((await host.client.getNavigationQueueProjection({ protocol: 2, ref: identity })).entries).toEqual([]);
      expect(OwnerConformanceCodexTransport.requests.filter(item => item.method === "turn/start")).toEqual([]);
      expect(await host.client.submitTurnRequest(receiptRequest)).toMatchObject({ queueEntryId: receipt.queueEntryId });
      expect(OwnerConformanceCodexTransport.requests.filter(item => item.method === "turn/start")).toEqual([]);
    } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
  });

  it("explicit waiting identity admission, concurrent retries, refused changes and controls add no SQLite writes", async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const host = await startDesktopOwner();
    try {
      const identity = await host.client.startThread({ backend: "codex", cwd: host.workspace });
      await host.client.startTurn({ ...identity, input: [{ type: "text", text: "slow" }] });
      const { writes } = await measureSqliteWrites(async () => {
        for (let index = 0; index < 100; index++) {
          const request = { ...identity, queueEntryId: `budget-identity:${index}`, delivery: "new_turn" as const,
            input: [{ type: "text" as const, text: `Immutable acceptance ${index}` }] };
          await Promise.all([host.client.startTurn(request), host.client.startTurn(request), host.client.startTurn(request)]);
          const original = await host.client.readQueuedTurn(request);
          await expect(host.client.startTurn({ ...request, input: [{ type: "text", text: "Changed acceptance" }] })).rejects.toThrow(/reused/);
          await host.client.setQueuedTurnPaused({ queueEntryId: request.queueEntryId, paused: true });
          await host.client.startTurn(request);
          expect(await host.client.readQueuedTurn(request)).toEqual(original);
          expect(await host.client.cancelQueuedTurn({ queueEntryId: request.queueEntryId, expectedContentHash: original.contentHash })).toMatchObject({ cancelled: true });
          await expect(host.client.readQueuedTurn(request)).rejects.toThrow();
        }
      });
      expectSqliteWriteBudget({ budgetFile: "desktop-explicit-queue-identity-write-budgets.json", scenario: "waiting-identity-admissions-100",
        note: "100 registered ordinary admissions with three concurrent matching retries, changed-input refusals, reads, pauses and hash cancellations; native setup excluded", writes });
      expect((await host.client.getNavigationQueueProjection({ protocol: 2, ref: identity })).entries).toEqual([]);
    } finally { await host.close(); vi.unstubAllEnvs(); }
  });

  it("both registered owners keep stable explicit retries separate from changed acceptance", async () => {
    for (const host of [await startDesktopOwner(), await startOutpostOwner()]) {
      try {
        const identity = await host.client.startThread({ backend: "codex", cwd: host.workspace });
        const active = await host.client.startTurn({ ...identity, input: [{ type: "text", text: "slow" }] });
        const request = { ...identity, queueEntryId: "same-caller-identity", delivery: "new_turn" as const,
          input: [{ type: "text" as const, text: "Original acceptance" }] };
        const accepted = await host.client.startTurn(request);
        const snapshot = await host.client.readQueuedTurn({ ...identity, queueEntryId: accepted.queueEntryId! });
        const retry = await host.client.startTurn(request);
        expect(retry.queueEntryId).toBe(accepted.queueEntryId);
        await expect(host.client.startTurn({ ...request, input: [{ type: "text", text: "Different acceptance" }] })).rejects.toThrow();
        expect(await host.client.readQueuedTurn({ ...identity, queueEntryId: accepted.queueEntryId! })).toEqual(snapshot);
        expect((await host.client.getNavigationQueueProjection({ protocol: 2, ref: identity })).entries.map(entry => entry.queueEntryId)).toEqual([accepted.queueEntryId]);
        expect(await host.client.cancelQueuedTurn({ queueEntryId: accepted.queueEntryId! })).toMatchObject({ cancelled: true });
        await expect(host.client.readQueuedTurn({ ...identity, queueEntryId: accepted.queueEntryId! })).rejects.toThrow();
        expect(host.providerSteerCount()).toBe(0);
        await host.client.interruptTurn({ ...identity, turnId: active.turnId! });
      } finally { await host.close(); }
    }
  });

  it("scheduled stable identities cannot be replaced by an ordinary explicit admission", async () => {
    const host = await startDesktopOwner();
    try {
      const identity = await host.client.startThread({ backend: "codex", cwd: host.workspace });
      await host.client.startTurn({ ...identity, input: [{ type: "text", text: "slow" }] });
      await host.scheduler!.create({ ...identity, kind: "turn", scheduledFor: Date.now() + 60_000,
        displayText: "Scheduled immutable input", turn: { input: [{ type: "text", text: "Scheduled immutable input" }] } }, { id: "identity-collision" });
      await host.scheduler!.sendNow({ id: "identity-collision" });
      const queueEntryId = "scheduled-turn:identity-collision";
      const original = await host.client.readQueuedTurn({ ...identity, queueEntryId });
      await expect(host.client.startTurn({ ...identity, queueEntryId, delivery: "new_turn", input: original.input })).rejects.toThrow(/reused/);
      expect(await host.client.readQueuedTurn({ ...identity, queueEntryId })).toEqual(original);
      expect((await host.client.getNavigationQueueProjection({ protocol: 2, ref: identity })).entries.map(entry => entry.queueEntryId)).toEqual([queueEntryId]);
    } finally { await host.close(); }
  });

  it("registered Claude SDK background, loop and cron hooks retain separate immutable held prompts", async () => {
    const desktop = await startDesktopOwner(null, async (_db, workspace) => {
      await writeFile(path.join(workspace, "claude.js"), readFileSync(path.join(process.cwd(),
        "apps/desktop/src/main/__tests__/fixtures/claude-self-started-cli.cjs")));
    }, workspace => ({ store: new ClaudeSessionStore(path.join(workspace, "sessions")),
      inspectInstallation: async () => ({ executable: path.join(workspace, "claude.js"), authStatus: "signed-in" }),
      discoverModels: async () => [], readCommands: async () => [], readMcpServers: async () => [], getSessionInfo: async () => undefined }));
    const registry = desktopOwner.registry as DesktopBackendRegistry;
    try {
      const ref = await desktop.client.startThread({ backend: "claude", cwd: desktop.workspace });
      await desktop.client.startTurn({ ...ref, input: [{ type: "text", text: "Start invented background work" }] });
      await vi.waitFor(() => expect(desktop.events.some(event => event.backend === "claude"
        && event.notification.method === "turn/completed")).toBe(true));
      await registry.setThreadLock({ ...ref, locked: true }, { source: "operator" });
      const wakes = [
        { source: "system", prompt: "Invented task notification" },
        { source: "loop_wakeup", prompt: "Invented loop fire" },
        { source: "schedule_wakeup", prompt: "Invented cron fire" },
        { source: "schedule_wakeup", prompt: "Invented cron fire" },
      ];
      const snapshots = new Map<string, Awaited<ReturnType<typeof desktop.client.readQueuedTurn>>>();
      for (const [index, wake] of wakes.entries()) {
        await publishSelfStartedWakes(desktop.workspace, wakes.slice(0, index + 1));
        await vi.waitFor(() => expect(existsSync(path.join(desktop.workspace, "hook-results.jsonl"))
          && readFileSync(path.join(desktop.workspace, "hook-results.jsonl"), "utf8").trim().split("\n").length).toBe(index + 1));
        const rows = (await desktop.client.getNavigationQueueProjection({ protocol: 2, ref })).entries;
        expect(rows).toHaveLength(Math.min(index + 1, 3));
        const id = rows.at(-1)!.queueEntryId;
        if (index < 3) {
          expect(snapshots.has(id)).toBe(false);
          const snapshot = await desktop.client.readQueuedTurn({ ...ref, queueEntryId: id });
          expect(snapshot.input).toEqual([{ type: "text", text: wake.prompt }]);
          snapshots.set(id, snapshot);
        }
        for (const [queueEntryId, snapshot] of snapshots) {
          expect(await desktop.client.readQueuedTurn({ ...ref, queueEntryId })).toEqual(snapshot);
        }
      }
      const results = readFileSync(path.join(desktop.workspace, "hook-results.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
      expect(results.every(result => result.outputs.some((output: { decision?: string }) => output.decision === "block"))).toBe(true);
      expect(readFileSync(path.join(desktop.workspace, "native-inputs.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
      await registry.setThreadLock({ ...ref, locked: false }, { source: "operator" });
      await vi.waitFor(() => expect(readFileSync(path.join(desktop.workspace, "native-inputs.jsonl"), "utf8").trim().split("\n")).toHaveLength(4));
      const inputs = readFileSync(path.join(desktop.workspace, "native-inputs.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line).message.content);
      expect(inputs.slice(1)).toEqual(wakes.slice(0, 3).map(wake => [{ type: "text", text: wake.prompt }]));
      await vi.waitFor(() => expect(registry.listHeldThreadQueueEntries(ref)).toEqual([]));
    } finally { await desktop.close(); }
  });

  it("self-started held admissions preserve every immutable acceptance and deduplicate only waiting prompts", async () => {
    const host = await startDesktopOwner();
    const registry = desktopOwner.registry as DesktopBackendRegistry;
    const queue = (registry as unknown as { threadTurnQueue: ThreadTurnQueue }).threadTurnQueue;
    try {
      await fc.assert(fc.asyncProperty(fc.array(fc.integer({ min: 0, max: 4 }), { minLength: 2, maxLength: 12 }),
        fc.string({ maxLength: 20 }), async (wakes, suffix) => {
          const identity = await host.client.startThread({ backend: "codex", cwd: host.workspace });
          const snapshots = new Map<string, Awaited<ReturnType<typeof host.client.readQueuedTurn>>>();
          const ids = new Map<string, string>();
          await registry.setThreadLock({ ...identity, locked: true }, { source: "operator" });
          await registry.submitHeldTurn({ ...identity, queueEntryId: `review:${identity.threadId}`,
            input: [{ type: "text", text: "Independent review" }], holdReason: "Independent review" });
          const neighbors = structuredClone(queue.getQueuedEntries(identity));
          try {
            for (const wake of wakes) {
              const prompt = `Wake ${wake}: ${suffix}`;
              expect(await registry.holdBackendSelfStartedTurn({ ...identity, prompt,
                source: ["task_notification", "loop_wakeup", "cron"][wake % 3] as "task_notification" | "loop_wakeup" | "cron" })).toBe(true);
              const waiting = queue.getQueuedEntries(identity);
              if (!ids.has(prompt)) {
                const entry = waiting.at(-1)!;
                ids.set(prompt, entry.id);
                expect(entry.input).toEqual([{ type: "text", text: prompt }]);
                expect(entry.messageOrigin).toEqual({ kind: "pwragent" });
                expect(snapshots.has(entry.id)).toBe(false);
                snapshots.set(entry.id, await host.client.readQueuedTurn({ ...identity, queueEntryId: entry.id }));
              }
              expect(waiting.map(entry => entry.id)).toEqual([...neighbors.map(entry => entry.id), ...ids.values()]);
              expect(waiting.slice(0, neighbors.length)).toEqual(neighbors);
              for (const [id, snapshot] of snapshots) {
                expect(await host.client.readQueuedTurn({ ...identity, queueEntryId: id })).toEqual(snapshot);
              }
              expect((await host.client.getNavigationQueueProjection({ protocol: 2, ref: identity })).entries.map(entry => entry.queueEntryId))
                .toEqual(waiting.map(entry => entry.id));
            }
          } finally {
            for (const entry of queue.getQueuedEntries(identity)) await host.client.cancelQueuedTurn({ queueEntryId: entry.id });
          }
        }), { numRuns: 25, examples: [[[0, 1, 0], ""]] });
    } finally { await host.close(); }
  });

  it("self-started identities leave durable neighbors unchanged and never return after desktop shutdown", async () => {
    const root = await realpath(await mkdtemp(path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "pa-self-reopen-")));
    let host = await startDesktopOwner(null, undefined, undefined, root);
    try {
      const registry = desktopOwner.registry as DesktopBackendRegistry;
      const created = await host.client.startThread({ backend: "codex", cwd: host.workspace });
      const ref = { backend: "codex" as const, threadId: created.threadId };
      const active = await host.client.startTurn({ ...ref, input: [{ type: "text", text: "slow" }] });
      const target = { scope: "remote" as const, instanceId: host.ownerInstanceId };
      const runtime = Object.assign(new DesktopFederationRuntime(), {
        connectedPeerTargets: () => [{ target, capabilities: ["turn_control", "durable_turn_requests_v1"] }], remoteBackend: () => host.client,
      });
      const request: SubmitDurableTurnRequest = { clientRequest: { version: 1, id: randomUUID(), createdAt: Date.now(), payloadHash: "" },
        request: { ...ref, input: [{ type: "text", text: "Immutable durable neighbor" }] } };
      request.clientRequest.payloadHash = createHash("sha256").update(canonicalDurableTurnRequest(host.ownerInstanceId, request)).digest("hex");
      const receipt = await runtime.submitDurableTurnRequest("self-started-device", request, target);
      const snapshot = await host.client.readQueuedTurn({ ...ref, queueEntryId: receipt.queueEntryId });
      await registry.setThreadLock({ ...ref, locked: true }, { source: "operator" });
      for (const prompt of ["First held wake", "Second held wake"]) await registry.holdBackendSelfStartedTurn({ ...ref, prompt, source: "cron" });
      expect(await host.client.readQueuedTurn({ ...ref, queueEntryId: receipt.queueEntryId })).toEqual(snapshot);
      expect(await runtime.submitDurableTurnRequest("self-started-device", request, target)).toEqual(receipt);
      expect((await host.client.resolveThreadAdmissionState(ref)).activeTurn?.turnId).toBe(active.turnId);
      expect(host.providerSteerCount()).toBe(0);
      const ids = registry.listHeldThreadQueueEntries(ref).map(entry => entry.entryId).filter(id => id !== receipt.queueEntryId);
      expect(new Set(ids).size).toBe(2);
      await host.client.cancelQueuedTurn({ queueEntryId: receipt.queueEntryId, expectedContentHash: snapshot.contentHash });
      await vi.waitFor(async () => expect(await runtime.getDurableTurnRequest("self-started-device",
        { ...ref, id: request.clientRequest.id }, target)).toMatchObject({ state: "completed", outcome: "cancelled" }));
      expect(await runtime.submitDurableTurnRequest("self-started-device", request, target)).toMatchObject({ state: "completed", outcome: "cancelled" });
      await host.close();
      host = await startDesktopOwner(null, undefined, undefined, root);
      expect((await host.client.getNavigationQueueProjection({ protocol: 2, ref })).entries).toEqual([]);
      for (const queueEntryId of ids) {
        await expect(host.client.readQueuedTurn({ ...ref, queueEntryId })).rejects.toThrow();
        expect(await host.client.releaseQueuedTurn({ queueEntryId })).toMatchObject({ disposition: "not_found" });
      }
      expect(OwnerConformanceCodexTransport.requests.filter(item => item.method === "turn/start")).toEqual([]);
    } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
  });

  it("concurrent self-started wakes retain independent holds, pause revisions, sender boundaries and fresh cancellation identities", async () => {
    const host = await startDesktopOwner();
    const registry = desktopOwner.registry as DesktopBackendRegistry;
    const queue = (registry as unknown as { threadTurnQueue: ThreadTurnQueue }).threadTurnQueue;
    try {
      await fc.assert(fc.asyncProperty(fc.string({ maxLength: 20 }), fc.boolean(), async (suffix, paused) => {
        const ref = await host.client.startThread({ backend: "codex", cwd: host.workspace });
        const active = await host.client.startTurn({ ...ref, input: [{ type: "text", text: "slow" }] });
        const starts = OwnerConformanceCodexTransport.requests.filter(request => request.method === "turn/start").length;
        const prompt = `Concurrent wake ${suffix}`;
        await registry.setThreadLock({ ...ref, locked: true }, { source: "operator" });
        // An unrelated sender with the same text must retain its own acceptance.
        const sender = await queue.submitGroupedSteer({ ...ref, origin: "manual", input: [{ type: "text", text: prompt }],
          messageOrigin: { kind: "agent", sourceThread: { backend: "codex", threadId: "other-sender" } } });
        if (paused) expect(await host.client.setQueuedTurnPaused({ queueEntryId: sender.entry.id, paused: true })).toMatchObject({ disposition: "updated" });
        await registry.submitHeldTurn({ ...ref, queueEntryId: `review:${ref.threadId}`, input: [{ type: "text", text: "Review" }], holdReason: "Independent review" });
        const neighbor = structuredClone(queue.getQueuedEntries(ref).find(entry => entry.id === sender.entry.id));
        const wake = { ...ref, prompt, source: "cron" as const };
        expect(await Promise.all(Array.from({ length: 5 }, () => registry.holdBackendSelfStartedTurn(wake)))).toEqual(Array(5).fill(true));
        const first = queue.getQueuedEntries(ref).at(-1)!;
        const accepted = await host.client.readQueuedTurn({ ...ref, queueEntryId: first.id });
        expect(queue.getQueuedEntries(ref)).toHaveLength(3);
        expect(await host.client.setQueuedTurnPaused({ queueEntryId: first.id, paused: true })).toMatchObject({ disposition: "held" });
        await registry.holdBackendSelfStartedTurn(wake);
        expect(queue.getQueuedEntries(ref).at(-1)).toEqual(first);
        expect(await host.client.readQueuedTurn({ ...ref, queueEntryId: first.id })).toEqual(accepted);
        expect(queue.getQueuedEntries(ref).find(entry => entry.id === sender.entry.id)).toEqual(neighbor);
        await registry.setThreadLock({ ...ref, locked: false }, { source: "operator" });
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(queue.getQueuedEntries(ref).every(entry => entry.manualReleaseRequired)).toBe(true);
        expect(OwnerConformanceCodexTransport.requests.filter(request => request.method === "turn/start")).toHaveLength(starts);
        await registry.setThreadLock({ ...ref, locked: true }, { source: "operator" });
        await host.client.cancelQueuedTurn({ queueEntryId: first.id, expectedContentHash: accepted.contentHash });
        await registry.holdBackendSelfStartedTurn(wake);
        const fresh = queue.getQueuedEntries(ref).at(-1)!;
        expect(fresh.id).not.toBe(first.id);
        expect(fresh.input).toEqual(accepted.input);
        await expect(host.client.readQueuedTurn({ ...ref, queueEntryId: first.id })).rejects.toThrow();
        for (const entry of queue.getQueuedEntries(ref)) await host.client.cancelQueuedTurn({ queueEntryId: entry.id });
        await host.client.interruptTurn(active);
      }), { numRuns: 25, examples: [["", true], ["", false]] });
    } finally { await host.close(); }
  });

  it("self-started admission, concurrent repeated wakes, reads, pauses and cancellations add no SQLite commits", async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const host = await startDesktopOwner();
    const registry = desktopOwner.registry as DesktopBackendRegistry;
    const queue = (registry as unknown as { threadTurnQueue: ThreadTurnQueue }).threadTurnQueue;
    try {
      const ref = await host.client.startThread({ backend: "codex", cwd: host.workspace });
      await registry.setThreadLock({ ...ref, locked: true }, { source: "operator" });
      await registry.submitHeldTurn({ ...ref, queueEntryId: "budget-review", input: [{ type: "text", text: "Review" }], holdReason: "Independent review" });
      await new Promise<void>(resolve => setImmediate(resolve));
      const { writes } = await measureSqliteWrites(async () => {
        for (let n = 0; n < 100; n++) {
          const wake = { ...ref, prompt: `Budget wake ${n}`, source: "cron" as const };
          await Promise.all(Array.from({ length: 3 }, () => registry.holdBackendSelfStartedTurn(wake)));
          const rows = queue.getQueuedEntries(ref);
          expect(rows).toHaveLength(2);
          const id = rows[1]!.id;
          const snapshot = await host.client.readQueuedTurn({ ...ref, queueEntryId: id });
          await host.client.setQueuedTurnPaused({ queueEntryId: id, paused: true });
          expect((await host.client.readQueuedTurn({ ...ref, queueEntryId: id })).contentHash).toBe(snapshot.contentHash);
          await host.client.cancelQueuedTurn({ queueEntryId: id, expectedContentHash: snapshot.contentHash });
        }
        await new Promise<void>(resolve => setImmediate(resolve));
      });
      expectSqliteWriteBudget({ scenario: "registered-self-started-admission-100", budgetFile: "desktop-self-started-admission-write-budgets.json",
        note: "100 fresh held wakes with three concurrent matching hooks each, registered reads, pause and hash cancellation; setup/lock/review excluded; real timers and drains.", writes });
    } finally { await host.close(); vi.unstubAllEnvs(); }
  });

  it("actual desktop ACP acceptance survives a session-read refusal in started publication", async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const backend = "acp:gemini" as const, threadId = "publication-acp";
    let failRead = false, refusedReads = 0, readFailureStack = "", confirmed: { turnId: string } | undefined;
    const desktop = await startDesktopOwner(null, async (db, workspace) => {
      const script = `
        const fs = require("node:fs");
        const rl = require("node:readline").createInterface({ input: process.stdin });
        const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
        rl.on("line", line => {
          const message = JSON.parse(line);
          fs.appendFileSync(${JSON.stringify(path.join(workspace, "publication-acp.jsonl"))}, line + "\\n");
          if (message.id === undefined) return;
          if (message.method === "session/prompt") send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: message.params.sessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Accepted publication fixture." } } } });
          send({ jsonrpc: "2.0", id: message.id, result: message.method === "initialize" ? { protocolVersion: 1 } : {} });
        });`;
      new AcpAgentStore(db).upsertInstalledAgent({ backendId: backend, registryId: "gemini", name: "Publication fixture",
        distributionKind: "local", distributionSource: "fixture", installStatus: "installed", authStatus: "not-required",
        verificationStatus: "not-applicable", allowlistRuleId: "fixture", installedAt: 1000, updatedAt: 1000,
        launchDescriptor: { backendId: backend, registryId: "gemini", distributionKind: "local",
          command: process.execPath, args: ["-e", script], env: {} },
      });
      new AcpSessionStore(db).upsertSession({ backendId: backend, sessionId: threadId, title: "Publication fixture",
        cwd: workspace, createdAt: 1000, updatedAt: 1000, executionMode: "default", status: "idle" });
    });
    const identity = { backend, threadId };
    const registry = desktopOwner.registry as DesktopBackendRegistry;
    const internal = registry as unknown as { startTurnNow: (params: { backend: AppServerBackendKind; threadId: string; input: unknown[] }) => Promise<{ backend: AppServerBackendKind; threadId: string; turnId: string }> };
    const start = internal.startTurnNow.bind(internal);
    const get = AcpSessionStore.prototype.getSession;
    const reader = vi.spyOn(AcpSessionStore.prototype, "getSession").mockImplementation(function (this: AcpSessionStore, ...args) {
      if (failRead) {
        failRead = false; refusedReads++;
        const error = new Error("Native session metadata unavailable");
        readFailureStack = error.stack ?? "";
        throw error;
      }
      return get.apply(this, args);
    });
    const submission = vi.spyOn(internal, "startTurnNow").mockImplementation(async params => {
      const result = await start(params);
      confirmed = result;
      // Fail only a real native metadata read AFTER the actual provider path
      // returns. The queue's started-event builder reads that same port.
      failRead = true;
      return result;
    });
    try {
      await registry.submitHeldTurn({ ...identity, queueEntryId: "accepted", origin: "scheduled",
        input: [{ type: "text", text: "Immutable ACP input" }], holdReason: "Review before starting" });
      let result: Awaited<ReturnType<typeof desktop.client.releaseQueuedTurn>>;
      const { writes } = await measureSqliteWrites(async () => {
        result = await desktop.client.releaseQueuedTurn({ queueEntryId: "accepted" });
        await vi.waitFor(() => expect(desktop.events.some(event => event.notification.method === "turn/completed"
          && event.notification.params.turnId === confirmed!.turnId)).toBe(true));
        await new Promise<void>(resolve => setImmediate(resolve));
      });
      expectSqliteWriteBudget({ budgetFile: "queue-started-publication-write-budgets.json", scenario: "desktop-acp-started-read-refusal",
        note: "Actual ACP held Retry, native prompt and terminal through started publication metadata refusal; setup/admission excluded", writes });
      expect(refusedReads).toBe(1);
      expect(readFailureStack).toContain("emitTurnQueueLifecycle");
      expect(readFailureStack).toContain("getCachedThreadSummary");
      const requests = readFileSync(path.join(desktop.workspace, "publication-acp.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
      expect(requests.filter(request => request.method === "session/prompt")).toHaveLength(1);
      expect(result!).toMatchObject({ disposition: "started", turnId: confirmed!.turnId });
      expect((await desktop.client.getNavigationQueueProjection({ protocol: 2, ref: identity })).entries).toEqual([]);
      expect(await desktop.client.cancelQueuedTurn({ queueEntryId: "accepted" })).toMatchObject({ cancelled: false, disposition: "already_admitted" });
    } finally { submission.mockRestore(); reader.mockRestore(); await desktop.close(); vi.unstubAllEnvs(); }
  });

  it("actual desktop provider refusal holds waiting input before blocked-event cancellation drains it", async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const root = await realpath(await mkdtemp("/tmp/pa-refuse-"));
    let host = await startDesktopOwner(null, undefined, undefined, root);
    const registry = desktopOwner.registry as DesktopBackendRegistry;
    let stop = () => {};
    try {
      const created = await host.client.startThread({ backend: "codex", cwd: host.workspace });
      const identity = { backend: "codex" as const, threadId: created.threadId };
      const active = await host.client.startTurn({ ...identity, input: [{ type: "text", text: "slow" }] });
      await vi.waitFor(() => expect(host.events.some(event => event.notification.method === "turn/started"
        && (event.notification.params.turn as { id?: string } | undefined)?.id === active.turnId)).toBe(true));
      for (const id of ["refused", "next"]) {
        await host.client.startTurn({ ...identity, queueEntryId: id, delivery: "new_turn", input: [{ type: "text", text: "slow" }] });
        await host.client.setQueuedTurnPaused({ queueEntryId: id, paused: true });
      }
      await host.client.interruptTurn({ ...identity, turnId: active.turnId! });
      await vi.waitFor(() => expect(host.events.some(event => event.notification.method === "turn/completed"
        && event.notification.params.turnId === active.turnId)).toBe(true));
      await new Promise<void>(resolve => setImmediate(resolve));
      let published!: () => void;
      const publication = new Promise<void>(resolve => { published = resolve; });
      stop = registry.onEvent(async event => {
        if (event.notification.method === "thread/turnQueue/updated" && event.notification.params.queueEntryId === "refused"
          && event.notification.params.status === "blocked") {
          expect(await host.client.cancelQueuedTurn({ queueEntryId: "refused" })).toMatchObject({ cancelled: true });
          await new Promise<void>(resolve => setImmediate(resolve));
          published();
        }
      });
      const { writes } = await measureSqliteWrites(async () => {
        OwnerConformanceCodexTransport.refusedStarts = 1;
        for (const id of ["refused", "next"]) await host.client.setQueuedTurnPaused({ queueEntryId: id, paused: false });
        await new Promise<void>(resolve => setImmediate(resolve));
        await publication;
        await new Promise<void>(resolve => setImmediate(resolve));
      });
      expectSqliteWriteBudget({ budgetFile: "queue-refusal-publication-write-budgets.json", scenario: "desktop-refusal-cancellation",
        note: "Actual queued provider refusal, blocked-event cancellation and real drains; setup and acceptance excluded", writes });
      // Exactly the original native turn and the refused request reached Codex.
      expect(OwnerConformanceCodexTransport.requests.filter(item => item.method === "turn/start")).toHaveLength(2);
      expect((await host.client.getNavigationQueueProjection({ protocol: 2, ref: identity })).entries)
        .toMatchObject([{ queueEntryId: "next", manualReleaseRequired: true }]);
      expect((await host.client.readQueuedTurn({ ...identity, queueEntryId: "next" })).input).toEqual([{ type: "text", text: "slow" }]);
      expect(await host.client.releaseQueuedTurn({ queueEntryId: "next" })).toMatchObject({ disposition: "started" });
      stop();
      await host.close();
      host = await startDesktopOwner(null, undefined, undefined, root);
      expect((await host.client.getNavigationQueueProjection({ protocol: 2, ref: identity })).entries).toEqual([]);
      expect(await host.client.releaseQueuedTurn({ queueEntryId: "next" })).toMatchObject({ disposition: "not_found" });
      expect(OwnerConformanceCodexTransport.requests.filter(item => item.method === "turn/start")).toEqual([]);
    } finally { stop(); await host.close(); await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs(); }
  });

  it.each(["direct", "scheduled"] as const)("actual desktop %s held admission covers resumed waiting input before its new review row is cancelled", async caller => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const root = await realpath(await mkdtemp("/tmp/pa-held-"));
    let host = await startDesktopOwner(null, undefined, undefined, root);
    const registry = desktopOwner.registry as DesktopBackendRegistry;
    let stop = () => {};
    try {
      const created = await host.client.startThread({ backend: "codex", cwd: host.workspace });
      const identity = { backend: "codex" as const, threadId: created.threadId };
      const active = await host.client.startTurn({ ...identity, input: [{ type: "text", text: "slow" }] });
      for (const id of ["older", "next"]) {
        await host.client.startTurn({ ...identity, queueEntryId: id, delivery: "new_turn", input: [{ type: "text", text: "slow" }] });
        await host.client.setQueuedTurnPaused({ queueEntryId: id, paused: true });
      }
      await host.client.interruptTurn({ ...identity, turnId: active.turnId! });
      await vi.waitFor(() => expect(host.events.some(event => event.notification.method === "turn/completed"
        && event.notification.params.turnId === active.turnId)).toBe(true));
      await new Promise<void>(resolve => setImmediate(resolve));
      const reviewId = caller === "scheduled" ? "scheduled-turn:held-review" : "review";
      if (caller === "scheduled") await host.scheduler!.create({ ...identity, kind: "turn", scheduledFor: Date.now() + 60_000,
        manualReleaseRequired: true, displayText: "Invented target-ended guidance",
        turn: { input: [{ type: "text", text: "Invented target-ended guidance" }] } }, { id: "held-review" });
      stop = registry.onEvent(async event => {
        if (event.notification.method === "thread/turnQueue/updated" && event.notification.params.queueEntryId === reviewId
          && event.notification.params.status === "queued") {
          expect(await host.client.cancelQueuedTurn({ queueEntryId: reviewId })).toMatchObject({ cancelled: true });
          await new Promise<void>(resolve => setImmediate(resolve));
        }
      });
      // The registered Resume controls schedule real drains. Held admission
      // must protect that pre-existing FIFO before its queued event yields.
      const { writes } = await measureSqliteWrites(async () => {
        for (const id of ["older", "next"]) await host.client.setQueuedTurnPaused({ queueEntryId: id, paused: false });
        if (caller === "scheduled") await host.scheduler!.sendNow({ id: "held-review" });
        else await registry.submitHeldTurn({ ...identity, queueEntryId: reviewId, origin: "scheduled",
          input: [{ type: "text", text: "Invented target-ended guidance" }], holdReason: "Target turn ended; review required" });
        await new Promise<void>(resolve => setImmediate(resolve));
      });
      expectSqliteWriteBudget({ budgetFile: "queue-held-admission-write-budgets.json", scenario: caller,
        note: "Actual resumed FIFO, held admission and review-row cancellation during queued publication with real drains; setup excluded", writes });
      expect(OwnerConformanceCodexTransport.requests.filter(item => item.method === "turn/start")).toHaveLength(1);
      expect((await host.client.getNavigationQueueProjection({ protocol: 2, ref: identity })).entries)
        .toMatchObject(["older", "next"].map(queueEntryId => ({ queueEntryId, manualReleaseRequired: true })));
      expect(await host.client.releaseQueuedTurn({ queueEntryId: "older" })).toMatchObject({ disposition: "started" });
      stop();
      await host.close();
      host = await startDesktopOwner(null, undefined, undefined, root);
      expect((await host.client.getNavigationQueueProjection({ protocol: 2, ref: identity })).entries).toEqual([]);
      expect(await host.client.releaseQueuedTurn({ queueEntryId: "next" })).toMatchObject({ disposition: "not_found" });
      expect(OwnerConformanceCodexTransport.requests.filter(item => item.method === "turn/start")).toEqual([]);
    } finally { stop(); await host.close(); await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs(); }
  });

  it("actual desktop tracked terminal publication cannot dispatch an unreviewed successor", async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const host = await startDesktopOwner();
    const registry = desktopOwner.registry as DesktopBackendRegistry;
    let stop = () => {};
    try {
      const created = await host.client.startThread({ backend: "codex", cwd: host.workspace });
      const identity = { backend: "codex" as const, threadId: created.threadId };
      await host.client.startTurn({ ...identity, queueEntryId: "tracked-owner", delivery: "new_turn",
        input: [{ type: "text", text: "fail" }] });
      for (const id of ["older", "next"]) await host.client.startTurn({ ...identity, queueEntryId: id,
        delivery: "new_turn", input: [{ type: "text", text: "slow" }] });
      let published!: () => void;
      const publication = new Promise<void>(resolve => { published = resolve; });
      let armed = true;
      stop = registry.onEvent(async event => {
        if (armed && event.notification.method === "thread/turnQueue/updated"
          && event.notification.params.queueEntryId === "tracked-owner" && event.notification.params.status === "terminal") {
          armed = false;
          await host.client.cancelQueuedTurn({ queueEntryId: "older" });
          await new Promise<void>(resolve => setImmediate(resolve));
          published();
        }
      });
      const { writes } = await measureSqliteWrites(async () => {
        await publication;
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(OwnerConformanceCodexTransport.requests.filter(item => item.method === "turn/start")).toHaveLength(1);
        await vi.waitFor(async () => expect((await host.client.getNavigationQueueProjection({ protocol: 2, ref: identity })).entries)
          .toMatchObject([{ queueEntryId: "next", manualReleaseRequired: true }]));
      });
      expectSqliteWriteBudget({ budgetFile: "queue-terminal-publication-write-budgets.json", scenario: "desktop-tracked-terminal-and-cancel",
        note: "Actual tracked provider failure, terminal-event cancellation and real drains; setup/admission excluded; existing terminal metadata only", writes });
      expect(await host.client.releaseQueuedTurn({ queueEntryId: "next" })).toMatchObject({ disposition: "started" });
    } finally { stop(); await host.close(); vi.unstubAllEnvs(); }
  });

  it("desktop correspondence learns a failure hold after a generated queued title lands", async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const host = await startDesktopOwner();
    const registry = desktopOwner.registry as DesktopBackendRegistry;
    let stop = () => {};
    try {
      const created = await host.client.startThread({ backend: "codex", cwd: host.workspace });
      const identity = { backend: "codex" as const, threadId: created.threadId };
      const source = { backend: "codex" as const, threadId: "invented-title-sender" };
      const input = [{ type: "text" as const, text: "Accepted report with enough detail for the existing queued message title helper to name it." }];
      const correspondence = registry["correspondenceStore"];
      correspondence.record({ id: "title-correspondence", source, destination: identity, input, createdAt: 1, state: "sending" });
      await host.client.startTurn({ ...identity, input: [{ type: "text", text: "fail" }] });
      await registry.submitTurn({ ...identity, queueEntryId: "title-older", delivery: "new_turn", input });
      await registry.submitTurn({ ...identity, queueEntryId: "title-next", delivery: "new_turn", input,
        messageOrigin: { kind: "agent", sourceThread: { ...source, messageId: "title-correspondence" } } });
      expect(correspondence.message(source, "title-correspondence")?.text).toContain("Queued");
      let published!: () => void;
      const publication = new Promise<void>(resolve => { published = resolve; });
      let armed = true;
      stop = registry.onEvent(async event => {
        if (!armed || event.notification.method !== "thread/turnQueue/updated"
          || event.notification.params.queueEntryId !== "title-older" || event.notification.params.status !== "held") return;
        armed = false;
        expect(registry["applyQueuedMessageTitle"]({ ...identity, entryId: "title-next", source: input[0]!.text }, "Generated queued title")).toBe(true);
        await new Promise<void>(resolve => setImmediate(resolve));
        published();
      });
      const { writes } = await measureSqliteWrites(async () => {
        await publication;
        await new Promise<void>(resolve => setImmediate(resolve));
      });
      expect(correspondence.message(source, "title-correspondence")?.text).toContain("Held");
      expect((await host.client.getNavigationQueueProjection({ protocol: 2, ref: identity })).entries)
        .toMatchObject([{ queueEntryId: "title-older", manualReleaseRequired: true },
          { queueEntryId: "title-next", manualReleaseRequired: true, title: "Generated queued title" }]);
      expect(OwnerConformanceCodexTransport.requests.filter(item => item.method === "turn/start")).toHaveLength(1);
      expectSqliteWriteBudget({ budgetFile: "queue-failure-title-publication-write-budgets.json", scenario: "desktop-failure-and-title",
        note: "Actual failure publication plus display-only title and real drain; setup excluded; existing terminal persistence only", writes });
    } finally { stop(); await host.close(); vi.unstubAllEnvs(); }
  });

  it("actual desktop failure publication cannot dispatch the successor of a cancelled held row", async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const host = await startDesktopOwner();
    const registry = desktopOwner.registry as DesktopBackendRegistry;
    let stop = () => {};
    try {
      const created = await host.client.startThread({ backend: "codex", cwd: host.workspace });
      const identity = { backend: "codex" as const, threadId: created.threadId };
      await host.client.startTurn({ ...identity, input: [{ type: "text", text: "fail" }] });
      for (const id of ["older", "next"]) await host.client.startTurn({ ...identity, queueEntryId: id,
        delivery: "new_turn", input: [{ type: "text", text: "slow" }] });
      let published!: () => void;
      const publication = new Promise<void>(resolve => { published = resolve; });
      let armed = true;
      stop = registry.onEvent(async event => {
        if (armed && event.notification.method === "thread/turnQueue/updated"
          && event.notification.params.queueEntryId === "older" && event.notification.params.status === "held") {
          armed = false;
          await host.client.cancelQueuedTurn({ queueEntryId: "older" });
          published();
        }
      });
      const { writes } = await measureSqliteWrites(async () => {
        await publication;
        await new Promise<void>(resolve => setImmediate(resolve));
      });
      expect(OwnerConformanceCodexTransport.requests.filter(item => item.method === "turn/start")).toHaveLength(1);
      expect((await host.client.getNavigationQueueProjection({ protocol: 2, ref: identity })).entries)
        .toMatchObject([{ queueEntryId: "next", manualReleaseRequired: true }]);
      expectSqliteWriteBudget({ budgetFile: "queue-failure-hold-publication-write-budgets.json", scenario: "desktop-failure-and-cancel",
        note: "Actual provider failure, held-event cancellation and real drain; acceptance/setup excluded; only existing terminal persistence", writes });
      expect(await host.client.releaseQueuedTurn({ queueEntryId: "next" })).toMatchObject({ disposition: "started" });
    } finally { stop(); await host.close(); vi.unstubAllEnvs(); }
  });

  it.each(["desktop", "outpost"] as const)("%s terminal failure leaves accepted new_turn input held through controls and cancellation", async name => {
    const host = name === "desktop" ? await startDesktopOwner() : await startOutpostOwner();
    try {
      const created = await host.client.startThread({ backend: "codex", cwd: host.workspace });
      const identity = { backend: "codex" as const, threadId: created.threadId };
      await host.client.startTurn({ ...identity, queueEntryId: "tracked-failure-owner", delivery: "new_turn", input: [{ type: "text", text: "fail" }] });
      const ids: string[] = [];
      for (const id of ["failure-older", "failure-next"]) {
        const accepted = await host.client.startTurn({ ...identity, queueEntryId: id,
          delivery: "new_turn", input: [{ type: "text", text: "slow" }] });
        expect(accepted).toMatchObject({ queueStatus: "queued" });
        ids.push(accepted.queueEntryId!);
      }
      const [older, next] = ids;
      const request = { protocol: 2 as const, ref: identity };
      await vi.waitFor(async () => expect((await host.client.getNavigationQueueProjection(request)).entries)
        .toMatchObject([{ queueEntryId: older, manualReleaseRequired: true }, { queueEntryId: next, manualReleaseRequired: true }]));
      await host.client.cancelQueuedTurn({ queueEntryId: older! });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect((await host.client.getNavigationQueueProjection(request)).entries).toMatchObject([{ queueEntryId: next, manualReleaseRequired: true }]);
      expect(await host.client.setQueuedTurnPaused({ queueEntryId: next!, paused: true })).toMatchObject({ disposition: "held" });
      expect(await host.client.moveQueuedTurn({ queueEntryId: next! })).toMatchObject({ disposition: "held" });
      expect((await host.client.readQueuedTurn({ ...identity, queueEntryId: next! })).input).toEqual([{ type: "text", text: "slow" }]);
      await vi.waitFor(() => expect(host.events.filter(event => event.notification.method === "thread/turnQueue/updated"
        && event.notification.params.queueEntryId === next).at(-1)?.notification.params).toMatchObject({ status: "held", manualReleaseRequired: true }));
      expect(await host.client.releaseQueuedTurn({ queueEntryId: next! })).toMatchObject({ disposition: "started" });
      expect(await host.client.releaseQueuedTurn({ queueEntryId: next! })).toMatchObject({ disposition: "not_found" });
    } finally { await host.close(); }
  });

  it.each(["held", "terminal"] as const)("desktop shutdown and profile reopen never restore input held during %s publication", async publicationType => {
    const root = await realpath(await mkdtemp("/tmp/pwragent-qf-"));
    let host: OwnerHost | undefined;
    let stop = () => {};
    try {
      host = await startDesktopOwner(null, undefined, undefined, root);
      const registry = desktopOwner.registry as DesktopBackendRegistry;
      const created = await host.client.startThread({ backend: "codex", cwd: host.workspace });
      const identity = { backend: "codex" as const, threadId: created.threadId };
      await host.client.startTurn({ ...identity, ...(publicationType === "terminal" ? { queueEntryId: "tracked-owner", delivery: "new_turn" as const } : {}), input: [{ type: "text", text: "fail" }] });
      for (const id of ["older", "next"]) await host.client.startTurn({ ...identity, queueEntryId: id,
        delivery: "new_turn", input: [{ type: "text", text: "slow" }] });
      let cancelled!: () => void;
      const publication = new Promise<void>(resolve => { cancelled = resolve; });
      let armed = true;
      stop = registry.onEvent(async event => {
        if (armed && event.notification.method === "thread/turnQueue/updated"
          && event.notification.params.status === publicationType
          && event.notification.params.queueEntryId === (publicationType === "terminal" ? "tracked-owner" : "older")) {
          armed = false;
          await host!.client.cancelQueuedTurn({ queueEntryId: "older" });
          cancelled();
        }
      });
      await publication;
      await new Promise<void>(resolve => setImmediate(resolve));
      expect((await host.client.getNavigationQueueProjection({ protocol: 2, ref: identity })).entries).toMatchObject([{ queueEntryId: "next", manualReleaseRequired: true }]);
      expect(OwnerConformanceCodexTransport.requests.filter(item => item.method === "turn/start")).toHaveLength(1);
      stop();
      await host.close();
      host = undefined;
      host = await startDesktopOwner(null, undefined, undefined, root);
      expect((await host.client.getNavigationQueueProjection({ protocol: 2, ref: identity })).entries).toEqual([]);
      expect(await host.client.releaseQueuedTurn({ queueEntryId: "next" })).toMatchObject({ disposition: "not_found" });
      expect(OwnerConformanceCodexTransport.requests.filter(item => item.method === "turn/start")).toEqual([]);
    } finally { stop(); await host?.close(); await rm(root, { recursive: true, force: true }); }
  });

  it.each(["failure", "title"] as const)("desktop unlock preserves review and sender lifecycle during overlapping %s publication", async overlap => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const host = await startDesktopOwner();
    const registry = desktopOwner.registry as DesktopBackendRegistry;
    const queue = registry["threadTurnQueue"];
    let stop = () => {};
    try {
      const created = await host.client.startThread({ backend: "codex", cwd: host.workspace });
      const identity = { backend: "codex" as const, threadId: created.threadId };
      const source = { backend: "codex" as const, threadId: "invented-sender" };
      const text = "Invented immutable report from a child thread, long enough to receive a generated queue title.";
      const input = [{ type: "text" as const, text }];
      await host.client.setThreadLock({ ...identity, locked: true, note: "old lock" });
      for (let index = 0; index < 2; index++) {
        registry["correspondenceStore"].record({ id: `message-${index}`, source, destination: identity, input, createdAt: index, state: "sending" });
        await queue.submitHeld({ ...identity, id: `waiting-${index}`, origin: "manual", input, paused: overlap === "title" || index === 0,
          messageOrigin: { kind: "agent", sourceThread: { ...source, messageId: `message-${index}` } } }, "prior review");
      }
      const senderState = () => [0, 1].map(index => parseThreadCorrespondenceMessage(registry["correspondenceStore"].message(source, `message-${index}`)?.text ?? "")?.state);
      await queue.releaseThread({ ...identity, turnId: "prior-native", status: "turn/failed", errorMessage: threadLockRefusalMessage({ note: "old lock" }) });
      expect(senderState()).toEqual(["held", "held"]);
      let armed = true, yieldingFailure = false;
      stop = registry.onEvent(async event => {
        if (event.notification.method !== "thread/turnQueue/updated") return;
        const params = event.notification.params;
        if (armed && params.queueEntryId === "waiting-0" && params.status === "queued" && !params.manualReleaseRequired) {
          armed = false;
          if (overlap === "failure") {
            yieldingFailure = true;
            await queue.releaseThread({ ...identity, turnId: "new-native", status: "turn/failed", errorMessage: "new review" });
          } else {
            expect(registry["applyQueuedMessageTitle"]({ entryId: "waiting-1", ...identity, source: text }, "Generated report title")).toBe(true);
          }
        } else if (yieldingFailure && params.status === "held") {
          yieldingFailure = false;
          await new Promise<void>(resolve => setImmediate(resolve));
        }
      });
      queue.scheduleThreadDrain(identity);
      const { writes } = await measureSqliteWrites(async () => {
        await host.client.setThreadLock({ ...identity, locked: false });
        await new Promise<void>(resolve => setImmediate(resolve));
      });
      expect(OwnerConformanceCodexTransport.requests.filter(item => item.method === "turn/start")).toEqual([]);
      expect(senderState()).toEqual(overlap === "failure" ? ["held", "held"] : ["queued", "queued"]);
      expect(queue.getQueuedEntries(identity).map(entry => entry.manualReleaseRequired === true)).toEqual([overlap === "failure", overlap === "failure"]);
      expect(queue.getQueuedEntries(identity).map(entry => entry.input)).toEqual([input, input]);
      if (overlap === "title") expect(queue.getQueuedEntries(identity)[1]?.title).toBe("Generated report title");
      expectSqliteWriteBudget({ budgetFile: "queue-unlock-hold-publication-write-budgets.json", scenario: `overlapping ${overlap}`,
        note: "Actual registered unlock and queue lifecycle, including real drain and sender correspondence; setup excluded", writes });
    } finally { stop(); await host.close(); vi.unstubAllEnvs(); }
  });

  it.each(["registered unlock", "mutate_thread unlock"] as const)("%s preserves actionable independent review during queue publication", async caller => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const host = await startDesktopOwner();
    const registry = desktopOwner.registry as DesktopBackendRegistry;
    let stop = () => {};
    try {
      const created = await host.client.startThread({ backend: "codex", cwd: host.workspace });
      const identity = { backend: "codex" as const, threadId: created.threadId };
      await host.client.setThreadLock({ ...identity, locked: true, note: "old lock" });
      const held = (id: string, reason: string) => registry.submitHeldTurn({ ...identity, queueEntryId: id,
        input: [{ type: "text", text: `Invented result ${id}` }], holdReason: reason });
      await held("older-result", threadLockRefusalMessage({ note: "old lock" }));
      let armed = true;
      stop = registry.onEvent(async event => {
        if (event.notification.method !== "thread/turnQueue/updated") return;
        const params = event.notification.params;
        if (armed && params.queueEntryId === "older-result" && params.status === "queued" && !params.manualReleaseRequired) {
          armed = false;
          await held("new-result", "independent review");
        }
      });
      const { writes } = await measureSqliteWrites(async () => {
        if (caller === "registered unlock") await host.client.setThreadLock({ ...identity, locked: false });
        else expect(await registry["threadInspectionHandler"]({ operation: "mutate_thread", context: identity, args: { ...identity, locked: false } })).toMatchObject({ ok: true });
        await new Promise<void>(resolve => setImmediate(resolve));
      });
      expectSqliteWriteBudget({ budgetFile: "queue-unlock-hold-publication-write-budgets.json", scenario: caller,
        note: "Actual desktop unlock plus independent held-result admission and real drain; setup excluded; only the existing lock-clear commit", writes });
      const request = { protocol: 2 as const, ref: identity };
      expect((await host.client.getNavigationQueueProjection(request)).entries.map(entry => ({ id: entry.queueEntryId, held: entry.manualReleaseRequired })).sort((a, b) => a.id.localeCompare(b.id)))
        .toEqual([{ id: "new-result", held: true }, { id: "older-result", held: true }]);
      expect(await host.client.cancelQueuedTurn({ queueEntryId: "new-result" })).toMatchObject({ cancelled: true });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect((await host.client.getNavigationQueueProjection(request)).entries).toMatchObject([{ queueEntryId: "older-result", manualReleaseRequired: true }]);
      expect(OwnerConformanceCodexTransport.requests.filter(item => item.method === "turn/start")).toEqual([]);
      const events = host.events.filter(event => event.notification.method === "thread/turnQueue/updated"
        && event.notification.params.queueEntryId === "older-result");
      expect(events.at(-1)?.notification.params).toMatchObject({ status: "held", manualReleaseRequired: true });
      expect(await host.client.releaseQueuedTurn({ queueEntryId: "older-result" })).toMatchObject({ disposition: "started" });
    } finally { stop(); await host.close(); vi.unstubAllEnvs(); }
  });

  it("shutdown and a fresh owner never restore an unlock's independently held input", async () => {
    const root = await realpath(await mkdtemp("/tmp/pwragent-qun-"));
    let host: OwnerHost | undefined;
    let stop = () => {};
    try {
      host = await startDesktopOwner(null, undefined, undefined, root);
      const registry = desktopOwner.registry as DesktopBackendRegistry;
      const created = await host.client.startThread({ backend: "codex", cwd: host.workspace });
      const identity = { backend: "codex" as const, threadId: created.threadId };
      await host.client.setThreadLock({ ...identity, locked: true });
      await registry.submitHeldTurn({ ...identity, queueEntryId: "older-result", input: [{ type: "text", text: "Invented held result" }], holdReason: threadLockRefusalMessage({}) });
      let armed = true;
      stop = registry.onEvent(async event => {
        if (armed && event.notification.method === "thread/turnQueue/updated"
          && event.notification.params.queueEntryId === "older-result" && !event.notification.params.manualReleaseRequired) {
          armed = false;
          await registry.submitHeldTurn({ ...identity, queueEntryId: "new-result", input: [{ type: "text", text: "Invented independent review" }], holdReason: "independent review" });
        }
      });
      await host.client.setThreadLock({ ...identity, locked: false });
      await host.client.cancelQueuedTurn({ queueEntryId: "new-result" });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect((await host.client.readQueuedTurn({ ...identity, queueEntryId: "older-result" })).input).toEqual([{ type: "text", text: "Invented held result" }]);
      expect(OwnerConformanceCodexTransport.requests.filter(item => item.method === "turn/start")).toEqual([]);
      stop();
      await host.close();
      host = undefined;
      expect(OwnerConformanceCodexTransport.requests.filter(item => item.method === "turn/start")).toEqual([]);
      host = await startDesktopOwner(null, undefined, undefined, root);
      expect((await host.client.getNavigationQueueProjection({ protocol: 2, ref: identity })).entries).toEqual([]);
      expect(await host.client.releaseQueuedTurn({ queueEntryId: "older-result" })).toMatchObject({ disposition: "not_found" });
      expect(OwnerConformanceCodexTransport.requests.filter(item => item.method === "turn/start")).toEqual([]);
    } finally { stop(); await host?.close(); await rm(root, { recursive: true, force: true }); }
  });

  it("registered desktop Retry preserves a new held result arriving during release publication", async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const host = await startDesktopOwner();
    const registry = desktopOwner.registry as DesktopBackendRegistry;
    let stop = () => {};
    try {
      const created = await host.client.startThread({ backend: "codex", cwd: host.workspace });
      const identity = { backend: "codex" as const, threadId: created.threadId };
      const held = (id: string, reason: string) => registry.submitHeldTurn({ ...identity, queueEntryId: id,
        input: [{ type: "text", text: `Invented result ${id}` }], holdReason: reason });
      await held("older-result", "old review");
      let armed = true;
      stop = registry.onEvent(async event => {
        if (event.notification.method !== "thread/turnQueue/updated") return;
        const params = event.notification.params;
        if (armed && params.queueEntryId === "older-result" && params.status === "queued" && !params.manualReleaseRequired) {
          armed = false;
          // Real held-result admission starts no native work and does not wait
          // for the dispatch suspension held by the registered Retry call.
          await held("new-result", "independent new review");
        }
      });
      const { writes } = await measureSqliteWrites(async () => {
        expect(await host.client.releaseQueuedTurn({ queueEntryId: "older-result" })).toMatchObject({ disposition: "busy" });
      });
      expectSqliteWriteBudget({ budgetFile: "queue-retry-hold-publication-write-budgets.json", scenario: "new-review-during-retry",
        note: "Registered desktop Retry and concurrent held-result admission; original setup excluded; no SQLite writes or native work", writes });
      const request = { protocol: 2 as const, ref: identity };
      const projection = await host.client.getNavigationQueueProjection(request);
      expect(projection.entries.map(entry => ({ id: entry.queueEntryId, held: entry.manualReleaseRequired })))
        .toEqual([{ id: "new-result", held: true }, { id: "older-result", held: true }]);
      expect(await host.client.cancelQueuedTurn({ queueEntryId: "new-result" })).toMatchObject({ cancelled: true });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect((await host.client.getNavigationQueueProjection(request)).entries).toMatchObject([{ queueEntryId: "older-result", manualReleaseRequired: true }]);
      expect(OwnerConformanceCodexTransport.requests.filter(item => item.method === "turn/start")).toEqual([]);
      const events = host.events.filter(event => event.notification.method === "thread/turnQueue/updated"
        && event.notification.params.queueEntryId === "older-result");
      expect(events.at(-1)?.notification.params).toMatchObject({ status: "held", manualReleaseRequired: true });
      expect(await host.client.releaseQueuedTurn({ queueEntryId: "older-result" })).toMatchObject({ disposition: "started" });
    } finally { stop(); await host.close(); vi.unstubAllEnvs(); }
  });

  it("the real desktop caller can Retry held guidance into its still-running native owner", async () => {
    const host = await startDesktopOwner();
    try {
      const created = await host.client.startThread({ backend: "codex", cwd: host.workspace });
      const identity = { backend: "codex" as const, threadId: created.threadId };
      const active = await host.client.startTurn({ ...identity, input: [{ type: "text", text: "slow" }] });
      const peer = { target: { scope: "remote" as const, instanceId: host.ownerInstanceId }, label: "Invented owner", capabilities: ["thread_navigation", "turn_control"] };
      const handler = createFederatedThreadMessageHandler({ runtime: () => ({ connectedPeerTargets: () => [peer], remoteBackend: () => host.client }) as unknown as DesktopFederationRuntime });
      OwnerConformanceCodexTransport.refusedSteers = 1;
      await handler({ ...identity, instanceId: host.ownerInstanceId, input: [{ type: "text", text: "Invented held desktop guidance" }],
        messageOrigin: { kind: "agent", sourceThread: { backend: "codex", threadId: "invented-sender", instanceId: "forged" } } });
      const projection = { protocol: 2 as const, ref: identity };
      await vi.waitFor(async () => expect((await host.client.getNavigationQueueProjection(projection)).entries[0]?.manualReleaseRequired).toBe(true));
      const id = (await host.client.getNavigationQueueProjection(projection)).entries[0]!.queueEntryId;
      expect(await host.client.releaseQueuedTurn({ queueEntryId: id })).toMatchObject({ disposition: "started", turnId: active.turnId });
      expect((await host.client.resolveThreadAdmissionState(identity)).activeTurn?.turnId).toBe(active.turnId);
      expect((await host.client.getNavigationQueueProjection(projection)).entries).toEqual([]);
      expect(await host.client.releaseQueuedTurn({ queueEntryId: id })).toMatchObject({ disposition: "not_found" });
      expect(host.providerSteerCount()).toBe(2); // One refused request, one accepted Retry.
      await host.client.interruptTurn(active);
    } finally { await host.close(); }
  });


  it("the real federated message caller steers ordinary agent input into the same native turn on both owners", async () => {
    const desktop = await startDesktopOwner();
    let outpost: OwnerHost | undefined;
    try {
      outpost = await startOutpostOwner();
      for (const host of [desktop, outpost]) {
        const identity = await host.client.startThread({ backend: "codex", cwd: host.workspace });
        const active = await host.client.startTurn({ ...identity, input: [{ type: "text", text: "slow" }] });
        const peer = { target: { scope: "remote" as const, instanceId: host.ownerInstanceId }, label: "Invented owner", capabilities: ["thread_navigation", "turn_control"] };
        const handler = createFederatedThreadMessageHandler({ runtime: () => ({ connectedPeerTargets: () => [peer], remoteBackend: () => host.client }) as unknown as DesktopFederationRuntime });
        const before = host.providerSteerCount!();
        for (let i = 0; i < 3; i++) {
          await handler({ backend: "codex", threadId: identity.threadId, instanceId: host.ownerInstanceId, input: [{ type: "text", text: `Invented guidance ${i}` }],
            messageOrigin: { kind: "agent", sourceThread: { backend: "codex", threadId: `sender-${i}`, instanceId: "forged" } } });
          await vi.waitFor(() => expect(host.providerSteerCount!(), host.name).toBe(before + i + 1));
        }
        expect((await host.client.getNavigationQueueProjection({ protocol: 2, ref: identity })).entries).toEqual([]);
        const calls = host.name === "desktop" ? OwnerConformanceCodexTransport.requests
          : readFileSync(path.resolve(host.workspace, "../f/calls.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
        const steers = calls.filter(call => call.method === "turn/steer" && call.params?.threadId === identity.threadId);
        expect(steers).toHaveLength(3);
        expect(steers.every(call => call.params.expectedTurnId === active.turnId)).toBe(true);
        const waiting = await host.client.startTurn({ ...identity, delivery: "new_turn", queueEntryId: "distinct", input: [{ type: "text", text: "Invented next turn" }],
          messageOrigin: { kind: "agent", sourceThread: { backend: "codex", threadId: "sender", instanceId: "forged" } } });
        expect((await host.client.getNavigationQueueProjection({ protocol: 2, ref: identity })).entries.map(entry => entry.queueEntryId)).toEqual([waiting.queueEntryId]);
        expect(host.providerSteerCount!()).toBe(before + 3);
        await host.client.cancelQueuedTurn({ queueEntryId: waiting.queueEntryId! });
        await host.client.interruptTurn(active);
      }
    } finally { await outpost?.close(); await desktop.close(); }
  });

  it("the enrolled Outpost retries an unclaimed workspace refusal without replacing its native owner", async () => {
    const host = await startConformanceDaemon({ capabilities: [...VIEWER_CAPABILITIES, "turn_queue_pause"] });
    const displaced = `${host.workspace}-unavailable`;
    try {
      const created = await host.client.startThread({ backend: "codex", cwd: host.workspace });
      const identity = { backend: "codex" as const, threadId: created.threadId };
      const active = await host.client.startTurn({ ...identity, input: [{ type: "text", text: "slow" }] });
      const request = (id: string, text: string) => ({ ...identity, queueEntryId: id, input: [{ type: "text" as const, text }],
        messageOrigin: { kind: "agent" as const, sourceThread: { backend: "codex" as const, threadId: "invented-sender", instanceId: "forged" } } });
      await host.client.startTurn(request("ack-gate", "hold-steer-ack"));
      await vi.waitFor(() => expect(existsSync(path.join(host.env.PWRAGENT_TEST_DATA!, "steer.ready"))).toBe(true));
      const guidance = request("held-guidance", "Invented recoverable workspace guidance");
      const accepted = await host.client.startTurn(guidance);
      await host.client.setQueuedTurnPaused({ queueEntryId: accepted.queueEntryId!, paused: true });
      await rename(host.workspace, displaced);
      await writeFile(path.join(host.env.PWRAGENT_TEST_DATA!, "steer.release"), "release");
      await host.client.setQueuedTurnPaused({ queueEntryId: accepted.queueEntryId!, paused: false });
      const projection = { protocol: 2 as const, ref: identity };
      await vi.waitFor(async () => expect((await host.client.getNavigationQueueProjection(projection)).entries[0]?.manualReleaseRequired).toBe(true));
      const held = await host.client.getNavigationQueueProjection(projection);
      expect(await host.client.releaseQueuedTurn({ queueEntryId: accepted.queueEntryId! })).toMatchObject({ disposition: "blocked" });
      expect(await host.client.getNavigationQueueProjection(projection)).toEqual(held);
      await rename(displaced, host.workspace);
      expect(await host.client.releaseQueuedTurn({ queueEntryId: accepted.queueEntryId! })).toMatchObject({ disposition: "started", turnId: active.turnId });
      expect((await host.client.startTurn(guidance)).queueEntryId).toBe(accepted.queueEntryId);
      expect((await host.client.resolveThreadAdmissionState(identity)).activeTurn?.turnId).toBe(active.turnId);
      expect((await host.client.getNavigationQueueProjection(projection)).entries).toEqual([]);
      const calls = readFileSync(path.join(host.env.PWRAGENT_TEST_DATA!, "calls.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
      expect(calls.filter(call => call.method === "turn/steer" && call.params.input[0].text === guidance.input[0]!.text)).toHaveLength(1);
      expect(calls.filter(call => call.method === "turn/start" && call.params.input[0].text === guidance.input[0]!.text)).toHaveLength(0);
      await host.client.interruptTurn(active);
    } finally {
      if (existsSync(displaced)) await rename(displaced, host.workspace);
      await host.close();
    }
  });

  it("the existing durable steering caller delivers once to the active turn on both registered owners and leaves waiting input intact", async () => {
    const desktop = await startDesktopOwner();
    let outpost: OwnerHost | undefined;
    try {
      outpost = await startOutpostOwner();
      for (const host of [desktop, outpost]) {
        const identity = await host.client.startThread({ backend: "codex", cwd: host.workspace });
        const active = await host.client.startTurn({ ...identity, input: [{ type: "text", text: "slow" }] });
        const waiting = await host.client.startTurn({ ...identity, input: [{ type: "text", text: "Invented waiting input" }] });
        const target = { scope: "remote" as const, instanceId: host.ownerInstanceId };
        const runtime = Object.assign(new DesktopFederationRuntime(), {
          connectedPeerTargets: () => [{ target, capabilities: ["turn_control", "durable_steer_requests_v1"] }],
          remoteBackend: () => host.client,
        });
        const value = (text: string, id: string = randomUUID()): SubmitDurableSteerRequest => {
          const request: SubmitDurableSteerRequest = { clientRequest: { version: 1, id, createdAt: Date.now(), payloadHash: "" },
            request: { backend: "codex", threadId: identity.threadId, expectedTurnId: active.turnId, input: [{ type: "text", text }] } };
          request.clientRequest.payloadHash = createHash("sha256").update(canonicalDurableSteerRequest(host.ownerInstanceId, request)).digest("hex");
          return request;
        };
        const before = host.providerSteerCount!(), request = value("Invented durable interjection");
        const receipts = await Promise.all(Array.from({ length: 8 }, () => runtime.submitDurableSteerRequest("mobile:device", request, target)));
        const lookup = { ...identity, id: request.clientRequest.id };
        const receipt = await runtime.getDurableSteerRequest("mobile:device", lookup, target);
        expect(receipts.every(result => result.queueEntryId === receipt!.queueEntryId)).toBe(true);
        expect(receipt, JSON.stringify(receipt)).toMatchObject({ state: "dispatched", operation: "steerTurn", result: {
          ok: true, requestId: receipt!.queueEntryId, turnId: active.turnId, disposition: "steered",
        } });
        expect(host.providerSteerCount!()).toBe(before + 1);
        expect(await runtime.getDurableSteerRequest("other-device", lookup, target)).toBeNull();
        await expect(runtime.submitDurableSteerRequest("mobile:device", value("Changed input", request.clientRequest.id), target)).rejects.toThrow();
        expect((await host.client.getNavigationQueueProjection({ protocol: 2, ref: identity })).entries.map(entry => entry.queueEntryId)).toEqual([waiting.queueEntryId]);
        await host.client.cancelQueuedTurn({ queueEntryId: waiting.queueEntryId! });
        await host.client.interruptTurn(active);
        expect(await runtime.submitDurableSteerRequest("mobile:device", request, target)).toEqual(receipt);
        expect(host.providerSteerCount!()).toBe(before + 1);
      }
    } finally { await outpost?.close(); await desktop.close(); }
  });

  describe("steering grant admission", () => {
    it("the enrolled Outpost requires both steering feature and turn-control grants before receipt admission", async () => {
      const outpost = await startConformanceDaemon();
      try {
        // Grants are per viewer; the fully granted viewer must not authorize another peer.
        for (const capabilities of [["turn_control"], ["durable_steer_requests_v1"], ["durable_turn_requests_v1", "turn_control"]] as FederationCapability[][]) {
          const viewer = await outpost.enrollViewer(capabilities);
          try {
            expect(viewer.ownerInstanceId).toBe(outpost.ownerInstanceId);
            expect(viewer.viewerId).not.toBe(outpost.viewerId);
            const request: SubmitDurableSteerRequest = { clientRequest: { version: 1, id: randomUUID(), createdAt: Date.now(), payloadHash: "" },
              request: { backend: "codex", threadId: "unadmitted", expectedTurnId: "unadmitted-turn", input: [{ type: "text", text: "Must not be admitted" }] } };
            request.clientRequest.payloadHash = createHash("sha256").update(canonicalDurableSteerRequest(outpost.ownerInstanceId, request)).digest("hex");
            await expect(viewer.client.submitSteerRequest(request)).rejects.toThrow(/capability|grant|forbidden|allowed/i);
            await expect(viewer.client.getSteerRequest({ backend: "codex", threadId: "unadmitted", id: request.clientRequest.id })).rejects.toThrow(/capability|grant|forbidden|allowed/i);
            const db = StateDb.open(path.join(outpost.env.PWRAGENT_HOME!, "profiles/t/state/state.db"));
            try {
              const scope = JSON.stringify(["steerTurn", JSON.stringify(["federation", viewer.viewerId, ""])]);
              expect(new SqliteDurableTurnRequestStore(db).read(scope, request.clientRequest.id)).toBeUndefined();
            } finally { db.close(); }
          } finally { await viewer.close(); }
        }
      } finally { await outpost.close(); }
    });
  });

  it("the existing durable federation runtime caller shares one acceptance through queue cancellation and terminal reconciliation on both owners", async () => {
    const desktop = await startDesktopOwner();
    let outpost: OwnerHost | undefined;
    try {
      outpost = await startOutpostOwner();
      for (const host of [desktop, outpost]) {
        const identity = await host.client.startThread({ backend: "codex", cwd: host.workspace });
        const active = await host.client.startTurn({ ...identity, input: [{ type: "text", text: "slow" }] });
        const target = { scope: "remote" as const, instanceId: host.ownerInstanceId };
        const runtime = Object.assign(new DesktopFederationRuntime(), {
          connectedPeerTargets: () => [{ target, capabilities: ["turn_control", "durable_turn_requests_v1"] }],
          remoteBackend: () => host.client,
        });
        const submission = (text: string): SubmitDurableTurnRequest => {
          const value: SubmitDurableTurnRequest = { clientRequest: { version: 1, id: randomUUID(), createdAt: Date.now(), payloadHash: "" }, request: { backend: "codex", threadId: identity.threadId, input: [{ type: "text", text }] } };
          value.clientRequest.payloadHash = createHash("sha256").update(canonicalDurableTurnRequest(host.ownerInstanceId, value)).digest("hex");
          return value;
        };
        const request = submission("Invented durable queued input");
        const receipts = await Promise.all(Array.from({ length: 8 }, () => runtime.submitDurableTurnRequest("mobile:device", request, target)));
        const receipt = receipts[0]!;
        expect(receipts.every(result => result.queueEntryId === receipt.queueEntryId)).toBe(true);
        expect(receipt).toMatchObject({ state: "accepted", result: { queueStatus: "queued", queueEntryId: receipt.queueEntryId } });
        const lookup = { ...identity, id: request.clientRequest.id };
        expect(await runtime.getDurableTurnRequest("other-device", lookup, target)).toBeNull();
        expect((await host.client.getNavigationQueueProjection({ protocol: 2, ref: identity })).entries.map(entry => entry.queueEntryId)).toEqual([receipt.queueEntryId]);
        await host.client.cancelQueuedTurn({ queueEntryId: receipt.queueEntryId });
        await vi.waitFor(async () => {
          expect(await runtime.getDurableTurnRequest("mobile:device", lookup, target)).toMatchObject({ state: "completed", outcome: "cancelled" });
        });
        expect(await runtime.submitDurableTurnRequest("mobile:device", request, target)).toMatchObject({ state: "completed", outcome: "cancelled" });
        const changed = submission("Invented fresh durable input"), replacement = await runtime.submitDurableTurnRequest("mobile:device", changed, target);
        expect(replacement.queueEntryId).not.toBe(receipt.queueEntryId);
        await host.client.interruptTurn(active);
        await vi.waitFor(async () => {
          expect(await runtime.getDurableTurnRequest("mobile:device", { ...identity, id: changed.clientRequest.id }, target)).toMatchObject({ state: "completed", outcome: "completed", result: { queueStatus: "started" } });
        });
      }
    } finally { await outpost?.close(); await desktop.close(); }
  });

  it("the enrolled Outpost enforces durable feature and nested messaging grants before receipt admission", async () => {
    // One daemon; each case enrolls its own viewer, as in "steering grant admission".
    const outpost = await startConformanceDaemon();
    try {
      for (const feature of [false, true]) {
        const viewer = await outpost.enrollViewer(["turn_control", "environment_actions", "thread_detail", ...(feature ? ["durable_turn_requests_v1" as const] : [])]);
        try {
          const identity = await viewer.client.startThread({ backend: "codex", cwd: outpost.workspace });
          const value: SubmitDurableTurnRequest = { clientRequest: { version: 1, id: randomUUID(), createdAt: Date.now(), payloadHash: "" }, request: { ...identity,
            input: [{ type: "text", text: "Must not be admitted" }], ...(feature ? { messageOrigin: { kind: "messaging", causalMessagingSource: { ownerId: "owner", requestId: "request" } } as const } : {}) } };
          value.clientRequest.payloadHash = createHash("sha256").update(canonicalDurableTurnRequest(outpost.ownerInstanceId, value)).digest("hex");
          await expect(viewer.client.submitTurnRequest(value)).rejects.toThrow(/capability|grant|forbidden|allowed/i);
          if (feature) expect(await viewer.client.getTurnRequest({ ...identity, id: value.clientRequest.id })).toBeNull();
        } finally { await viewer.close(); }
      }
    } finally { await outpost.close(); }
  });

  it("generated desktop sender replacement retires immutable queue identities before admitting changed input", async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.string({ minLength: 1, maxLength: 80 }).filter(text => Boolean(text.trim())), { minLength: 1, maxLength: 4 }),
      async edits => {
        const host = await startDesktopOwner();
        try {
          const identity = await host.client.startThread({ backend: "codex", cwd: host.workspace });
          await host.client.startTurn({ ...identity, input: [{ type: "text", text: "slow" }] });
          const messageOrigin = { kind: "agent" as const, sourceThread: { backend: "codex" as const, threadId: "sender" } };
          let accepted = await host.client.startTurn({ ...identity, input: [{ type: "text", text: "Original accepted input" }], messageOrigin });
          for (const text of edits) {
            const oldId = accepted.queueEntryId!;
            const original = await host.client.readQueuedTurn({ ...identity, queueEntryId: oldId });
            const originalInput = structuredClone(original.input);
            const offset = host.events.length;
            accepted = await host.client.replaceQueuedMessage({ ...identity, queueEntryId: oldId, input: [{ type: "text", text }], messageOrigin });
            // Each accepted identity names one immutable input. Changing it
            // retires the old row and admits a fresh row, even inside a batch.
            expect(accepted.queueEntryId).not.toBe(oldId);
            await expect(host.client.readQueuedTurn({ ...identity, queueEntryId: oldId })).rejects.toThrow();
            expect(original.input).toEqual(originalInput);
            expect(await host.client.readQueuedTurn({ ...identity, queueEntryId: accepted.queueEntryId! })).toMatchObject({ input: [{ type: "text", text }] });
            const updates = host.events.slice(offset).flatMap(event => event.notification.method === "thread/turnQueue/updated"
              ? [[event.notification.params.queueEntryId, event.notification.params.status]] : []);
            expect(updates).toEqual([[oldId, "cancelled"], [accepted.queueEntryId, "queued"]]);
            expect((await host.client.getNavigationQueueProjection({ protocol: 2, ref: identity })).entries.map(entry => entry.queueEntryId)).toEqual([accepted.queueEntryId]);
          }
        } finally { await host.close(); }
      },
    ), { numRuns: 4, examples: [[["!"]]] });
  });

  it("desktop replacement retires its durable new-turn receipt without retargeting it to changed input", async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const root = await realpath(await mkdtemp("/tmp/pa-replace-reopen-"));
    let host = await startDesktopOwner(null, undefined, undefined, root);
    let oldId = "", replacementId = "";
    let identity!: { backend: "codex"; threadId: string };
    try {
      const created = await host.client.startThread({ backend: "codex", cwd: host.workspace });
      identity = { backend: "codex", threadId: created.threadId };
      const active = await host.client.startTurn({ ...identity, input: [{ type: "text", text: "slow" }] });
      const messageOrigin = { kind: "agent" as const, sourceThread: { backend: "codex" as const, threadId: "sender" } };
      const request: SubmitDurableTurnRequest = { clientRequest: { version: 1, id: randomUUID(), createdAt: Date.now(), payloadHash: "" },
        request: { ...identity, delivery: "new_turn", input: [{ type: "text", text: "Original durable input" }], messageOrigin } };
      request.clientRequest.payloadHash = createHash("sha256").update(canonicalDurableTurnRequest(host.ownerInstanceId, request)).digest("hex");
      const receipt = await host.client.submitTurnRequest(request);
      oldId = receipt.queueEntryId;
      for (let n = 0; n < 4; n++) await new Promise<void>(resolve => setImmediate(resolve));
      const { result: replacement, writes } = await measureSqliteWrites(async () => {
        const result = await host.client.replaceQueuedMessage({ ...identity, queueEntryId: oldId, input: [{ type: "text", text: "Fresh agent input" }], messageOrigin });
        for (let n = 0; n < 4; n++) await new Promise<void>(resolve => setImmediate(resolve));
        return result;
      });
      expectSqliteWriteBudget({ budgetFile: "desktop-queued-agent-replacement-write-budgets.json", scenario: "durable-replacement",
        note: "Actual registered replacement cancels one original durable new_turn receipt before fresh transient admission; setup/native/receipt admission excluded", writes });
      replacementId = replacement.queueEntryId!;
      expect(replacementId).not.toBe(oldId);
      expect(await host.client.getTurnRequest({ ...identity, id: request.clientRequest.id })).toMatchObject({ queueEntryId: oldId, state: "completed", outcome: "cancelled" });
      expect(await host.client.submitTurnRequest(request)).toMatchObject({ queueEntryId: oldId, state: "completed", outcome: "cancelled" });
      await expect(host.client.readQueuedTurn({ ...identity, queueEntryId: oldId })).rejects.toThrow();
      expect(await host.client.readQueuedTurn({ ...identity, queueEntryId: replacementId })).toMatchObject({ input: [{ type: "text", text: "Fresh agent input" }] });
      // Explicit new_turn still waits on its original native turn; replacement
      // cannot acquire interrupt or steering ownership from that receipt.
      expect(host.providerSteerCount()).toBe(0);
      expect(await host.client.cancelQueuedTurn({ queueEntryId: oldId })).toMatchObject({ cancelled: false });
      await host.client.interruptTurn(active);
      await vi.waitFor(() => expect(OwnerConformanceCodexTransport.requests.filter(call => call.method === "turn/start")).toHaveLength(2));
      const prompts = OwnerConformanceCodexTransport.requests.filter(call => call.method === "turn/start")
        .flatMap(call => (call.params.input as Array<{ text?: string }>).map(item => item.text));
      expect(prompts).not.toContain("Original durable input");
      expect(prompts).toContain("Fresh agent input");
      await host.close();
      host = await startDesktopOwner(null, undefined, undefined, root);
      expect(OwnerConformanceCodexTransport.requests.filter(call => call.method === "turn/start")).toEqual([]);
      for (const queueEntryId of [oldId, replacementId]) await expect(host.client.readQueuedTurn({ ...identity, queueEntryId })).rejects.toThrow();
      expect(await host.client.submitTurnRequest(request)).toMatchObject({ queueEntryId: oldId, state: "completed", outcome: "cancelled" });
    } finally { await host.close(); await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs(); }
  });

  it("desktop replacement admission, stale retries and reads add no SQLite commits", async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const host = await startDesktopOwner();
    try {
      const identity = await host.client.startThread({ backend: "codex", cwd: host.workspace });
      const active = await host.client.startTurn({ ...identity, input: [{ type: "text", text: "slow" }] });
      const messageOrigin = { kind: "agent" as const, sourceThread: { backend: "codex" as const, threadId: "sender" } };
      let accepted = await host.client.startTurn({ ...identity, delivery: "new_turn", input: [{ type: "text", text: "Original accepted input" }], messageOrigin });
      for (let n = 0; n < 4; n++) await new Promise<void>(resolve => setImmediate(resolve));
      const { writes } = await measureSqliteWrites(async () => {
        for (let n = 0; n < 100; n++) {
          const oldId = accepted.queueEntryId!;
          accepted = await host.client.replaceQueuedMessage({ ...identity, queueEntryId: oldId, input: [{ type: "text", text: `Fresh input ${n}` }], messageOrigin });
          expect(accepted.queueEntryId).not.toBe(oldId);
          await expect(host.client.replaceQueuedMessage({ ...identity, queueEntryId: oldId, input: [{ type: "text", text: "Stale retry" }], messageOrigin })).rejects.toThrow();
          await host.client.readQueuedTurn({ ...identity, queueEntryId: accepted.queueEntryId! });
        }
        await host.client.cancelQueuedTurn({ queueEntryId: accepted.queueEntryId! });
        for (let n = 0; n < 4; n++) await new Promise<void>(resolve => setImmediate(resolve));
      });
      expectSqliteWriteBudget({ budgetFile: "desktop-queued-agent-replacement-write-budgets.json", scenario: "registered-replacement",
        note: "100 actual registered replacements, stale retries, immutable reads and final cancellation; native setup/admission excluded", writes });
      await host.client.interruptTurn(active);
    } finally { await host.close(); vi.unstubAllEnvs(); }
  });

  it("desktop federation admits every additional agent message under its own immutable queue identity", async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.tuple(fc.boolean(), fc.string({ minLength: 1, maxLength: 40 })),
      { minLength: 2, maxLength: 5 }), async messages => {
      const host = await startDesktopOwner();
      const registry = desktopOwner.registry as DesktopBackendRegistry;
      try {
        const identity = await host.client.startThread({ backend: "codex", cwd: host.workspace });
        const active = await host.client.startTurn({ ...identity, input: [{ type: "text", text: "slow" }] });
        await registry.submitHeldTurn({ ...identity, queueEntryId: "admission-review",
          input: [{ type: "text", text: "Explicit independent review" }], holdReason: "Review required" });
        const peer = { target: { scope: "remote" as const, instanceId: host.ownerInstanceId },
          label: "Invented owner", capabilities: ["thread_navigation", "turn_control"] };
        const handler = createFederatedThreadMessageHandler({ runtime: () => ({ connectedPeerTargets: () => [peer],
          remoteBackend: () => host.client }) as unknown as DesktopFederationRuntime });
        const accepted: Array<{ id: string; input: Array<{ type: "text"; text: string }>; snapshot: Awaited<ReturnType<FederationRemoteBackendClient["readQueuedTurn"]>> }> = [];
        for (const [bob, suffix] of messages) {
          const input = [{ type: "text" as const, text: `Invented ${bob ? "Bob" : "Alice"} acceptance ${suffix}` }];
          const response = (await handler({ backend: "codex", threadId: identity.threadId,
            instanceId: host.ownerInstanceId, input, messageOrigin: { kind: "agent",
              sourceThread: { backend: "codex", threadId: bob ? "bob" : "alice", instanceId: "sender" } } }))!;
          expect(response.queueStatus).toBe("queued");
          const snapshot = await host.client.readQueuedTurn({ ...identity, queueEntryId: response.queueEntryId! });
          accepted.push({ id: response.queueEntryId!, input, snapshot });
          expect(new Set(accepted.map(entry => entry.id)).size).toBe(accepted.length);
          for (const entry of accepted) {
            expect(await host.client.readQueuedTurn({ ...identity, queueEntryId: entry.id })).toEqual(entry.snapshot);
            expect(entry.snapshot.input).toEqual(entry.input);
          }
          expect((await host.client.getNavigationQueueProjection({ protocol: 2, ref: identity })).entries
            .map(entry => entry.queueEntryId)).toEqual(["admission-review", ...accepted.map(entry => entry.id)]);
        }
        expect(host.providerSteerCount()).toBe(0);
        await host.client.interruptTurn(active);
      } finally { await host.close(); }
    }), { numRuns: 12, examples: [[[[false, "!"], [true, "!"]]], [[[false, "!"], [false, "!"]]]] });
  });

  it("additional desktop admissions, reads and controls preserve acceptances without SQLite writes", async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const host = await startDesktopOwner();
    const registry = desktopOwner.registry as DesktopBackendRegistry;
    try {
      const identity = await host.client.startThread({ backend: "codex", cwd: host.workspace });
      const active = await host.client.startTurn({ ...identity, input: [{ type: "text", text: "slow" }] });
      await registry.submitHeldTurn({ ...identity, queueEntryId: "admission-budget-review",
        input: [{ type: "text", text: "Independent review" }], holdReason: "Review required" });
      const { writes } = await measureSqliteWrites(async () => {
        const accepted: Array<{ id: string; input: Array<{ type: "text"; text: string }> }> = [];
        for (let index = 0; index < 100; index++) {
          const input = [{ type: "text" as const, text: `Invented acceptance ${index}` }];
          const entry = await registry.submitTurn({ ...identity, input,
            messageOrigin: { kind: "agent", sourceThread: { backend: "codex", threadId: index % 2 ? "alice" : "bob" } } });
          accepted.push({ id: entry.entry.id, input });
        }
        expect(new Set(accepted.map(entry => entry.id)).size).toBe(100);
        for (const entry of accepted) {
          expect((await host.client.readQueuedTurn({ ...identity, queueEntryId: entry.id })).input).toEqual(entry.input);
          await registry.setQueuedTurnPaused({ queueEntryId: entry.id, paused: true });
          expect(registry.cancelQueuedTurnWithDisposition(entry.id).cancelled).toBe(true);
        }
      });
      expectSqliteWriteBudget({ budgetFile: "desktop-agent-admission-write-budgets.json", scenario: "individual-agent-admissions",
        note: "100 actual desktop agent admissions, immutable registered reads, pause and cancellation; native setup and independent review admission excluded", writes });
      await host.client.interruptTurn(active);
    } finally { await host.close(); vi.unstubAllEnvs(); }
  });

  it("additional real caller admissions preserve each owner's durable neighbor and original native controls", async () => {
    const desktop = await startDesktopOwner();
    let outpost: OwnerHost | undefined;
    try {
      outpost = await startOutpostOwner();
      for (const host of [desktop, outpost]) {
        const identity = await host.client.startThread({ backend: "codex", cwd: host.workspace });
        const active = await host.client.startTurn({ ...identity, input: [{ type: "text", text: "slow" }] });
        const target = { scope: "remote" as const, instanceId: host.ownerInstanceId };
        const runtime = Object.assign(new DesktopFederationRuntime(), {
          connectedPeerTargets: () => [{ target, capabilities: ["turn_control", "durable_turn_requests_v1", "thread_navigation"] }],
          remoteBackend: () => host.client,
        });
        const request: SubmitDurableTurnRequest = { clientRequest: { version: 1, id: randomUUID(), createdAt: Date.now(), payloadHash: "" },
          request: { backend: "codex", threadId: identity.threadId, input: [{ type: "text", text: "Immutable durable neighbor" }] } };
        request.clientRequest.payloadHash = createHash("sha256").update(canonicalDurableTurnRequest(host.ownerInstanceId, request)).digest("hex");
        const receipt = await runtime.submitDurableTurnRequest("admission-device", request, target);
        const durable = await host.client.readQueuedTurn({ ...identity, queueEntryId: receipt.queueEntryId });
        const handler = createFederatedThreadMessageHandler({ runtime: () => runtime });
        const accepted: Array<{ id: string; input: Array<{ type: "text"; text: string }> }> = [];
        for (const sender of ["alice", "bob", "alice"]) {
          const input = [{ type: "text" as const, text: `Invented ${sender} acceptance ${accepted.length}` }];
          const response = (await handler({ backend: "codex", threadId: identity.threadId, instanceId: host.ownerInstanceId, input,
            messageOrigin: { kind: "agent", sourceThread: { backend: "codex", threadId: sender } } }))!;
          accepted.push({ id: response.queueEntryId!, input });
        }
        expect(new Set(accepted.map(entry => entry.id)).size, host.name).toBe(3);
        expect(await host.client.readQueuedTurn({ ...identity, queueEntryId: receipt.queueEntryId })).toEqual(durable);
        expect(await runtime.submitDurableTurnRequest("admission-device", request, target)).toEqual(receipt);
        for (const entry of accepted) expect((await host.client.readQueuedTurn({ ...identity, queueEntryId: entry.id })).input).toEqual(entry.input);
        expect((await host.client.getNavigationQueueProjection({ protocol: 2, ref: identity })).entries.map(entry => entry.queueEntryId))
          .toEqual([receipt.queueEntryId, ...accepted.map(entry => entry.id)]);
        expect((await host.client.resolveThreadAdmissionState(identity)).activeTurn?.turnId).toBe(active.turnId);
        expect(host.providerSteerCount()).toBe(0);
        for (const entry of accepted) await host.client.cancelQueuedTurn({ queueEntryId: entry.id });
        expect(await host.client.readQueuedTurn({ ...identity, queueEntryId: receipt.queueEntryId })).toEqual(durable);
        await host.client.cancelQueuedTurn({ queueEntryId: receipt.queueEntryId });
        await host.client.interruptTurn(active);
      }
    } finally { await outpost?.close(); await desktop.close(); }
  });

  it("the production federated message caller replaces only its sender's waiting input on both registered owners", async () => {
    const desktop = await startDesktopOwner();
    let outpost: OwnerHost | undefined;
    try {
      outpost = await startOutpostOwner();
      for (const host of [desktop, outpost]) {
        const identity = await host.client.startThread({ backend: "codex", cwd: host.workspace });
        const active = await host.client.startTurn({ ...identity, input: [{ type: "text", text: "slow" }] });
        const peer = { target: { scope: "remote" as const, instanceId: "owner" }, label: "Invented owner", capabilities: ["thread_navigation", "turn_control"] };
        const handler = createFederatedThreadMessageHandler({ runtime: () => ({ connectedPeerTargets: () => [peer], remoteBackend: () => host.client }) as unknown as DesktopFederationRuntime });
        const request = { ...identity, instanceId: "owner", input: [{ type: "text" as const, text: "Invented original agent message" }],
          messageOrigin: { kind: "agent" as const, sourceThread: { backend: "codex" as const, threadId: "sender", instanceId: "forged" } } };
        const queued = (await handler(request))!;
        expect(queued.queueStatus).toBe("queued");
        const followupText = "Invented follow-up after the consolidated message";
        const followup = await host.client.startTurn({ ...identity, input: [{ type: "text", text: followupText }] });
        expect(followup.queueStatus).toBe("queued");
        await expect(handler({ ...request, replaceQueueEntryId: queued.queueEntryId, messageOrigin: { kind: "agent", sourceThread: { backend: "codex", threadId: "other", instanceId: "forged" } } })).rejects.toThrow("Only the sending thread");
        const changed = [{ type: "text" as const, text: "Invented consolidated agent message" }];
        const replacement = (await handler({ ...request, replaceQueueEntryId: queued.queueEntryId, input: changed }))!;
        expect(replacement.queueStatus).toBe("queued");
        expect(replacement.queueEntryId).not.toBe(queued.queueEntryId);
        await expect(host.client.readQueuedTurn({ ...identity, queueEntryId: queued.queueEntryId! })).rejects.toThrow();
        await expect(handler({ ...request, replaceQueueEntryId: queued.queueEntryId, input: changed })).rejects.toThrow();
        expect(await host.client.readQueuedTurn({ ...identity, queueEntryId: replacement.queueEntryId! })).toMatchObject({ input: changed, messageOrigin: { sourceThread: { threadId: "sender" } } });
        expect((await host.client.getNavigationQueueProjection({ protocol: 2, ref: identity })).entries.map(entry => entry.queueEntryId)).toEqual([replacement.queueEntryId, followup.queueEntryId]);
        await host.client.interruptTurn(active);
        await vi.waitFor(async () => {
          // These protocol fixtures retain assistant results, not user
          // transcript items. Their actual provider requests are the oracle.
          const calls = host.name === "desktop" ? OwnerConformanceCodexTransport.requests
            : readFileSync(path.resolve(host.workspace, "../f/calls.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
          const prompts = calls.filter(call => call.method === "turn/start" && call.params?.threadId === identity.threadId)
            .flatMap(call => (call.params.input as Array<{ text?: string }>).map(item => item.text ?? ""));
          expect(prompts.filter(text => text.includes(changed[0].text))).toHaveLength(1);
          expect(prompts.some(text => text.includes(request.input[0].text))).toBe(false);
          expect(prompts.filter(text => text.includes(changed[0].text) || text.includes(followupText)))
            .toEqual([changed[0].text, followupText]);
        });
      }
    } finally { await outpost?.close(); await desktop.close(); }
  }, 120_000);

  it("both registered owners read full queued input and fence edit cancellation before accepting a new identity", async () => {
    const desktop = await startDesktopOwner();
    let outpost: OwnerHost | undefined;
    try {
      outpost = await startOutpostOwner();
      for (const host of [desktop, outpost]) {
        const identity = await host.client.startThread({ backend: "codex", cwd: host.workspace });
        const active = await host.client.startTurn({ ...identity, input: [{ type: "text", text: "slow" }] });
        const prompt = `${"Invented Ω queued input. ".repeat(20)}Tail outside preview.`;
        const queued = await host.client.startTurn({ ...identity, queueEntryId: "original", input: [{ type: "text", text: prompt }] });
        const request = { ...identity, queueEntryId: queued.queueEntryId!, forEdit: true };
        const snapshot = await host.client.readQueuedTurn(request);
        expect(snapshot.input.map(item => item.type === "text" ? item.text : "").join("\n")).toBe(prompt);
        expect(snapshot.contentHash).toBe(createHash("sha256").update(JSON.stringify(snapshot.input)).digest("hex"));
        await expect(host.client.readQueuedTurn({ ...request, threadId: "other" })).rejects.toThrow();
        expect(await host.client.cancelQueuedTurn({ queueEntryId: queued.queueEntryId!, expectedContentHash: "stale" })).toMatchObject({ cancelled: false, disposition: "content_changed" });
        expect(await host.client.readQueuedTurn({ ...request, forEdit: false })).toMatchObject({ contentHash: snapshot.contentHash, input: snapshot.input });
        expect(await host.client.cancelQueuedTurn({ queueEntryId: queued.queueEntryId!, expectedContentHash: snapshot.contentHash })).toMatchObject({ cancelled: true, disposition: "cancelled" });
        await expect(host.client.readQueuedTurn(request)).rejects.toThrow();
        const replacement = await host.client.startTurn({ ...identity, queueEntryId: "replacement", input: [{ type: "text", text: `${prompt} edited` }] });
        expect(replacement.queueEntryId).not.toBe(queued.queueEntryId);
        const projection = await host.client.getNavigationQueueProjection({ protocol: 2, ref: identity });
        expect(projection.entries.map(entry => entry.queueEntryId)).toEqual([replacement.queueEntryId]);
        await host.client.cancelQueuedTurn({ queueEntryId: replacement.queueEntryId! });
        await host.client.interruptTurn(active);
      }
    } finally { await outpost?.close(); await desktop.close(); }
  }, 120_000);

  it("desktop pause publication never recreates a concurrently cancelled immutable waiting entry", async () => {
    const host = await startDesktopOwner();
    const registry = desktopOwner.registry as DesktopBackendRegistry;
    try {
      const identity = await host.client.startThread({ backend: "codex", cwd: host.workspace });
      const active = await host.client.startTurn({ ...identity, input: [{ type: "text", text: "slow" }] });
      let serial = 0;
      // The live owner FIFO is the oracle for the viewer's notification map.
      // Both pause and resume can yield after mutating a row that cancel retires.
      await fc.assert(fc.asyncProperty(fc.boolean(), fc.string({ maxLength: 80 }), async (initiallyPaused, text) => {
        const queueEntryId = `pause-cancel-${serial++}`;
        const input = [{ type: "text" as const, text: `Immutable waiting input ${text}` }];
        await host.client.startTurn({ ...identity, queueEntryId, delivery: "new_turn", input });
        if (initiallyPaused) await host.client.setQueuedTurnPaused({ queueEntryId, paused: true });
        const accepted = await host.client.readQueuedTurn({ ...identity, queueEntryId });
        const offset = host.events.length;
        const pause = registry.setQueuedTurnPaused({ queueEntryId, paused: !initiallyPaused });
        await Promise.resolve();
        expect(registry.cancelQueuedTurnWithDisposition(queueEntryId)).toMatchObject({ cancelled: true });
        await pause;
        await new Promise<void>(resolve => setImmediate(resolve));
        const statuses = host.events.slice(offset).flatMap(event => event.notification.method === "thread/turnQueue/updated"
          && event.notification.params.queueEntryId === queueEntryId ? [event.notification.params.status] : []);
        const waiting = (await host.client.getNavigationQueueProjection({ protocol: 2, ref: identity })).entries;
        expect(accepted.input).toEqual(input);
        expect(waiting).toEqual([]);
        expect(statuses.at(-1)).toBe("cancelled");
      }), { numRuns: 25 });
      await host.client.interruptTurn(active);
    } finally { await host.close(); }
  });

  it("desktop pause publication projects newer controls and independent holds from the actual FIFO", async () => {
    const host = await startDesktopOwner();
    const registry = desktopOwner.registry as DesktopBackendRegistry;
    const queue = (registry as unknown as { threadTurnQueue: ThreadTurnQueue }).threadTurnQueue;
    try {
      let serial = 0;
      await fc.assert(fc.asyncProperty(fc.boolean(), fc.constantFrom("cancel", "hold", "pause", "move"), fc.boolean(),
        async (initiallyPaused, control, rejectObserver) => {
          const identity = await host.client.startThread({ backend: "codex", cwd: host.workspace });
          const active = await host.client.startTurn({ ...identity, input: [{ type: "text", text: "slow" }] });
          const id = `live-pause-${serial++}`;
          const input = [{ type: "text" as const, text: `Immutable ${id}` }];
          await host.client.startTurn({ ...identity, queueEntryId: id, delivery: "new_turn", input });
          await host.client.startTurn({ ...identity, queueEntryId: `${id}-next`, delivery: "new_turn", input });
          if (initiallyPaused) await host.client.setQueuedTurnPaused({ queueEntryId: id, paused: true });
          const accepted = await host.client.readQueuedTurn({ ...identity, queueEntryId: id });
          const offset = host.events.length;
          const stopObserver = registry.onEvent(event => {
            if (rejectObserver && event.notification.method === "thread/turnQueue/updated"
              && event.notification.params.queueEntryId === id) throw new Error("Invented pause observer refusal");
          });
          try {
            const pause = registry.setQueuedTurnPaused({ queueEntryId: id, paused: !initiallyPaused });
            await Promise.resolve();
            if (control === "cancel") registry.cancelQueuedTurnWithDisposition(id);
            else if (control === "hold") {
              await queue.submitHeld({ ...identity, id: `${id}-review`, origin: "manual", input }, "first independent review");
              await queue.submitHeld({ ...identity, id: `${id}-lock`, origin: "manual", input }, "second independent lock");
            } else if (control === "pause") await registry.setQueuedTurnPaused({ queueEntryId: id, paused: initiallyPaused });
            else await host.client.moveQueuedTurn({ queueEntryId: `${id}-next`, beforeQueueEntryId: id });
            const response = await pause;
            await new Promise<void>(resolve => setImmediate(resolve));
            const authoritative = queue.getQueuedEntries(identity);
            const projection = (await host.client.getNavigationQueueProjection({ protocol: 2, ref: identity })).entries;
            expect(projection.map(row => row.queueEntryId)).toEqual(authoritative.map(row => row.id));
            const last = host.events.slice(offset).flatMap(event => event.notification.method === "thread/turnQueue/updated"
              && event.notification.params.queueEntryId === id ? [event.notification.params] : []).at(-1)!;
            const live = authoritative.find(row => row.id === id);
            if (live) {
              expect(last.status).toBe(live.manualReleaseRequired ? "held" : "queued");
              expect(Boolean(last.paused)).toBe(Boolean(live.paused));
              expect(last.pauseRevision ?? 0).toBe(live.pauseRevision ?? 0);
              expect(last.errorMessage).toBe(live.holdReason);
              expect((await host.client.readQueuedTurn({ ...identity, queueEntryId: id }))).toEqual(accepted);
              // The response acknowledges its mutation. The existing renderer
              // revision rule must preserve a newer event when that reply lands.
              const rows = [{ id, queueEntryId: id, paused: live.paused, pauseRevision: live.pauseRevision }];
              expect(withOwnerPauseState(rows, id, response) ?? rows).toEqual(rows);
            } else expect(last.status).toBe("cancelled");
            if (control === "hold") {
              await queue.releaseHold(identity, reason => reason === "second independent lock");
              expect(queue.getQueuedEntries(identity).every(row => row.manualReleaseRequired)).toBe(true);
            }
          } finally {
            stopObserver();
            for (const row of queue.getQueuedEntries(identity)) await host.client.cancelQueuedTurn({ queueEntryId: row.id });
            await host.client.interruptTurn(active);
          }
        }), { numRuns: 25, examples: [[false, "hold", false], [true, "pause", true], [true, "cancel", false]] });
    } finally { await host.close(); }
  });

  it.each([false, true])("desktop %s-paused cancellation remains terminal through the registered caller and shutdown", async initiallyPaused => {
    const root = await realpath(await mkdtemp("/tmp/pa-pause-reopen-"));
    const host = await startDesktopOwner(null, undefined, undefined, root);
    const registry = desktopOwner.registry as DesktopBackendRegistry;
    try {
      const identity = await host.client.startThread({ backend: "codex", cwd: host.workspace });
      await host.client.startTurn({ ...identity, input: [{ type: "text", text: "slow" }] });
      await host.client.startTurn({ ...identity, queueEntryId: "named-pause-cancel", delivery: "new_turn", input: [{ type: "text", text: "Immutable named input" }] });
      if (initiallyPaused) await host.client.setQueuedTurnPaused({ queueEntryId: "named-pause-cancel", paused: true });
      const offset = host.events.length;
      const pause = host.client.setQueuedTurnPaused({ queueEntryId: "named-pause-cancel", paused: !initiallyPaused });
      await Promise.resolve();
      registry.cancelQueuedTurnWithDisposition("named-pause-cancel");
      await pause;
      await new Promise<void>(resolve => setImmediate(resolve));
      const events = host.events.slice(offset).flatMap(event => event.notification.method === "thread/turnQueue/updated"
        && event.notification.params.queueEntryId === "named-pause-cancel" ? [event.notification.params.status] : []);
      expect(events.at(-1)).toBe("cancelled");
      expect((await host.client.getNavigationQueueProjection({ protocol: 2, ref: identity })).entries).toEqual([]);
      expect(OwnerConformanceCodexTransport.requests.filter(request => request.method === "turn/start")).toHaveLength(1);
    } finally { await host.close(); }
    const reopened = await startDesktopOwner(null, undefined, undefined, root);
    try { expect(OwnerConformanceCodexTransport.requests.filter(request => request.method === "turn/start")).toEqual([]); }
    finally { await reopened.close(); await rm(root, { recursive: true, force: true }); }
  });

  it("desktop live pause publication and cancellation make no SQLite commits", async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const host = await startDesktopOwner();
    const registry = desktopOwner.registry as DesktopBackendRegistry;
    try {
      const identity = await host.client.startThread({ backend: "codex", cwd: host.workspace });
      const active = await host.client.startTurn({ ...identity, input: [{ type: "text", text: "slow" }] });
      await host.client.startTurn({ ...identity, queueEntryId: "pause-budget", delivery: "new_turn", input: [{ type: "text", text: "Immutable budget input" }] });
      const accepted = await host.client.readQueuedTurn({ ...identity, queueEntryId: "pause-budget" });
      for (let n = 0; n < 4; n++) await new Promise<void>(resolve => setImmediate(resolve));
      const { writes } = await measureSqliteWrites(async () => {
        for (let n = 0; n < 100; n++) {
          await host.client.setQueuedTurnPaused({ queueEntryId: "pause-budget", paused: true });
          await host.client.setQueuedTurnPaused({ queueEntryId: "pause-budget", paused: false });
        }
        expect(await host.client.readQueuedTurn({ ...identity, queueEntryId: "pause-budget" })).toEqual(accepted);
        const pause = registry.setQueuedTurnPaused({ queueEntryId: "pause-budget", paused: true });
        await Promise.resolve();
        registry.cancelQueuedTurnWithDisposition("pause-budget");
        await pause;
        await new Promise<void>(resolve => setImmediate(resolve));
        expect((await host.client.getNavigationQueueProjection({ protocol: 2, ref: identity })).entries).toEqual([]);
      });
      expectSqliteWriteBudget({ budgetFile: "desktop-queue-pause-publication-write-budgets.json", scenario: "live-pause-cancel",
        note: "100 registered pause/resume pairs, immutable input read, concurrent pause/cancel and authoritative projection; native setup/admission excluded", writes });
      await host.client.interruptTurn(active);
    } finally { await host.close(); vi.unstubAllEnvs(); }
  });

  it("both actual owners pause, reorder and resume the same waiting FIFO with typed events", async () => {
    const desktop = await startDesktopOwner();
    let outpost: OwnerHost | undefined;
    try {
      outpost = await startOutpostOwner();
      for (const host of [desktop, outpost]) {
        const identity = await host.client.startThread({ backend: "codex", cwd: host.workspace });
        const active = await host.client.startTurn({ ...identity, input: [{ type: "text", text: "slow" }] });
        const entries = [];
        for (let n = 0; n < 3; n++) entries.push(await host.client.startTurn({ ...identity, queueEntryId: `order-${n}`, input: [{ type: "text", text: "slow" }] }));
        const ids = entries.map(entry => entry.queueEntryId!);
        const request = { protocol: 2 as const, ref: { backend: "codex" as const, threadId: identity.threadId } };
        const nextTurn = async (previousTurnId: string) => {
          await expect.poll(async () => {
            const turnId = (await host.client.resolveThreadAdmissionState(request.ref)).activeTurn?.turnId;
            return Boolean(turnId && turnId !== previousTurnId);
          }).toBe(true);
          return { ...identity, turnId: (await host.client.resolveThreadAdmissionState(request.ref)).activeTurn!.turnId };
        };
        expect(await host.client.setQueuedTurnPaused({ queueEntryId: ids[0]!, paused: true })).toMatchObject({ disposition: "updated", paused: true, pauseRevision: 1 });
        expect(await host.client.moveQueuedTurn({ queueEntryId: ids[2]!, beforeQueueEntryId: ids[1]! })).toEqual({ queueEntryId: ids[2], disposition: "moved", queueEntryIds: [ids[0], ids[2], ids[1]] });
        const queue = await host.client.getNavigationQueueProjection(request);
        expect(queue.entries.map(entry => entry.queueEntryId)).toEqual([ids[0], ids[2], ids[1]]);
        expect(queue.entries[0]).toMatchObject({ paused: true, pauseRevision: 1 });
        await expect.poll(() => host.events.some(event => event.notification.method === "thread/turnQueue/reordered")).toBe(true);
        await host.client.interruptTurn(active);
        await expect.poll(async () => (await host.client.getNavigationQueueProjection(request)).entries.map(entry => entry.queueEntryId)).toEqual([ids[0], ids[1]]);
        let turn = await nextTurn(active.turnId);
        await host.client.interruptTurn(turn);
        await expect.poll(async () => (await host.client.getNavigationQueueProjection(request)).entries.map(entry => entry.queueEntryId)).toEqual([ids[0]]);
        turn = await nextTurn(turn.turnId);
        expect(await host.client.setQueuedTurnPaused({ queueEntryId: ids[0]!, paused: false })).toMatchObject({ disposition: "updated", paused: false, pauseRevision: 2 });
        await host.client.interruptTurn(turn);
        await expect.poll(async () => (await host.client.getNavigationQueueProjection(request)).entries).toEqual([]);
        turn = await nextTurn(turn.turnId);
        await host.client.interruptTurn(turn);
      }
    } finally { await outpost?.close(); await desktop.close(); }
  }, 120_000);
  it("queues generated continued turns through both actual owners and projects their provider-owned dispatch order", async () => {
    const desktop = await startDesktopOwner();
    let outpost: OwnerHost | undefined;
    try {
      outpost = await startOutpostOwner();
      for (const host of [desktop, outpost]) {
        const identity = await host.client.startThread({ backend: "codex", cwd: host.workspace, executionMode: "auto" });
        const active = await host.client.startTurn({ ...identity, input: [{ type: "text", text: "slow" }] });
        const count = fc.sample(fc.integer({ min: 1, max: 3 }), 1)[0]!;
        const accepted = [];
        for (let i = 0; i < count; i++) {
          accepted.push(await host.client.startTurn({ ...identity, queueEntryId: `waiting-${i}`, input: [{ type: "text", text: "slow" }] }));
        }
        expect(accepted.map(result => result.queueStatus)).toEqual(Array(count).fill("queued"));
        const request = { protocol: 2 as const, ref: { backend: "codex" as const, threadId: identity.threadId } };
        const queue = await host.client.getNavigationQueueProjection(request);
        expect(queue.entries.map(entry => entry.queueEntryId)).toEqual(accepted.map(result => result.queueEntryId));
        expect(queue.entries.map(entry => entry.position)).toEqual(Array.from({ length: count }, (_, i) => i));
        expect((await host.client.getNavigationQueueProjection({ ...request, knownRevision: queue.revision })).unchanged).toBe(true);
        let turn = active;
        for (let i = 0; i < count; i++) {
          await host.client.interruptTurn(turn);
          await expect.poll(async () => {
            const next = (await host.client.resolveThreadAdmissionState(request.ref)).activeTurn?.turnId;
            return Boolean(next && next !== turn.turnId);
          }).toBe(true);
          const next = (await host.client.resolveThreadAdmissionState(request.ref)).activeTurn;
          expect(next?.turnId).toBeTruthy();
          turn = { ...identity, turnId: next!.turnId };
          expect((await host.client.getNavigationQueueProjection(request)).entries).toHaveLength(count - i - 1);
        }
        await host.client.interruptTurn(turn);
      }
    } finally { await outpost?.close(); await desktop.close(); }
  }, 120_000);
  it("both actual owners release held input and cancel waiting entries without interrupting admitted provider turns", async () => {
    const desktop = await startDesktopOwner();
    let outpost: OwnerHost | undefined;
    try {
      outpost = await startOutpostOwner();
      for (const host of [desktop, outpost]) {
        const identity = await host.client.startThread({ backend: "codex", cwd: host.workspace });
        const active = await host.client.startTurn({ ...identity, input: [{ type: "text", text: "slow" }] });
        await host.client.startTurn({ ...identity, queueEntryId: "failure", input: [{ type: "text", text: "fail" }] });
        const waiting = await host.client.startTurn({ ...identity, queueEntryId: "waiting", input: [{ type: "text", text: "slow" }] });
        const deleted = await host.client.startTurn({ ...identity, queueEntryId: "deleted", input: [{ type: "text", text: "deleted" }] });
        expect(await host.client.cancelQueuedTurn({ queueEntryId: deleted.queueEntryId! })).toMatchObject({ cancelled: true, disposition: "cancelled" });
        expect(await host.client.cancelQueuedTurn({ queueEntryId: active.queueEntryId! })).toMatchObject({ cancelled: false, disposition: "already_admitted", turnId: active.turnId });
        await host.client.interruptTurn(active);
        const request = { protocol: 2 as const, ref: { backend: "codex" as const, threadId: identity.threadId } };
        await expect.poll(async () => (await host.client.getNavigationQueueProjection(request)).entries[0]?.manualReleaseRequired).toBe(true);
        const released = await host.client.releaseQueuedTurn({ queueEntryId: waiting.queueEntryId! });
        expect(released).toMatchObject({ disposition: "started" });
        expect(await host.client.cancelQueuedTurn({ queueEntryId: waiting.queueEntryId! })).toMatchObject({ cancelled: false, disposition: "already_admitted", turnId: released.turnId });
        expect(await host.client.releaseQueuedTurn({ queueEntryId: waiting.queueEntryId! })).toMatchObject({ disposition: "not_found" });
        expect((await host.client.getNavigationQueueProjection(request)).entries).toEqual([]);
        await host.client.interruptTurn({ ...identity, turnId: released.turnId! });
      }
    } finally { await outpost?.close(); await desktop.close(); }
  }, 120_000);
  it("both actual owners name first turns through the supported restricted Codex helper without exposing ephemeral threads", async () => {
    const title = "Repair login regression";
    const desktop = await startDesktopOwner(null, undefined, undefined, undefined, title);
    const outpost = await startConformanceDaemon({ capabilities: VIEWER_CAPABILITIES });
    await writeFile(path.join(outpost.env.PWRAGENT_TEST_DATA!, "helper-title.json"), JSON.stringify({ title }));
    try {
      for (const host of [desktop, outpost]) {
        const ref = { backend: "codex" as const, threadId: (await host.client.startThread({ backend: "codex", cwd: host.workspace })).threadId };
        const first = await host.client.startTurn({ ...ref, input: [{ type: "text", text: "Please fix the login test" }] });
        await vi.waitFor(async () => expect((await host.client.resolveThread(ref)).thread).toMatchObject({ title, titleSource: "derived" }));
        await vi.waitFor(async () => expect((await host.client.readThread(ref)).replay.lastAssistantMessage).toBe("Fixture result"));
        await host.client.renameThread({ ...ref, name: "Operator title" });
        await host.client.startTurn({ ...ref, input: [{ type: "text", text: "A later message" }] });
        expect((await host.client.resolveThread(ref)).thread).toMatchObject({ title: "Operator title", titleSource: "explicit" });
        const listing = await host.client.getNavigationQueryPage({ protocol: 2, consumer: "remote-window", query: { kind: "lens", lens: "inbox" } });
        expect(listing.entries?.map(entry => entry.row.id)).toEqual([ref.threadId]);
        expect(first.turnId).not.toMatch(/^helper/);
      }
      const desktopCalls = OwnerConformanceCodexTransport.requests;
      const outpostCalls = readFileSync(path.join(outpost.env.PWRAGENT_TEST_DATA!, "calls.jsonl"), "utf8").trim().split("\n")
        .map(line => JSON.parse(line) as { method: string; params?: Record<string, unknown> });
      for (const calls of [desktopCalls, outpostCalls]) {
        const helpers = calls.filter(call => call.method === "thread/start" && call.params?.ephemeral === true);
        expect(helpers).toHaveLength(1);
        expect(helpers[0].params).toMatchObject({ config: {
          project_doc_max_bytes: 0, features: { hooks: false }, notify: [],
        } });
        expect(helpers[0].params?.dynamicTools).toBeUndefined();
        expect(calls.filter(call => call.method === "thread/unsubscribe")).toHaveLength(1);
      }
      expect(outpostCalls.find(call => call.method === "thread/start" && call.params?.ephemeral === true)?.params)
        .toMatchObject({ approvalPolicy: "never", permissions: "pwragent-outpost-read-only" });
      const helperTurn = outpostCalls.find(call => call.method === "turn/start" && String(call.params?.threadId).startsWith("helper-"))?.params;
      // The Outpost's profiles deny its own state; a legacy sandbox could not.
      expect(helperTurn).toMatchObject({ approvalPolicy: "never", permissions: "pwragent-outpost-read-only" });
      expect(helperTurn).not.toHaveProperty("sandboxPolicy");
    } finally { await outpost.close(); await desktop.close(); }
  });


  it("projects canonical title provenance until a confirmed native name changes", async () => {
    await fc.assert(fc.asyncProperty(fc.stringMatching(/^[A-Z][a-z]{0,12}$/), fc.constantFrom("pending", "acknowledged", "external"), async (suffix, state) => {
      const nativeName = `Native ${suffix}`;
      const ownerName = state === "pending" ? `Imported ${suffix}` : state === "external" ? `Previous ${suffix}` : nativeName;
      const host = await startDesktopOwner(null, async (db, workspace) => {
        OwnerConformanceCodexTransport.threads.set("imported", { id: "imported", name: nativeName, preview: "", cwd: workspace, createdAt: 1, updatedAt: 1, turns: [] });
        await new SqliteOverlayStore(db).updateThreadMetadata({ backend: "codex", threadId: "imported" }, {
          title: { text: ownerName, source: "derived", ...(state !== "pending" ? { nativeName: ownerName } : {}) },
        });
      });
      try {
        const thread = (await host.client.getNavigationSelectedDetail({ protocol: 2, ref: { backend: "codex", threadId: "imported" } })).thread;
        expect(thread).toMatchObject(state === "external" ? { title: nativeName, titleSource: "explicit" } : { title: ownerName, titleSource: "derived" });
        await host.client.renameThread({ backend: "codex", threadId: "imported", name: `Operator ${suffix}`, expectedName: thread!.title });
        expect((await host.client.getNavigationSelectedDetail({ protocol: 2, ref: { backend: "codex", threadId: "imported" } })).thread)
          .toMatchObject({ title: `Operator ${suffix}`, titleSource: "explicit" });
      } finally { await host.close(); }
    }), { numRuns: 12 });
  });



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

  it("keeps generated steering responses and duplicate native delivery equal across both actual owners", async () => {
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
        const outpostBefore = outpost.providerSteerCount();
        for (let failure = 0; failure < command.failures; failure += 1) {
          retain.mockRejectedValueOnce(new Error("Fixture attachment retention failed"));
          const attempts = await Promise.allSettled(Array.from({ length: command.copies }, () => desktop.client.steerTurn(requests[0])));
          expect(attempts.map((attempt) => attempt.status)).toEqual(Array(command.copies).fill("rejected"));
          expect(OwnerConformanceCodexTransport.requests.filter((item) => item.method === "turn/steer")).toHaveLength(before + 1);
        }
        const [desktopResults, outpostResults] = await Promise.all([
          Promise.all(Array.from({ length: command.copies }, () => desktop.client.steerTurn(requests[0]))),
          Promise.all(Array.from({ length: command.copies }, () => outpost!.client.steerTurn(requests[1]))),
        ]);
        for (const [index, results] of [[0, desktopResults], [1, outpostResults]] as const) {
          for (const result of results) expect(result).toEqual({ backend: "codex", threadId: turns[index].threadId,
            turnId: turns[index].turnId, disposition: "steered" });
        }
        for (const [index, host] of hosts.entries()) {
          await expect(host.client.steerTurn({ ...requests[index], input: [{ type: "text", text: "Changed input" }] }))
            .rejects.toThrow("reused with different input");
        }
        expect(OwnerConformanceCodexTransport.requests.filter((item) => item.method === "turn/steer")).toHaveLength(before + 1);
        expect(outpost.providerSteerCount()).toBe(outpostBefore + 1);
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

  it("rolls back rejected desktop preparation before later desktop and Outpost creations", async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const desktop = await startDesktopOwner();
    let outpost: OwnerHost | undefined;
    const git = (...args: string[]) => execFileSync("git", ["-C", desktop.workspace, ...args], { encoding: "utf8" });
    const effects: string[] = [];
    const registry = desktopOwner.registry as DesktopBackendRegistry;
    const internal = registry as unknown as {
      gitDirectoryService: { prepareLaunchpadWorkspace: () => Promise<unknown> };
      readConfiguredCodexMcpServerNames: () => Promise<string[] | undefined>;
      registerMcpConnections: (ids: string[] | undefined) => Promise<unknown[]>;
    };
    let workspaceIndex = 0;
    let grants = 1;
    const workspaces: string[] = [];
    vi.spyOn(internal.gitDirectoryService, "prepareLaunchpadWorkspace").mockImplementation(async () => {
      const cwd = path.join(desktop.workspace, `checkout-${++workspaceIndex}`);
      git("worktree", "add", "--detach", cwd);
      workspaces.push(cwd);
      return { cwd, workMode: "worktree", rollback: async () => { effects.push("rollback"); git("worktree", "remove", cwd); } };
    });
    const inventory = vi.spyOn(internal, "readConfiguredCodexMcpServerNames");
    vi.spyOn(internal, "registerMcpConnections").mockImplementation(async (ids) => ids?.length ? Array.from({ length: grants }, (_, i) => ({
      server: { name: `fixture-${i}`, command: "/fixture/mcp", args: [], env: {} },
      bindThread: () => { effects.push(`bind:${i}`); },
      revoke: () => { effects.push(`revoke:${i}`); if (i === 0) throw new Error("fixture grant cleanup refused"); },
    })) : []);
    try {
      git("init", "-b", "main");
      git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "Fixture repository");
      outpost = await startOutpostOwner();
      for (const count of [2, ...fc.sample(fc.integer({ min: 1, max: 3 }), 2)]) {
        grants = count;
        effects.length = 0;
        inventory.mockResolvedValueOnce(undefined);
        const before = OwnerConformanceCodexTransport.requests.filter((request) => request.method === "thread/start").length;
        const { writes } = await measureSqliteWrites(async () => {
          await expect(desktop.client.startThread({ backend: "codex", cwd: desktop.workspace, workMode: "worktree",
            mcpConnectionIds: ["fixture"], mcpProviderServersEnabled: false })).rejects.toThrow();
        });
        expect(writes).toMatchObject({ commits: 0, statements: 0, rowsChanged: 0 });
        expect(effects).toEqual([...Array.from({ length: count }, (_, i) => `revoke:${i}`), "rollback"]);
        expect(workspaces.every((cwd) => !existsSync(cwd))).toBe(true);
        expect(git("worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
        expect(OwnerConformanceCodexTransport.requests.filter((request) => request.method === "thread/start")).toHaveLength(before);
        const hosts = [desktop, outpost];
        const created = await Promise.all(hosts.map((host) => host.client.startThread({ backend: "codex", cwd: host.workspace, executionMode: "auto" })));
        const turns = await Promise.all(hosts.map((host, i) => host.client.startTurn({ backend: "codex", threadId: created[i].threadId, input: [{ type: "text", text: "slow" }] })));
        expect(turns[0]).toMatchObject({ threadId: created[0].threadId, turnId: turns[1].turnId });
        await Promise.all(hosts.map((host, i) => host.client.interruptTurn(turns[i])));
        await Promise.all(hosts.map(settle));
      }
    } finally {
      await outpost?.close();
      await desktop.close();
      vi.unstubAllEnvs();
    }
  }, 120_000);

  it("preserves provider-created identities through real desktop metadata refusal and subsequent turns", async () => {
    let db!: StateDb;
    const desktop = await startDesktopOwner(null, async (state) => { db = state; });
    let outpost: OwnerHost | undefined;
    try {
      outpost = await startOutpostOwner();
      const overlay = new SqliteOverlayStore(db);
      const failures = [true, false, ...fc.sample(fc.boolean(), 3)];
      for (const fails of failures) {
        if (fails) db.raw.exec(`CREATE TRIGGER reject_creation_pr BEFORE INSERT ON threads
          WHEN json_extract(NEW.payload, '$.backend') = 'codex'
            AND json_type(NEW.payload, '$.prAutoDispatchEnabled') IS NOT NULL
          BEGIN SELECT RAISE(ABORT, 'Fixture creation PR metadata refused'); END`);
        const before = OwnerConformanceCodexTransport.requests.filter((request) => request.method === "thread/start").length;
        const created = await Promise.all([desktop, outpost].map((host) => host.client.startThread({
          backend: "codex", cwd: host.workspace, executionMode: "auto",
        })));
        for (const result of created) expect(result).toMatchObject({ backend: "codex", threadId: expect.any(String) });
        expect(OwnerConformanceCodexTransport.requests.filter((request) => request.method === "thread/start")).toHaveLength(before + 1);
        expect(OwnerConformanceCodexTransport.threads.has(created[0].threadId)).toBe(true);
        expect((await overlay.getThreadOverlayState({ backend: "codex", threadId: created[0].threadId }))?.executionMode).toBe("auto");
        if (fails) {
          expect((await overlay.getThreadOverlayState({ backend: "codex", threadId: created[0].threadId }))?.prAutoDispatchEnabled).toBeUndefined();
          db.raw.exec("DROP TRIGGER reject_creation_pr");
        }
        const turns = await Promise.all([desktop, outpost].map((host, i) => host.client.startTurn({
          backend: "codex", threadId: created[i].threadId, input: [{ type: "text", text: "slow" }],
        })));
        expect(turns[0]).toMatchObject({ threadId: created[0].threadId, turnId: turns[1].turnId });
        await Promise.all([desktop, outpost].map((host, i) => host.client.interruptTurn(turns[i])));
        await Promise.all([desktop, outpost].map(settle));
        const read = await desktop.client.readThread({ backend: "codex", threadId: created[0].threadId });
        expect(read).toBeDefined();
      }
    } finally {
      await outpost?.close();
      await desktop.close();
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

  it("preserves real Claude acceptance, session-owned grants and subsequent starts through origin-port rejection", async () => {
    const desktop = await startDesktopOwner(null, async (_db, workspace) => {
      await writeFile(path.join(workspace, "claude.js"), readFileSync(path.join(process.cwd(),
        "apps/desktop/src/main/__tests__/fixtures/claude-owner-cli.cjs")));
    }, (workspace) => ({
      store: new ClaudeSessionStore(path.join(workspace, "sessions")),
      inspectInstallation: async () => ({ executable: path.join(workspace, "claude.js"), authStatus: "signed-in" }),
      discoverModels: async () => [], readCommands: async () => [], readMcpServers: async () => [],
      getSessionInfo: async () => undefined,
    }));
    try {
      const registry = desktopOwner.registry as DesktopBackendRegistry;
      const internal = registry as unknown as {
        persistStartingTurnOrigin: () => Promise<void>;
        startingTurnOrigins: Set<unknown>;
        registerMcpConnections: () => Promise<Array<{ server: { name: string; command: string; args: string[]; env: Record<string, string> };
          bindThread: () => void; revoke: () => void }>>;
      };
      const grants: Array<{ held: boolean }> = [];
      vi.spyOn(internal, "registerMcpConnections").mockImplementation(async () => {
        const grant = { held: true }; grants.push(grant);
        return [{ server: { name: "fixture", command: "/fixture/mcp", args: [], env: {} }, bindThread: () => {},
          revoke: () => { expect(grant.held).toBe(true); grant.held = false; } }];
      });
      const persist = internal.persistStartingTurnOrigin.bind(registry);
      let reject = false;
      vi.spyOn(internal, "persistStartingTurnOrigin").mockImplementation(async () => {
        if (reject) throw new Error("Fixture Claude accepted origin port rejected");
        await persist();
      });
      const { threadId } = await desktop.client.startThread({ backend: "claude", cwd: desktop.workspace, executionMode: "auto" });
      const commands = [true, false, ...fc.sample(fc.boolean(), 3)];
      for (const [index, fails] of commands.entries()) {
        reject = fails;
        let turn: Awaited<ReturnType<typeof desktop.client.startTurn>>;
        try {
          turn = await desktop.client.startTurn({ backend: "claude", threadId,
            input: [{ type: "text", text: `Claude fixture ${index}` }], messageOrigin: { kind: "messaging" } });
          expect(turn).toMatchObject({ backend: "claude", threadId, turnId: expect.any(String) });
          expect(internal.startingTurnOrigins.size).toBe(0);
          expect(grants.at(-1)?.held).toBe(true);
          // A second invocation while this session is live refuses without
          // revoking either grant. The backend owns both release callbacks.
          await expect(registry.startTurn({ backend: "claude", threadId,
            input: [{ type: "text", text: "Refuse while active" }] })).rejects.toThrow("already active");
          expect(grants.slice(-2).every((grant) => grant.held)).toBe(true);
          await vi.waitFor(() => expect(readFileSync(path.join(desktop.workspace, "claude-requests.jsonl"), "utf8")
            .trim().split("\n")).toHaveLength(index + 1));
        } finally {
          // This fixture owns provider completion even when the acceptance
          // assertion fails on old production code. Drain it before close.
          await writeFile(path.join(desktop.workspace, `release-${index + 1}`), "");
          await vi.waitFor(() => expect(desktop.events.filter((event) => event.backend === "claude"
            && event.notification.method === "turn/completed")).toHaveLength(index + 1));
          await vi.waitFor(() => expect(grants.every((grant) => !grant.held)).toBe(true));
        }
        expect(desktop.events.filter((event) => event.notification.method === "turn/failed")).toEqual([]);
        expect(desktop.events.filter((event) => event.notification.method === "turn/completed"
          && event.notification.params.turnId === turn.turnId)).toHaveLength(1);
        expect(registry.getActiveTurnForThread({ backend: "claude", threadId })).toBeUndefined();
      }
    } finally { await desktop.close(); }
  });

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
            expect(lifecycle.map((notification) => notification.method)).toEqual(["turn/started", "turn/completed"]);
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

  it("generated read, model, rename and seen histories agree with the desktop owner oracle", async () => {
    const desktop = await startOutpostOwner("desktop");
    let outpost: OwnerHost | undefined;
    try {
      outpost = await startOutpostOwner();
      const hosts = [desktop, outpost];
      const refs = await Promise.all(hosts.map(async host => ({ backend: "codex" as const,
        threadId: (await host.client.startThread({ backend: "codex", cwd: host.workspace, executionMode: "auto", model: "gpt-5.5", reasoningEffort: "medium" })).threadId })));
      await Promise.all(hosts.map(settle));
      for (const [index, host] of hosts.entries()) {
        const created = host.events.filter(event => event.notification.method === "thread/started"
          && (event.notification.params.threadId ?? (event.notification.params.thread as { id?: string } | undefined)?.id) === refs[index]!.threadId);
        expect(created, `${host.name} announces creation once`).toHaveLength(1);
      }
      // The owner, rather than the viewer, supplies every row and its unread watermark.
      await fc.assert(fc.asyncProperty(fc.array(fc.record({
        kind: fc.constantFrom("rename", "model", "read", "unread", "activity"), value: fc.integer({ min: 0, max: 10000 }),
      }), { minLength: 1, maxLength: 8 }), async operations => {
        for (const operation of operations) {
          for (const [index, host] of hosts.entries()) {
            const ref = refs[index]!;
            if (operation.kind === "rename") await host.client.renameThread({ ...ref, name: `Oracle ${operation.value}` });
            else if (operation.kind === "model") await host.client.setThreadModelSettings({ ...ref, model: "gpt-5.5", reasoningEffort: operation.value % 2 ? "high" : "medium" });
            else {
              const detail = await host.client.getNavigationSelectedDetail({ protocol: 2, ref });
              const updatedAt = detail.thread!.updatedAt!;
              await host.client.markThreadSeen({ ...ref, seenAt: Date.now(),
                ...(operation.kind === "activity" ? {} : { seenUpdatedAt: operation.kind === "unread" ? Math.max(0, updatedAt - 1) : updatedAt }) });
            }
          }
          const details = await Promise.all(hosts.map((host, index) => host.client.getNavigationSelectedDetail({ protocol: 2, ref: refs[index]! })));
          const values = details.map(({ thread }) => ({ title: thread!.title, titleSource: thread!.titleSource,
            model: thread!.model, reasoningEffort: thread!.reasoningEffort, executionMode: thread!.executionMode,
            inInbox: thread!.inbox.inInbox, reason: thread!.inbox.reason }));
          expect(values[1]).toEqual(values[0]);
        }
      }), { numRuns: 5 });
      for (const [index, host] of hosts.entries()) {
        await host.client.renameThread({ ...refs[index]!, name: "PWR139 searchable owner" });
        const found = await host.client.searchFederatedThreads({ query: "searchable owner", limit: 20 });
        expect(found.threads.map(thread => thread.id), host.name).toContain(refs[index]!.threadId);
        const excluded = await host.client.searchFederatedThreads({ query: "searchable owner", projectKeys: ["/invented-other-project"], limit: 20 });
        expect(excluded.threads, host.name).toEqual([]);
      }
    } finally { await outpost?.close(); await desktop.close(); }
  }, 120_000);

  it("headless attention ranks count each admitted turn once across provisional and native identity", async () => {
    await fc.assert(fc.asyncProperty(fc.boolean(), fc.nat(4), async (promoteOnTurnEnd, duplicates) => {
      const host = await startConformanceDaemon({ capabilities: VIEWER_CAPABILITIES });
      host.subscribe(EVENT_CLASSES);
      try {
        const attentionView = { id: `provisional-${randomUUID()}`, promoteOnTurnEnd };
        const page = () => host.client.getNavigationQueryPage({ protocol: 2, consumer: "remote-window",
          query: { kind: "lens", lens: "attention" }, attentionView });
        await page();
        const ref = { backend: "codex" as const, threadId: (await host.client.startThread({ backend: "codex", cwd: host.workspace, executionMode: "auto" })).threadId };
        const baseline = await page();
        const nextRank = Math.max(0, ...baseline.entries.map(entry => entry.attentionRank ?? 0)) + 1;
        const turn = await host.client.startTurn({ ...ref, input: [{ type: "text", text: "slow" }] });
        const active = (await page()).entries.find(entry => entry.row.id === ref.threadId)!;
        expect(active.attentionRank).toBe(nextRank);
        for (let duplicate = 0; duplicate <= duplicates; duplicate++) {
          await host.client.readThread(ref);
          expect((await page()).entries.find(entry => entry.row.id === ref.threadId)?.attentionRank).toBe(nextRank);
        }
        await host.client.interruptTurn({ ...ref, turnId: turn.turnId! });
        await host.waitForEvent("turn/completed", event => (event.notification.params as { turn?: { id?: string } }).turn?.id === turn.turnId);

      } finally { await host.close(); }
    }), { numRuns: 4 });
  }, 120_000);

  it("fresh desktop and headless owner roots conform strictly across the whole thread lifecycle", async () => {
    const desktop = await startOutpostOwner("desktop");
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
      await Promise.all([desktop, outpost].map(awaitStartupProviderRefresh));
      const desktopRecords = await runScenario(desktop, FIRST_PROMPT_SCENARIO);
      const outpostRecords = await runScenario(outpost, FIRST_PROMPT_SCENARIO);
      const measured: OwnerConformanceBaseline = {
        sharedMethods: [...outpost.methods].filter((method) => desktop.methods.has(method)).sort(),
        differences: desktopRecords.flatMap((record, index) => compareStep(record, outpostRecords[index]!)),
      };
      expect(measured.differences).toEqual([]);
      if (process.env.UPDATE_OWNER_CONFORMANCE === "1") {
        writeFileSync(BASELINE_PATH, JSON.stringify(measured, null, 2) + "\n");
        return;
      }
      const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as OwnerConformanceBaseline;
      expect(measured.sharedMethods).toEqual(baseline.sharedMethods);

    } finally {
      await outpost?.close();
      await desktop.close();
    }
  }, 120_000);
});

it("the actual desktop federated caller retains untouched senders' original replacement handles", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom("alice", "bob"), { minLength: 2, maxLength: 6 }), async edits => {
    const host = await startDesktopOwner();
    const registry = desktopOwner.registry as DesktopBackendRegistry;
    try {
      const created = await host.client.startThread({ backend: "codex", cwd: host.workspace });
      const identity = { backend: "codex" as const, threadId: created.threadId };
      await host.client.startTurn({ ...identity, input: [{ type: "text", text: "slow" }] });
      await registry.submitHeldTurn({ ...identity, queueEntryId: "handle-review", input: [{ type: "text", text: "Independent review" }], holdReason: "Independent review" });
      const peer = { target: { scope: "remote" as const, instanceId: "owner" }, label: "Invented owner", capabilities: ["thread_navigation", "turn_control"] };
      const handler = createFederatedThreadMessageHandler({ runtime: () => ({ connectedPeerTargets: () => [peer], remoteBackend: () => host.client }) as unknown as DesktopFederationRuntime });
      const request = (sender: string, text: string, replaceQueueEntryId?: string) => ({ ...identity, instanceId: "owner",
        input: [{ type: "text" as const, text }], ...(replaceQueueEntryId ? { replaceQueueEntryId } : {}),
        messageOrigin: { kind: "agent" as const, sourceThread: { backend: "codex" as const, threadId: sender } } });
      const handles = new Map<string, string>();
      // Seed a legacy batch; new production messages have individual identities.
      const queue = (registry as unknown as { threadTurnQueue: ThreadTurnQueue }).threadTurnQueue;
      for (const sender of ["alice", "bob"]) {
        const accepted = await queue.submitGroupedSteer({ ...identity, origin: "manual",
          input: [{ type: "text", text: `Original ${sender}` }], messageOrigin: authenticateMessageOrigin({
            messageOrigin: request(sender, "").messageOrigin, sourceInstanceId: "viewer" }) });
        handles.set(sender, accepted.entry.id);
      }
      expect(handles.get("alice")).toBe(handles.get("bob"));
      const { writes } = await measureSqliteWrites(async () => {
        for (const [index, sender] of edits.entries()) {
          const oldId = handles.get(sender)!;
          const replacement = (await handler(request(sender, `${sender} revised ${index}`, oldId)))!;
          expect(replacement.queueEntryId).not.toBe(oldId);
          handles.set(sender, replacement.queueEntryId!);
          await expect(host.client.readQueuedTurn({ ...identity, queueEntryId: oldId })).rejects.toThrow();
          expect(await host.client.cancelQueuedTurn({ queueEntryId: oldId })).toMatchObject({ cancelled: false });
          const queued = await host.client.readQueuedTurn({ ...identity, queueEntryId: replacement.queueEntryId! });
          expect(queued.input.flatMap(item => item.type === "text" ? [item.text] : []).join("\n")).toContain(`${sender} revised ${index}`);
        }
        for (let n = 0; n < 4; n++) await new Promise<void>(resolve => setImmediate(resolve));
      });
      expectSqliteWriteBudget({ budgetFile: "desktop-replacement-review-write-budgets.json", scenario: "untouched-sender-handles",
        note: "Actual registered desktop and real SQLite; peer replacements and stale-handle reads/cancellation refusals; setup excluded", writes });
      expect(OwnerConformanceCodexTransport.requests.filter(request => request.method === "turn/start")).toHaveLength(1);
    } finally { await host.close(); }
  }), { numRuns: 3, examples: [[["alice", "bob", "alice"]]] });
});
