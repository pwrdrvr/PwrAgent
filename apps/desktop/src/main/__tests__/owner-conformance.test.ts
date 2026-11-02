import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import type { AgentEvent, FederationCapability } from "@pwragent/shared";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import { projectThreadDisplayEvent } from "../app-server/thread-display-events";
import { CodexAppServerClient } from "../codex-app-server/client";
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
  unsequencedFederationEventPayload,
} from "../federation/federation-runtime";
import { resetDesktopOverlayStoreForTests, setDesktopOverlayStoreForTests } from "../app-server/desktop-overlay-store";
import { DesktopConfigStore } from "../settings/config-store/desktop-config-store";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
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
  close(): Promise<void>;
};

/**
 * Desktop's real owner: the operations its federation runtime serves a peer,
 * over BackendRegistry, the real Codex client and a real state database,
 * registered with the real federation handlers behind a router that enforces
 * the shared capability table. Only Codex is a fixture.
 */
async function startDesktopOwner(): Promise<OwnerHost> {
  OwnerConformanceCodexTransport.reset();
  const workspace = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-conformance-")));
  const { dbPath, tempDir } = createTempStateDb("pwragent-conformance-db-");
  const db = StateDb.open(dbPath);
  const codexClient = new CodexAppServerClient({ directoryResolver: async () => [] });
  const overlayStore = new SqliteOverlayStore(db);
  setDesktopOverlayStoreForTests(overlayStore);
  // Desktop lists Codex once discovery has selected an executable. The
  // transport fixture stands in for that executable.
  const configPath = path.join(tempDir, "config.toml");
  await writeFile(configPath, "");
  const configStore = new DesktopConfigStore({ configPath });
  configStore.recordProviderDiscovery("codex", { candidates: [], selectedCommand: "/fixture/codex", selectedVersion: "0.159.2" });
  const registry = new DesktopBackendRegistry({ codexClient, configStore, overlayStore, messagingStore: null,
    threadTitleGenerationService: null, pdfToolMcpServer: null, runtimeInstanceId: "conformance-desktop",
    resolveLiveProfileRuntimeInstanceIds: () => [], discoverLocalAcpAgents: async () => [] });
  desktopOwner.registry = registry;
  const events: AgentEvent[] = [];
  // What the federation runtime sends a viewer subscribed to every thread in
  // these classes; the rest of its fan-out is per-subscriber routing.
  const forward = (event: AgentEvent): void => {
    const invalidation = navigationInvalidationForLocalEvent(event);
    if (invalidation) forward(invalidation);
    if (EVENT_CLASSES.includes(federationEventClassForMethod(event.notification.method))) {
      events.push(unsequencedFederationEventPayload(projectThreadDisplayEvent(event)));
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
  registerFederationBackendHandlers({ router, backend: new DesktopFederationRuntime().localBackend() });
  rpc = new FederationRpcEndpoint({ localInstanceId: "viewer", remoteInstanceId: "desktop-owner", defaultTimeoutMs: 5000,
    sendEnvelope: (envelope) => { void router.routeEnvelope({ envelope, sourcePeerId: "viewer" }); } });
  return {
    name: "desktop", client: new FederationRemoteBackendClient(rpc), methods, events, workspace,
    close: async () => {
      stopEvents();
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

/** Waits until the owner has sent nothing for a while. */
async function settle(host: OwnerHost): Promise<void> {
  let seen = -1;
  for (let attempt = 0; attempt < 40 && seen !== host.events.length; attempt++) {
    seen = host.events.length;
    await delay(150);
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
        if ((await host.client.readThread(ref(context))).replay.lastAssistantMessage === "Fixture result") break;
        await delay(50);
      }
      return turn;
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
      response = { error: error instanceof Error ? error.message : String(error) };
    }
    await settle(host);
    records.push({ step: step.name, method: step.method, response,
      values: step.values && !(response as { error?: string }).error ? step.values(response) : {},
      events: host.events.slice(before) });
  }
  return records;
}

describe.skipIf(process.platform === "win32")("owner conformance: desktop and the Outpost", () => {
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
  }, 60_000);
});
