import { LocalOwnerNavigationTransport } from "../federation/local-owner-navigation-transport";
import fc from "fast-check";
import { ThreadTitleGenerationService } from "@pwragent/owner-core/thread-title-generation-service";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import type { AgentEvent, AppServerBackendKind, AppServerThreadSummary, FederationCapability } from "@pwragent/shared";
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
  describeBaselineChange,
  type OwnerConformanceBaseline,
  type OwnerHostName,
  type OwnerStepRecord,
} from "./helpers/owner-conformance";
import { OUTPOST_PACKAGE_ROOT, OUTPOST_VIEWER_CAPABILITIES, startOutpostDaemon } from "./helpers/outpost-daemon";
import { createTempStateDb } from "./sqlite-test-utils";
import { createFederatedThreadMessageHandler } from "../federation/federated-thread-message-service";
import { canonicalDurableSteerRequest, canonicalDurableTurnRequest, type SubmitDurableSteerRequest, type SubmitDurableTurnRequest } from "@pwragent/shared";
import { DurableTurnRequestService } from "@pwragent/owner-core/durable-turn-request-service";
import { SqliteDurableTurnRequestStore } from "../storage/durable-turn-request-store";
import { authenticateMessageOrigin } from "@pwragent/federation/federation-message-origin";
import { parseThreadCorrespondenceMessage, threadLockRefusalMessage } from "@pwragent/shared";
import type { ThreadTurnQueue } from "@pwragent/owner-core/thread-turn-queue";
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
  threadTitleGenerationService: NonNullable<ConstructorParameters<typeof DesktopBackendRegistry>[0]>["threadTitleGenerationService"] = null,
  prepareAcp?: (db: StateDb, workspace: string) => Promise<void>,
  claudeOptions?: (workspace: string) => NonNullable<ConstructorParameters<typeof DesktopBackendRegistry>[0]>["claudeBackendOptions"],
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
  const registry = new DesktopBackendRegistry({ codexClient, configStore, overlayStore, messagingStore: null,
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
async function startOutpostOwner(): Promise<OwnerHost> {
  const outpost = await startOutpostDaemon({ capabilities: VIEWER_CAPABILITIES });
  outpost.subscribe(EVENT_CLASSES);
  const backend = await import(pathToFileURL(path.join(OUTPOST_PACKAGE_ROOT, "src/federation-backend.js")).href) as {
    METHOD_CAPABILITIES: Record<string, FederationCapability>;
  };
  return { name: "outpost", ownerInstanceId: outpost.ownerInstanceId, client: outpost.client, methods: new Set(Object.keys(backend.METHOD_CAPABILITIES)),
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

  it("the enrolled Outpost retries an unclaimed workspace refusal without replacing its native owner", async () => {
    const host = await startOutpostDaemon({ capabilities: [...VIEWER_CAPABILITIES, "turn_queue_pause"] });
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
        expect(receipt).toMatchObject({ state: "dispatched", operation: "steerTurn", result: {
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

  it("the enrolled Outpost requires both steering feature and turn-control grants before receipt admission", async () => {
    for (const capabilities of [["turn_control"], ["durable_steer_requests_v1"], ["durable_turn_requests_v1", "turn_control"]] as FederationCapability[][]) {
      const outpost = await startOutpostDaemon({ capabilities });
      try {
        const request: SubmitDurableSteerRequest = { clientRequest: { version: 1, id: randomUUID(), createdAt: Date.now(), payloadHash: "" },
          request: { backend: "codex", threadId: "unadmitted", expectedTurnId: "unadmitted-turn", input: [{ type: "text", text: "Must not be admitted" }] } };
        request.clientRequest.payloadHash = createHash("sha256").update(canonicalDurableSteerRequest(outpost.ownerInstanceId, request)).digest("hex");
        await expect(outpost.client.submitSteerRequest(request)).rejects.toThrow(/capability|grant|forbidden|allowed/i);
        await expect(outpost.client.getSteerRequest({ backend: "codex", threadId: "unadmitted", id: request.clientRequest.id })).rejects.toThrow(/capability|grant|forbidden|allowed/i);
        const db = StateDb.open(path.join(outpost.env.PWRAGENT_HOME!, "profiles/t/state/state.db"));
        try {
          const scope = JSON.stringify(["steerTurn", JSON.stringify(["federation", outpost.viewerId, ""])]);
          expect(new SqliteDurableTurnRequestStore(db).read(scope, request.clientRequest.id)).toBeUndefined();
        } finally { db.close(); }
      } finally { await outpost.close(); }
    }
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
    for (const feature of [false, true]) {
      const outpost = await startOutpostDaemon({ capabilities: ["turn_control", "environment_actions", "thread_detail", ...(feature ? ["durable_turn_requests_v1" as const] : [])] });
      try {
        const identity = await outpost.client.startThread({ backend: "codex", cwd: outpost.workspace });
        const value: SubmitDurableTurnRequest = { clientRequest: { version: 1, id: randomUUID(), createdAt: Date.now(), payloadHash: "" }, request: { ...identity,
          input: [{ type: "text", text: "Must not be admitted" }], ...(feature ? { messageOrigin: { kind: "messaging", causalMessagingSource: { ownerId: "owner", requestId: "request" } } as const } : {}) } };
        value.clientRequest.payloadHash = createHash("sha256").update(canonicalDurableTurnRequest(outpost.ownerInstanceId, value)).digest("hex");
        await expect(outpost.client.submitTurnRequest(value)).rejects.toThrow(/capability|grant|forbidden|allowed/i);
        if (feature) expect(await outpost.client.getTurnRequest({ ...identity, id: value.clientRequest.id })).toBeNull();
      } finally { await outpost.close(); }
    }
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
    const outpost = await startOutpostDaemon({ capabilities: VIEWER_CAPABILITIES });
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
        .toMatchObject({ approvalPolicy: "never", sandbox: "read-only" });
      expect(outpostCalls.find(call => call.method === "turn/start" && String(call.params?.threadId).startsWith("helper-"))?.params)
        .toMatchObject({ approvalPolicy: "never", sandboxPolicy: { type: "readOnly", networkAccess: false } });
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

  it("hands one real profile desktop → daemon → desktop → daemon with native titles and canonical metadata", async () => {
    await fc.assert(fc.asyncProperty(fc.stringMatching(/^[A-Z][a-z]{0,12}$/), async suffix => {
      const root = await realpath(await mkdtemp("/tmp/pa-owner-parity-"));
      let desktop: OwnerHost | undefined;
      let outpost: Awaited<ReturnType<typeof startOutpostDaemon>> | undefined;
      try {
        desktop = await startDesktopOwner(null, undefined, undefined, root);
        const parent = await desktop.client.startThread({ backend: "codex", cwd: desktop.workspace, executionMode: "default" });
        const child = await desktop.client.startThread({ backend: "codex", cwd: desktop.workspace, executionMode: "default" });
        const archived = await desktop.client.startThread({ backend: "codex", cwd: desktop.workspace, executionMode: "default" });
        await desktop.client.renameThread({ backend: "codex", threadId: parent.threadId, name: `Parent ${suffix}` });
        await desktop.client.renameThread({ backend: "codex", threadId: child.threadId, name: `Desktop ${suffix}` });
        await desktop.client.renameThread({ backend: "codex", threadId: archived.threadId, name: `Archive ${suffix}` });
        await desktop.client.setThreadPin({ backend: "codex", threadId: parent.threadId, pinnedRank: "8192" });
        await desktop.client.setThreadParent({ backend: "codex", threadId: child.threadId, parentThreadId: parent.threadId, parentThreadBackend: "codex" });
        const before = (await desktop.client.getNavigationSelectedDetail({ protocol: 2, ref: { backend: "codex", threadId: child.threadId } })).thread!;
        await desktop.client.markThreadSeen({ backend: "codex", threadId: child.threadId, seenAt: before.updatedAt! + 100, seenUpdatedAt: before.updatedAt });
        await desktop.client.archiveThread({ backend: "codex", threadId: archived.threadId });
        await desktop.close(); desktop = undefined;
        // A real pre-SQLite Outpost record shares this provider/profile. Its
        // derived title must reach native Codex and retain provenance on desktop.
        const headless = path.join(root, "profiles/t/state/headless");
        mkdirSync(headless, { recursive: true, mode: 0o700 });
        writeFileSync(path.join(headless, "identity.json"), JSON.stringify({ version: 1, workspace: path.join(root, "w"), codexHome: path.join(root, "c") }), { mode: 0o600 });
        writeFileSync(path.join(headless, "threads.json"), JSON.stringify({ version: 1, threads: [{ id: "legacy-native", title: `Imported ${suffix}`, titleSource: "derived", cwd: path.join(root, "w"), sandbox: "read-only" }] }), { mode: 0o600 });
        const records = path.join(root, "f/fixture-threads.json");
        writeFileSync(records, JSON.stringify({ ...JSON.parse(readFileSync(records, "utf8")), "legacy-native": {
          id: "legacy-native", name: "Previous native name", cwd: path.join(root, "w"), turns: [], createdAt: 1, updatedAt: 1,
        } }));

        outpost = await startOutpostDaemon({ profileRoot: root });
        expect((await outpost.client.getNavigationSelectedDetail({ protocol: 2, ref: { backend: "codex", threadId: "legacy-native" } })).thread)
          .toMatchObject({ title: `Imported ${suffix}`, titleSource: "derived" });
        const page = await inbox({ client: outpost.client } as OwnerHost);
        expect(page.entries.some(entry => entry.row.id === archived.threadId)).toBe(false);
        expect((await outpost.client.getNavigationSelectedDetail({ protocol: 2, ref: { backend: "codex", threadId: child.threadId } })).thread).toMatchObject({ title: `Desktop ${suffix}`, titleSource: "explicit", parentThreadId: parent.threadId, inbox: { inInbox: false } });
        expect((await outpost.client.getNavigationSelectedDetail({ protocol: 2, ref: { backend: "codex", threadId: parent.threadId } })).thread).toMatchObject({ pinnedRank: "8192" });
        expect((await outpost.client.lookupArchivedThreads({ backend: "codex", threadIds: [archived.threadId] })).threads.map(thread => thread.id)).toEqual([archived.threadId]);
        await outpost.client.renameThread({ backend: "codex", threadId: child.threadId, name: `Outpost ${suffix}`, expectedName: `Desktop ${suffix}` });
        const added = await outpost.client.startThread({ backend: "codex", cwd: outpost.workspace });
        await outpost.client.renameThread({ backend: "codex", threadId: added.threadId, name: `New Outpost ${suffix}` });
        await outpost.client.markThreadSeen({ backend: "codex", threadId: child.threadId, seenAt: before.updatedAt! + 200, seenUpdatedAt: before.updatedAt! - 1 });
        expect((await outpost.client.getNavigationSelectedDetail({ protocol: 2, ref: { backend: "codex", threadId: child.threadId } })).thread?.inbox?.inInbox).toBe(true);
        await outpost.close(); outpost = undefined;

        desktop = await startDesktopOwner(null, undefined, undefined, root);
        expect((await desktop.client.getNavigationSelectedDetail({ protocol: 2, ref: { backend: "codex", threadId: "legacy-native" } })).thread)
          .toMatchObject({ title: `Imported ${suffix}`, titleSource: "derived" });
        expect((await desktop.client.getNavigationSelectedDetail({ protocol: 2, ref: { backend: "codex", threadId: child.threadId } })).thread).toMatchObject({ title: `Outpost ${suffix}`, titleSource: "explicit", parentThreadId: parent.threadId });
        expect((await desktop.client.getNavigationSelectedDetail({ protocol: 2, ref: { backend: "codex", threadId: parent.threadId } })).thread).toMatchObject({ pinnedRank: "8192" });
        expect((await desktop.client.getNavigationSelectedDetail({ protocol: 2, ref: { backend: "codex", threadId: added.threadId } })).thread).toMatchObject({ title: `New Outpost ${suffix}`, titleSource: "explicit" });
        expect((await desktop.client.getNavigationSelectedDetail({ protocol: 2, ref: { backend: "codex", threadId: child.threadId } })).thread?.inbox?.inInbox).toBe(true);
        await desktop.client.restoreThread({ backend: "codex", threadId: archived.threadId });
        await desktop.close(); desktop = undefined;

        outpost = await startOutpostDaemon({ profileRoot: root });
        expect((await inbox({ client: outpost.client } as OwnerHost)).entries.some(entry => entry.row.id === archived.threadId)).toBe(true);
        expect((await outpost.client.lookupArchivedThreads({ backend: "codex", threadIds: [archived.threadId] })).threads).toEqual([]);
        const native = JSON.parse(readFileSync(path.join(root, "f/fixture-threads.json"), "utf8"));
        expect(native["legacy-native"].name).toBe(`Imported ${suffix}`);
        expect(native[child.threadId].name).toBe(`Outpost ${suffix}`);
        expect(native[added.threadId].name).toBe(`New Outpost ${suffix}`);
      } finally { await outpost?.close(); await desktop?.close(); await rm(root, { recursive: true, force: true }); }
    }), { numRuns: 3 });
  }, 60_000);

  it("hands actual Claude active/archive metadata across desktop and daemon without retained inventory", async () => {
    await fc.assert(fc.asyncProperty(fc.uuid(), fc.stringMatching(/^[A-Z][a-z]{0,8}$/), async (threadId, name) => {
      // The production Unix socket has a 100-byte path limit; macOS tmpdir is longer.
      const root = await realpath(await mkdtemp(path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "pa-claude-owner-")));
      const state = path.join(root, "profiles/t/state");
      const archivedId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
      const sessions = new ClaudeSessionStore(path.join(state, "claude"));
      let seeded = false;
      const prepare = async (_db: StateDb, workspace: string) => {
        if (seeded) return;
        seeded = true;
        for (const id of [threadId, archivedId]) await sessions.save({ cwd: workspace, sdkSessionId: `private-${id}`, thread: {
          id, source: "claude", title: name, titleSource: "derived", createdAt: 1, updatedAt: 2,
          linkedDirectories: [{ id: workspace, kind: "local", path: workspace, label: "w" }], executionMode: "auto",
          ...(id === archivedId ? { archivedAt: 3 } : {}) } });
      };
      const claude = () => ({ store: sessions, inspectInstallation: async () => ({ authStatus: "unknown" as const }),
        discoverModels: async () => [], readCommands: async () => [], readMcpServers: async () => [],
        getSessionInfo: async () => { throw new Error("Metadata discovery must not inspect SDK sessions"); } });
      let desktop: OwnerHost | undefined;
      let outpost: Awaited<ReturnType<typeof startOutpostDaemon>> | undefined;
      const ref = { backend: "claude" as const, threadId };
      const clearRetained = () => {
        const db = StateDb.open(path.join(state, "state.db"), { profileName: "t" });
        try { new ProviderThreadSnapshotStore(db).replace({ backend: "claude", observedAt: Date.now(), threads: [] }); }
        finally { db.close(); }
      };
      try {
        desktop = await startDesktopOwner(null, prepare, claude, root);
        await desktop.client.renameThread({ ...ref, name: `Explicit ${name}` });
        await desktop.client.setThreadPin({ ...ref, pinnedRank: "1024" });
        await desktop.client.markThreadSeen({ ...ref, seenAt: 10000, seenUpdatedAt: 2 });
        const expected = (await desktop.client.getNavigationSelectedDetail({ protocol: 2, ref })).thread!;
        await desktop.close(); desktop = undefined;
        clearRetained();
        outpost = await startOutpostDaemon({ profileRoot: root });
        const actual = (await outpost.client.getNavigationSelectedDetail({ protocol: 2, ref })).thread!;
        for (const key of ["id", "source", "title", "titleSource", "pinnedRank", "executionMode", "model", "parentThreadId"] as const) {
          expect(actual[key]).toEqual(expected[key]);
        }
        expect(actual.inbox.inInbox).toBe(expected.inbox.inInbox);
        expect(JSON.stringify(actual)).not.toContain("private-");
        expect((await outpost.client.lookupArchivedThreads({ backend: "claude", threadIds: [archivedId] })).threads)
          .toMatchObject([{ id: archivedId, title: name, titleSource: "derived" }]);
        await expect(outpost.client.readThread(ref)).rejects.toThrow("executes Codex only");
        await outpost.close(); outpost = undefined;
        desktop = await startDesktopOwner(null, prepare, claude, root);
        await desktop.client.renameThread({ ...ref, name: `Next ${name}` });
        await desktop.client.setThreadExecutionMode({ ...ref, executionMode: "default" });
        const next = (await desktop.client.getNavigationSelectedDetail({ protocol: 2, ref })).thread!;
        await desktop.close(); desktop = undefined;
        clearRetained();
        outpost = await startOutpostDaemon({ profileRoot: root });
        expect((await outpost.client.resolveThread(ref)).thread).toMatchObject({ title: next.title, titleSource: next.titleSource,
          pinnedRank: next.pinnedRank, executionMode: next.executionMode, inbox: { inInbox: next.inbox.inInbox } });
      } finally { await outpost?.close(); await desktop?.close(); await rm(root, { recursive: true, force: true }); }
    }), { numRuns: 3 });
  }, 60_000);

  it("hands colliding Claude and ACP identities through actual desktop → daemon → desktop profile owners", async () => {
    await fc.assert(fc.asyncProperty(fc.uuid(), fc.stringMatching(/^[A-Z][a-z]{0,8}$/), async (threadId, suffix) => {
      const root = await realpath(await mkdtemp("/tmp/pa-provider-owner-"));
      const acp = "acp:gemini" as const;
      let desktop: OwnerHost | undefined;
      let outpost: Awaited<ReturnType<typeof startOutpostDaemon>> | undefined;
      let seeded = false;
      const prepare = async (db: StateDb, workspace: string) => {
        if (seeded) return;
        seeded = true;
        new AcpAgentStore(db).upsertInstalledAgent({ backendId: acp, registryId: "gemini", name: "ACP fixture",
          distributionKind: "local", distributionSource: "fixture", installStatus: "installed", authStatus: "not-required",
          verificationStatus: "not-applicable", allowlistRuleId: "fixture", installedAt: 1, updatedAt: 1,
          launchDescriptor: { backendId: acp, registryId: "gemini", distributionKind: "local",
            command: process.execPath, args: ["-e", "throw new Error('Retained inventory must not start ACP')"], env: {} } });
        new AcpSessionStore(db).upsertSession({ backendId: acp, sessionId: threadId, title: `ACP ${suffix}`, titleSource: "explicit",
          cwd: workspace, createdAt: 1, updatedAt: 2, executionMode: "default", status: "idle" });
        await new ClaudeSessionStore(path.join(root, "profiles/t/state/claude")).save({ cwd: workspace, thread: {
          id: threadId, source: "claude", title: `Claude ${suffix}`, titleSource: "explicit", createdAt: 1, updatedAt: 2,
          linkedDirectories: [{ id: workspace, kind: "local", path: workspace, label: "w" }], executionMode: "default" } });
        writeFileSync(path.join(root, "f/fixture-threads.json"), JSON.stringify({ [threadId]: {
          id: threadId, name: `Codex ${suffix}`, cwd: workspace, createdAt: 1, updatedAt: 2, turns: [],
        } }));
      };
      const claude = () => ({ store: new ClaudeSessionStore(path.join(root, "profiles/t/state/claude")),
        inspectInstallation: async () => ({ executable: "/fixture/claude", authStatus: "signed-in" as const }),
        discoverModels: async () => [], readCommands: async () => [], readMcpServers: async () => [], getSessionInfo: async () => undefined });
      try {
        desktop = await startDesktopOwner(null, prepare, claude, root);
        const expected = new Map<string, Record<string, unknown>>();
        for (const backend of ["claude", acp] as const) {
          const ref = { backend, threadId };
          const registry = desktopOwner.registry as DesktopBackendRegistry;
          await registry.listThreads({ backend, callerReason: "startup-provider-refresh", forceRefresh: true });
          const provider = registry as unknown as { readProviderThreadList: (backend: AppServerBackendKind, params: unknown, diagnostics: unknown) => Promise<{ threads: AppServerThreadSummary[]; enriched: boolean }> };
          const read = provider.readProviderThreadList.bind(registry);
          let release!: () => void;
          let entered!: () => void;
          const gate = new Promise<void>(resolve => { release = resolve; });
          const started = new Promise<void>(resolve => { entered = resolve; });
          const heldRead = vi.spyOn(provider, "readProviderThreadList").mockImplementation(async (...args) => {
            const result = await read(...args);
            entered();
            await gate;
            return result;
          });
          const stale = registry.listThreads({ backend, callerReason: "startup-provider-refresh", forceRefresh: true });
          await started;
          heldRead.mockRestore();
          await desktop.client.renameThread({ ...ref, name: `${backend === "claude" ? "Claude" : "ACP"} New ${suffix}` });
          release();
          await stale;
          await desktop.client.setThreadPin({ ...ref, pinnedRank: backend === "claude" ? "1024" : "2048" });
          const before = (await registry.listThreads({ backend, forceRefresh: true })).find(thread => thread.id === threadId)!;
          await desktop.client.markThreadSeen({ ...ref, seenAt: 10_000, seenUpdatedAt: before.updatedAt });
          expected.set(backend, { id: threadId, source: backend, title: `${backend === "claude" ? "Claude" : "ACP"} New ${suffix}`,
            titleSource: "explicit", pinnedRank: backend === "claude" ? "1024" : "2048", inbox: { inInbox: false } });
        }
        await desktop.close(); desktop = undefined;
        outpost = await startOutpostDaemon({ profileRoot: root });
        for (const backend of ["claude", acp] as const) {
          expect((await outpost.client.resolveThread({ backend, threadId })).thread).toMatchObject(expected.get(backend)!);
          expect((await outpost.client.getNavigationSelectedDetail({ protocol: 2, ref: { backend, threadId } })).thread).toMatchObject(expected.get(backend)!);
          expect((await outpost.client.getNavigationQueryPage({ protocol: 2, consumer: "remote-window", backend,
            query: { kind: "exact", identities: [{ backend, threadId }] } })).entries).toHaveLength(1);
          await expect(outpost.client.startTurn({ backend, threadId, input: [{ type: "text", text: "Must refuse" }] })).rejects.toThrow("executes Codex only");
        }
        expect((await outpost.client.resolveThread({ backend: "codex", threadId })).thread?.title).toBe(`Codex ${suffix}`);
        await outpost.close(); outpost = undefined;
        desktop = await startDesktopOwner(null, prepare, claude, root);
        for (const backend of ["claude", acp] as const) {
          expect((await desktop.client.getNavigationSelectedDetail({ protocol: 2, ref: { backend, threadId } })).thread).toMatchObject(expected.get(backend)!);
        }
      } finally { await outpost?.close(); await desktop?.close(); await rm(root, { recursive: true, force: true }); }
    }), { numRuns: 3 });
  }, 60_000);

  it("retires actual active and archived ACP membership across desktop and daemon while retained metadata and colliding Codex identities survive", async () => {
    await fc.assert(fc.asyncProperty(fc.uuid(), async (threadId) => {
      for (const archived of [false, true]) {
        const root = await realpath(await mkdtemp(path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "pa-acp-retire-")));
        const backend = "acp:gemini" as const;
        const ref = { backend, threadId };
        let desktop: OwnerHost | undefined;
        let outpost: Awaited<ReturnType<typeof startOutpostDaemon>> | undefined;
        let seeded = false;
        const prepare = async (db: StateDb, workspace: string) => {
          if (seeded) return;
          seeded = true;
          new AcpAgentStore(db).upsertInstalledAgent({ backendId: backend, registryId: "gemini", name: "ACP retirement fixture",
            distributionKind: "local", distributionSource: "fixture", installStatus: "installed", authStatus: "not-required",
            verificationStatus: "not-applicable", allowlistRuleId: "fixture", installedAt: 1, updatedAt: 1,
            launchDescriptor: { backendId: backend, registryId: "gemini", distributionKind: "local",
              command: process.execPath, args: ["-e", "throw new Error('Membership discovery must not start ACP')"], env: {} } });
          new AcpSessionStore(db).upsertSession({ backendId: backend, sessionId: threadId, title: "Actual ACP member", titleSource: "derived",
            cwd: workspace, createdAt: 1, updatedAt: 2, executionMode: "auto", status: "idle", ...(archived ? { archivedAt: 3 } : {}) });
          await new SqliteOverlayStore(db).updateThreadMetadata(ref, { pinnedRank: "1024", seenAt: 10_000, seenUpdatedAt: 2,
            parent: { backend: "codex", threadId: "parent" }, model: "retained-model", fastMode: true });
          writeFileSync(path.join(root, "f/fixture-threads.json"), JSON.stringify({ [threadId]: {
            id: threadId, name: "Colliding native Codex", cwd: workspace, createdAt: 1, updatedAt: 2, turns: [],
          } }));
        };
        try {
          desktop = await startDesktopOwner(null, prepare, undefined, root);
          const before = archived
            ? (await desktop.client.lookupArchivedThreads({ backend, threadIds: [threadId], includeParent: true })).threads[0]!
            : (await desktop.client.getNavigationSelectedDetail({ protocol: 2, ref })).thread!;
          expect(before).toMatchObject({ title: "Actual ACP member", titleSource: "derived" });
          if (archived) expect(before.archivedAt).toBe(3);
          else expect(before).toMatchObject({ executionMode: "auto", pinnedRank: "1024" });
          await desktop.close(); desktop = undefined;
          outpost = await startOutpostDaemon({ profileRoot: root });
          expect((await outpost.client.getNavigationSelectedDetail({ protocol: 2, ref })).thread).toMatchObject({
            title: before.title, titleSource: before.titleSource, pinnedRank: "1024", executionMode: "auto",
            model: "retained-model", fastMode: true, parentThreadId: "parent", parentThreadBackend: "codex", inbox: { inInbox: false } });
          const db = StateDb.open(path.join(root, "profiles/t/state/state.db"), { profileName: "t" });
          try {
            const sessions = new AcpSessionStore(db);
            sessions.deleteSession(backend, threadId);
            expect(sessions.getSession(backend, threadId)).toBeUndefined();
            expect(await new SqliteOverlayStore(db).getThreadMetadata(ref)).toMatchObject({ pinnedRank: "1024" });
            // Leave a positively observed older row behind, as desktop retention can.
            new ProviderThreadSnapshotStore(db).replace({ backend, observedAt: Date.now() + 100_000,
              threads: [before] });
          } finally { db.close(); }
          const assertAbsent = async (client: FederationRemoteBackendClient) => {
            expect((await client.resolveThread(ref)).thread).toBeUndefined();
            expect((await client.getNavigationSelectedDetail({ protocol: 2, ref })).identity).toBe("unresolved");
            expect((await client.lookupArchivedThreads({ backend, threadIds: [threadId], includeParent: true })).threads).toEqual([]);
            expect((await client.getNavigationQueryPage({ protocol: 2, consumer: "remote-window", backend,
              query: { kind: "exact", identities: [ref] } })).entries).toEqual([]);
            expect((await client.resolveThread({ backend: "codex", threadId })).thread?.title).toBe("Colliding native Codex");
          };
          await assertAbsent(outpost.client);
          await outpost.close(); outpost = undefined;
          outpost = await startOutpostDaemon({ profileRoot: root });
          await assertAbsent(outpost.client);
          await outpost.close(); outpost = undefined;
          desktop = await startDesktopOwner(null, prepare, undefined, root);
          await assertAbsent(desktop.client);
          const publisher = desktopOwner.registry as {
            publishRefreshedProviderThreadsToCache(refreshes: Array<{ backends: AppServerBackendKind[]; threads: AppServerThreadSummary[] }>): Promise<void>;
          };
          await publisher.publishRefreshedProviderThreadsToCache([{ backends: [backend], threads: [before] }]);
          await assertAbsent(desktop.client);
        } finally { await outpost?.close(); await desktop?.close(); await rm(root, { recursive: true, force: true }); }
      }
    }), { numRuns: 3 });
  }, 60_000);

  it("retires confirmed native Codex members through the actual daemon and desktop without losing imported owners or accepted jobs", async () => {
    await fc.assert(fc.asyncProperty(fc.uuid(), fc.boolean(), async (threadId, archived) => {
      const root = await realpath(await mkdtemp(path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "pa-codex-retire-")));
      const ref = { backend: "codex" as const, threadId };
      let desktop: OwnerHost | undefined;
      let outpost: Awaited<ReturnType<typeof startOutpostDaemon>> | undefined;
      let seeded = false;
      const prepare = async (db: StateDb, workspace: string) => {
        if (seeded) return;
        seeded = true;
        await new SqliteOverlayStore(db).updateThreadMetadata(ref, { title: { text: "Native confirmed", source: "derived", nativeName: "Native confirmed" },
          pinnedRank: "1024", seenAt: 10, seenUpdatedAt: 2, parent: { backend: "claude", threadId: "parent" }, model: "saved-model", fastMode: true });
        await new SqliteOverlayStore(db).updateThreadMetadata({ backend: "codex", threadId: "accepted-owner" }, {
          title: { text: "Accepted canonical title", source: "derived", nativeName: "Accepted canonical title" },
          nativeMembershipRetired: true, createdAt: 1, updatedAt: 2, cwd: workspace,
          pinnedRank: "2048", seenAt: 10, seenUpdatedAt: 2, parent: { backend: "claude", threadId: "parent" }, model: "accepted-model", fastMode: true,
        });
        writeFileSync(path.join(root, "f/fixture-threads.json"), JSON.stringify({ [threadId]: {
          id: threadId, name: "Native confirmed", preview: "", cwd: workspace, createdAt: 1, updatedAt: 2, turns: [], archived,
        } }));
      };
      try {
        desktop = await startDesktopOwner(null, prepare, undefined, root);
        const before = archived ? (await desktop.client.lookupArchivedThreads({ backend: "codex", threadIds: [threadId] })).threads[0]
          : (await desktop.client.getNavigationSelectedDetail({ protocol: 2, ref })).thread;
        expect(before?.title).toBe("Native confirmed");
        await desktop.close(); desktop = undefined;
        const headless = path.join(root, "profiles/t/state/headless");
        mkdirSync(path.join(headless, "jobs"), { recursive: true, mode: 0o700 });
        writeFileSync(path.join(headless, "identity.json"), JSON.stringify({ version: 1, workspace: path.join(root, "w"), codexHome: path.join(root, "c") }));
        writeFileSync(path.join(headless, "threads.json"), JSON.stringify({ version: 1, threads: [
          { id: "pending-import", title: "Pending imported title", titleSource: "derived", sandbox: "read-only",
            createdAt: 1, updatedAt: 2, pinnedRank: "3072", seenAt: 10, seenUpdatedAt: 2,
            parentThreadBackend: "claude", parentThreadId: "parent", model: "imported-model", fastMode: true },
          { id: "fallback-import", sandbox: "read-only" },
        ] }));
        const accepted = { version: 1, id: "confirmed-job", status: "completed", fingerprint: "accepted-input-fingerprint",
          threadId: "accepted-owner", turnId: "accepted-turn", sandbox: "read-only", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:01Z" };
        writeFileSync(path.join(headless, "jobs/confirmed-job.json"), JSON.stringify(accepted));
        outpost = await startOutpostDaemon({ profileRoot: root });
        expect((await outpost.client.getNavigationSelectedDetail({ protocol: 2, ref })).thread).toMatchObject({ title: "Native confirmed", pinnedRank: "1024" });
        // A repeated cursor is an incomplete protocol discovery, not an empty
        // authoritative inventory. Neither active nor archive failure retires.
        for (const repeatArchived of [false, true]) {
          writeFileSync(path.join(root, "f/discovery-control.json"), JSON.stringify({ repeatArchived }));
          await expect(outpost.client.getNavigationQueryPage({ protocol: 2, consumer: "remote-window", backend: "codex",
            query: { kind: "exact", identities: [ref] } })).rejects.toThrow("incomplete");
          expect((await outpost.client.getNavigationSelectedDetail({ protocol: 2, ref })).thread?.title).toBe("Native confirmed");
        }
        unlinkSync(path.join(root, "f/discovery-control.json"));
        writeFileSync(path.join(root, "f/fixture-threads.json"), "{}");
        const assertRetired = async (client: FederationRemoteBackendClient) => {
          const page = await client.getNavigationQueryPage({ protocol: 2, consumer: "remote-window", backend: "codex",
            query: { kind: "exact", identities: [ref] } });
          expect(page.entries).toEqual([]);
          expect((await client.resolveThread(ref)).thread).toBeUndefined();
          expect((await client.getNavigationSelectedDetail({ protocol: 2, ref })).identity).toBe("unresolved");
          expect((await client.lookupArchivedThreads({ backend: "codex", threadIds: [threadId], includeParent: true })).threads).toEqual([]);
        };
        // Durable import and acceptance are owner identities on either host;
        // complete native absence retires only the separately confirmed member.
        const assertRetained = async (client: FederationRemoteBackendClient) => {
          expect((await client.resolveThread({ backend: "codex", threadId: "pending-import" })).thread)
            .toMatchObject({ title: "Pending imported title", titleSource: "derived", pinnedRank: "3072",
              parentThreadId: "parent", parentThreadBackend: "claude", model: "imported-model", fastMode: true });
          expect((await client.resolveThread({ backend: "codex", threadId: "accepted-owner" })).thread)
            .toMatchObject({ title: "Accepted canonical title", titleSource: "derived", pinnedRank: "2048",
              parentThreadId: "parent", parentThreadBackend: "claude", model: "accepted-model", fastMode: true });
          expect((await client.resolveThread({ backend: "codex", threadId: "fallback-import" })).thread)
            .toMatchObject({ title: "Untitled thread", titleSource: "fallback" });
          const identities = ["pending-import", "fallback-import", "accepted-owner"].map(id => ({ backend: "codex" as const, threadId: id }));
          const page = await client.getNavigationQueryPage({ protocol: 2, consumer: "remote-window", backend: "codex",
            query: { kind: "exact", identities } });
          expect(page.entries.map(entry => entry.row.id).sort()).toEqual(identities.map(ref => ref.threadId).sort());
          for (const id of ["pending-import", "fallback-import", "accepted-owner"]) {
            expect((await client.getNavigationSelectedDetail({ protocol: 2, ref: { backend: "codex", threadId: id } })).thread).toBeDefined();
          }
          const db = StateDb.open(path.join(root, "profiles/t/state/state.db"), { profileName: "t" });
          try {
            expect(await new SqliteOverlayStore(db).getThreadMetadata(ref)).toMatchObject({ pinnedRank: "1024", seenUpdatedAt: 2,
              parent: { backend: "claude", threadId: "parent" }, model: "saved-model", fastMode: true });
            const job = db.raw.prepare("SELECT payload FROM owner_jobs WHERE job_id = ?").get(accepted.id) as { payload: string };
            expect(JSON.parse(job.payload)).toMatchObject(accepted);
          } finally { db.close(); }
        };
        await assertRetired(outpost.client);
        await assertRetained(outpost.client);
        await outpost.close(); outpost = undefined;
        outpost = await startOutpostDaemon({ profileRoot: root });
        await assertRetired(outpost.client);
        await assertRetained(outpost.client);
        await outpost.close(); outpost = undefined;
        desktop = await startDesktopOwner(null, prepare, undefined, root);
        await assertRetired(desktop.client);
        await assertRetained(desktop.client);
        // A positive native observation confirms even an unnamed fallback
        // import. After that confirmation, absence cannot make it pending again.
        writeFileSync(path.join(root, "f/fixture-threads.json"), JSON.stringify({ "fallback-import": {
          id: "fallback-import", name: "", preview: "", cwd: path.join(root, "w"), createdAt: 1, updatedAt: 2, turns: [], archived,
        } }));
        await desktop.close(); desktop = undefined;
        desktop = await startDesktopOwner(null, prepare, undefined, root);
        const confirmed = archived
          ? (await desktop.client.lookupArchivedThreads({ backend: "codex", threadIds: ["fallback-import"] })).threads
          : (await desktop.client.getNavigationQueryPage({ protocol: 2, consumer: "remote-window", backend: "codex",
            query: { kind: "exact", identities: [{ backend: "codex", threadId: "fallback-import" }] } })).entries.map(entry => entry.row);
        expect(confirmed.some(thread => thread.id === "fallback-import")).toBe(true);
        await desktop.close(); desktop = undefined;
        writeFileSync(path.join(root, "f/fixture-threads.json"), "{}");
        desktop = await startDesktopOwner(null, prepare, undefined, root);
        expect((await desktop.client.resolveThread({ backend: "codex", threadId: "fallback-import" })).thread).toBeUndefined();
      } finally { await outpost?.close(); await desktop?.close(); await rm(root, { recursive: true, force: true }); }
    }), { numRuns: 3 });
  }, 60_000);

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
      // Keep the inherited historical snapshot byte-identical, while requiring
      // these two actual queue differences to stay fixed on both live owners.
      const queueConvergence = new Set([
        "backend.startTurn [start its first turn] response $.queueEntryId: desktop string, outpost missing",
        "backend.startTurn [start its first turn] event thread/turnQueue/updated: desktop sends it, outpost does not",
      ]);
      expect(measured.differences.filter(difference => queueConvergence.has(difference))).toEqual([]);
      const queueControls = ["backend.readQueuedTurn", "backend.replaceQueuedMessage", "backend.cancelQueuedTurn", "backend.releaseQueuedTurn", "backend.setQueuedTurnPaused", "backend.moveQueuedTurn", "backend.submitTurnRequest", "backend.getTurnRequest", "backend.submitSteerRequest", "backend.getSteerRequest"];
      expect(queueControls.every(method => measured.sharedMethods.includes(method))).toBe(true);
      const change = describeBaselineChange({ ...baseline,
        sharedMethods: [...new Set([...baseline.sharedMethods, ...queueControls])].sort(),
        differences: baseline.differences.filter(difference => !queueConvergence.has(difference)),
      }, measured);
      if (change) throw new Error(change);
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
      for (const sender of ["alice", "bob"]) handles.set(sender, (await handler(request(sender, `Original ${sender}`)))!.queueEntryId!);
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
