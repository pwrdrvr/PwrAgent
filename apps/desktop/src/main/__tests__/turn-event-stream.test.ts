/**
 * Characterizes the ordered turn-event stream of the registry's event hub,
 * `emitAfterLiveThreadUsageRegistration` in backend-registry.ts, before the
 * registry is split into domain modules (Linear PWR-142, phase 2: PWR-145).
 *
 * The hub runs every domain's turn work, in an order that matters. For each
 * scenario this test records two things against a real StateDb and
 * SqliteOverlayStore, with Codex replaced by a scripted protocol fixture:
 *
 *  1. Every AgentEvent the registry's listeners receive, in order.
 *  2. For each event that enters the hub, the hooks the hub calls directly,
 *     in order. A hook is one of the hub's own calls (a registry method or a
 *     collaborator it calls itself); calls a hook makes in turn are not
 *     recorded, so a hook can change inside without changing the record.
 *
 * The recording is checked in at fixtures/turn-event-stream.json.
 *
 * PHASES 3 TO 5 OF THE SPLIT MUST KEEP THAT FIXTURE UNCHANGED. A move-only
 * change must not move a line of it. A change that alters the order on
 * purpose re-records it, and the PR says why in a reviewed diff:
 *
 *   UPDATE_TURN_EVENT_STREAM=1 pnpm test apps/desktop/src/main/__tests__/turn-event-stream.test.ts
 *
 * When a hook moves out of the registry into a domain module, its recorded
 * name stays the same. Point its HUB_HOOKS entry at the new owner instead;
 * the test fails by name if a listed hook can no longer be found.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentEvent } from "@pwragent/shared";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopBackendRegistry } from "../app-server/backend-registry-wiring";
import type { DesktopBackendRegistry } from "../app-server/backend-registry";
import { CodexAppServerClient } from "../codex-app-server/desktop-client";
import { DesktopConfigStore } from "../settings/config-store/desktop-config-store";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { resetDesktopOverlayStoreForTests, setDesktopOverlayStoreForTests } from "../storage/desktop-overlay-store";
import { OwnerConformanceCodexTransport } from "./fixtures/owner-conformance-codex-transport";
import { ScriptedCodexTransport } from "./fixtures/turn-event-stream-codex-transport";
import { createTempStateDb } from "./sqlite-test-utils";

const owner = vi.hoisted(() => ({ registry: undefined as unknown }));
vi.mock("../app-server/backend-registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../app-server/backend-registry")>()),
  getDesktopBackendRegistry: () => owner.registry,
}));
vi.mock("../acp/acp-instance-discovery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../acp/acp-instance-discovery")>()),
  discoverLocalAcpAgentRecords: vi.fn(async () => []),
}));
vi.mock("../log", () => ({ getMainLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }));
vi.mock("../codex-app-server/stdio-transport", async () => ({
  StdioJsonRpcTransport: (await import("./fixtures/turn-event-stream-codex-transport")).ScriptedCodexTransport,
}));

const FIXTURE_PATH = path.join(process.cwd(), "apps/desktop/src/main/__tests__/fixtures/turn-event-stream.json");
const UPDATE = process.env.UPDATE_TURN_EVENT_STREAM === "1";

type HubEntry = { event: string; hooks: string[] };
type HookContext = { entry: HubEntry; depth: number };

/**
 * The hub's direct calls. Each entry names the hook as the fixture records it
 * and says where it lives. When the split moves a hook, change `owner` here,
 * never the recorded name.
 */
type Members = Record<string, unknown>;

const HUB_HOOKS: Array<{ name: string; owner: (registry: Members) => Members | undefined; method?: string }> = [
  ...[
    "forwardManagedReviewActivity",
    "withThreadMessageContext",
    "rememberFileChangeApprovalContext",
    "withEmbeddedFileChangeApprovalContext",
    "rememberManagedReviewOutput",
    "recordTaskMonitorActivity",
    "getCachedThreadSummary",
    "repairCodexThreadDirectoryRelationship",
    "rememberThreadTitleFromEvent",
    "shouldInvalidateThreadListCacheForNotification",
    "invalidateThreadListCache",
    "reconcileBackendCodexThreadStatus",
    "schedulePendingThreadTitleGenerationFromLifecycle",
    "findActiveCodexReviewTurnKey",
    "resolveCodexThreadExecutionModeForActiveTurn",
    "emit",
    "raiseWithdrawnForgeApprovalTodo",
    "flushLiveThreadUsageLines",
    "persistLiveCodexNativeSubAgentUsage",
    "usageAccountForTurn",
    "turnLimitObservation",
    "flushPendingTokenMiserLedger",
    "emitThreadPricingUpdated",
    "findActiveReviewSubAgentForTerminal",
    "completeReviewSubAgent",
    "publishManagedReviewTerminal",
    "clearAcceptedToolCallsForEndedTurn",
    "adoptThreadBranchChangeFromActiveTurn",
    "clearNativeReviewActiveTurns",
    "clearCodexReviewInterruptMappingForTurn",
    "releaseNativeReviewParent",
    "drainPendingReviewStartsForTerminalTurn",
    "drainPendingThreadWorkspaceMovesForTerminalTurn",
    "scheduleQueuedAgentChange",
    "flushQueuedExecutionModeIfPresent",
    "maybeRestartCodexForManagedRuntimeChange",
    "usesSlashControlledAcpExecutionModes",
    "flushQueuedAcpRuntimeOptionIfPresent",
    "appendTurnFailure",
    "handleTaskMonitorTerminalNotification",
    "threadHasActiveCodexReviewTurn",
    "drainPendingThreadWorkspaceMovesForTurnIds",
    "refreshCodexBackgroundTerminalsAfterTurn",
    "recordLiveThreadUsage",
    "runTokenMiserSideEffect",
    "recordTokenMiserParentModelRequest",
    "handleThreadCompactionReplayBoundary",
    "recordToolInvocationAccounting",
    "forgetCompletedTurnReplayObservations",
    "recordCodexNativeSubAgentActivity",
    "recordCodexNativeSubAgentNotifications",
    "recordCodexNativeSubAgentNames",
    "recordTaskMonitorUsage",
    "notifyForAttentionRequired",
    "notifyForTerminalOutcome",
    "finishLiveThreadUsageEmitWork",
    "withReviewRuntimeMetadata",
    "emitToListeners",
  ].map((name) => ({ name, owner: (registry: Members) => registry })),
  ...([
    ["overlayStore", ["getThreadMetadata", "updateThreadMetadata", "completeThreadUsageTurn", "getThreadOverlayState"]],
    ["providerThreadSnapshotStore", ["list", "replace"]],
    ["mcpGatewayTools", ["cancel"]],
    ["pdfAttachmentStore", ["releaseTurn"]],
    ["threadSteering", ["retireTurn"]],
    ["threadTitles", ["forgetPendingInput"]],
    ["threadTurnQueue", ["releaseThread"]],
    ["navigationDirectoryScope", ["forEvent"]],
  ] as const).flatMap(([field, methods]) => methods.map((method) => ({
    name: `${field}.${method}`,
    method,
    owner: (registry: Members) => registry[field] as Members | undefined,
  }))),
];

/** Collaborators the test's owner leaves unset; their hooks cannot be called. */
const OPTIONAL_OWNERS = new Set(["providerThreadSnapshotStore", "mcpGatewayTools"]);

/**
 * Records every hub run and the hooks it calls itself. A hook runs in a deeper
 * context, so calls it makes are not recorded, while an event a hook emits
 * enters the hub again and is recorded as its own run.
 */
function instrumentHub(registry: DesktopBackendRegistry): HubEntry[] {
  const target = registry as unknown as Members;
  const entries: HubEntry[] = [];
  const context = new AsyncLocalStorage<HookContext>();
  const hub = "emitAfterLiveThreadUsageRegistration";
  if (typeof target[hub] !== "function") throw new Error(`The hub ${hub} is not a registry method; point instrumentHub at its new owner.`);
  const runHub = target[hub] as (...args: unknown[]) => Promise<void>;
  target[hub] = function (this: unknown, ...args: unknown[]) {
    const event = args[0] as AgentEvent;
    const entry: HubEntry = { event: `${event.backend} ${event.notification.method}`, hooks: [] };
    entries.push(entry);
    return context.run({ entry, depth: 0 }, () => runHub.apply(this, args));
  };
  for (const hook of HUB_HOOKS) {
    const ownerObject = hook.owner(target);
    const field = hook.name.split(".")[0]!;
    if (!ownerObject && hook.method && OPTIONAL_OWNERS.has(field)) continue;
    const method = hook.method ?? hook.name;
    if (!ownerObject || typeof ownerObject[method] !== "function") {
      throw new Error(`Hub hook ${hook.name} was not found. If the split moved it, point its HUB_HOOKS owner at the new module.`);
    }
    const original = ownerObject[method] as (...args: unknown[]) => unknown;
    ownerObject[method] = function (this: unknown, ...args: unknown[]) {
      const current = context.getStore();
      if (!current) return original.apply(this, args);
      if (current.depth === 0) current.entry.hooks.push(hook.name);
      return context.run({ entry: current.entry, depth: current.depth + 1 }, () => original.apply(this, args));
    };
  }
  return entries;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO_TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
/** Epoch milliseconds inside a string, such as an id built from Date.now(). */
const EPOCH_MS = /(?<!\d)1\d{12}(?!\d)/g;
const TIME_KEY = /(?:At|Ms|Time|time|timestamp|Timestamp|duration|Duration|Seconds)$/;

/** Replaces ids, clocks and paths with stable placeholders, in first-seen order. */
function createNormalizer(paths: Array<[string, string]>) {
  const uuids = new Map<string, string>();
  const text = (value: string) => {
    let result = value;
    for (const [from, to] of paths) result = result.split(from).join(to);
    result = result.replace(UUID, (match) => {
      const key = match.toLowerCase();
      if (!uuids.has(key)) uuids.set(key, `<uuid-${uuids.size + 1}>`);
      return uuids.get(key)!;
    });
    return result.replace(ISO_TIME, "<time>").replace(EPOCH_MS, "<time>");
  };
  const normalize = (value: unknown, key = ""): unknown => {
    if (typeof value === "string") return text(value);
    if (typeof value === "number") return TIME_KEY.test(key) || value >= 1e9 ? "<time>" : value;
    if (Array.isArray(value)) return value.map((entry) => normalize(entry));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.keys(value).sort().map((name) => [text(name), normalize((value as Record<string, unknown>)[name], name)]));
    }
    return value;
  };
  return normalize;
}

type ScenarioRecord = { events: string[]; hub: HubEntry[] };

type Owner = {
  registry: DesktopBackendRegistry;
  events: AgentEvent[];
  hub: HubEntry[];
  workspace: string;
  record(): ScenarioRecord;
  close(): Promise<void>;
};

/** Desktop's real owner, built the way the owner conformance suite builds it. */
async function startOwner(): Promise<Owner> {
  ScriptedCodexTransport.reset();
  const workspace = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-turn-stream-")));
  const { dbPath, tempDir } = createTempStateDb("pwragent-turn-stream-db-");
  const db = StateDb.open(dbPath);
  const codexClient = new CodexAppServerClient({ directoryResolver: async () => [] });
  const overlayStore = new SqliteOverlayStore(db);
  setDesktopOverlayStoreForTests(overlayStore);
  const configPath = path.join(tempDir, "config.toml");
  await writeFile(configPath, "");
  const configStore = new DesktopConfigStore({ configPath });
  configStore.recordProviderDiscovery("codex", { candidates: [], selectedCommand: "/fixture/codex", selectedVersion: "0.159.2" });
  const registry = createDesktopBackendRegistry({ codexClient, configStore, overlayStore, messagingStore: null,
    threadTitleGenerationService: null, pdfToolMcpServer: null, runtimeInstanceId: "turn-stream-desktop",
    resolveLiveProfileRuntimeInstanceIds: () => [], discoverLocalAcpAgents: async () => [] });
  owner.registry = registry;
  const hub = instrumentHub(registry);
  const events: AgentEvent[] = [];
  const stopEvents = registry.onEvent((event) => { events.push(event); });
  return {
    registry, events, hub, workspace,
    record() {
      const normalize = createNormalizer([[workspace, "<workspace>"], [tempDir, "<state>"], [os.tmpdir(), "<tmp>"], [path.basename(workspace), "<workspace-name>"]]);
      return {
        events: events.map((event) => `${event.backend} ${event.notification.method} ${JSON.stringify(normalize(event.notification.params))}`),
        hub: hub.map((entry) => ({ event: entry.event, hooks: [...entry.hooks] })),
      };
    },
    async close() {
      stopEvents();
      await registry.close();
      await codexClient.close();
      owner.registry = undefined;
      resetDesktopOverlayStoreForTests();
      configStore.dispose();
      db.close();
      await rm(workspace, { recursive: true, force: true });
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

/** Waits until the owner has gone quiet: no new event or hub run for a while. */
async function settle(current: Owner): Promise<void> {
  let seen = -1;
  let quiet = 0;
  while (quiet < 4) {
    const now = current.events.length + current.hub.length * 1000 + current.hub.reduce((sum, entry) => sum + entry.hooks.length, 0);
    quiet = now === seen ? quiet + 1 : 0;
    seen = now;
    await delay(25);
  }
}

/** Starts a Codex thread and drops its setup from the recording. */
async function startThread(current: Owner): Promise<string> {
  const { threadId } = await current.registry.startThread({ backend: "codex", cwd: current.workspace });
  await settle(current);
  current.events.length = 0;
  current.hub.length = 0;
  return threadId;
}

async function startTurn(current: Owner, threadId: string, text: string): Promise<string> {
  const { turnId } = await current.registry.startTurn({ backend: "codex", threadId, input: [{ type: "text", text, text_elements: [] } as never] });
  await settle(current);
  return turnId;
}

function codex(current: Owner, threadId: string, method: string, params: Record<string, unknown>): Promise<void> {
  ScriptedCodexTransport.notify(threadId, method, { threadId, ...params });
  return settle(current);
}

const turnStarted = (current: Owner, threadId: string, turnId: string) =>
  codex(current, threadId, "turn/started", { turn: { id: turnId, status: "inProgress", items: [], error: null } });
const turnCompleted = (current: Owner, threadId: string, turnId: string, status = "completed", error: unknown = null) =>
  codex(current, threadId, "turn/completed", { turn: { id: turnId, status, items: [], error } });
const statusChanged = (current: Owner, threadId: string, type: "active" | "idle") =>
  codex(current, threadId, "thread/status/changed", { status: type === "active" ? { type, activeFlags: [] } : { type } });

type Scenario = { name: string; run(current: Owner): Promise<void> };

const SCENARIOS: Scenario[] = [
  {
    name: "turn start",
    async run(current) {
      const threadId = await startThread(current);
      const turnId = await startTurn(current, threadId, "Start a turn");
      await statusChanged(current, threadId, "active");
      await turnStarted(current, threadId, turnId);
    },
  },
  {
    name: "turn complete",
    async run(current) {
      const threadId = await startThread(current);
      const turnId = await startTurn(current, threadId, "Complete a turn");
      await statusChanged(current, threadId, "active");
      await turnStarted(current, threadId, turnId);
      await codex(current, threadId, "item/completed", { turnId, item: { id: "item-1", type: "agentMessage", text: "Fixture result" } });
      await turnCompleted(current, threadId, turnId);
      await statusChanged(current, threadId, "idle");
    },
  },
  {
    name: "turn fail",
    async run(current) {
      const threadId = await startThread(current);
      const turnId = await startTurn(current, threadId, "Fail a turn");
      await statusChanged(current, threadId, "active");
      await turnStarted(current, threadId, turnId);
      await turnCompleted(current, threadId, turnId, "failed", { message: "Fixture failure" });
      await statusChanged(current, threadId, "idle");
    },
  },
  {
    name: "turn fail at submission",
    async run(current) {
      const threadId = await startThread(current);
      OwnerConformanceCodexTransport.refusedStarts = 1;
      // The scripted transport hands turn/start to the conformance fixture,
      // whose refusal is the provider rejecting the submission.
      await expect(current.registry.startTurn({ backend: "codex", threadId, input: [{ type: "text", text: "Refused", text_elements: [] } as never] }))
        .rejects.toThrow();
      await settle(current);
    },
  },
  {
    name: "turn cancel (interrupt)",
    async run(current) {
      const threadId = await startThread(current);
      const turnId = await startTurn(current, threadId, "Interrupt a turn");
      await statusChanged(current, threadId, "active");
      await turnStarted(current, threadId, turnId);
      await current.registry.interruptTurn({ backend: "codex", threadId, turnId });
      await settle(current);
      await turnCompleted(current, threadId, turnId, "interrupted");
      await statusChanged(current, threadId, "idle");
    },
  },
  {
    name: "queued execution-mode change applied at turn end",
    async run(current) {
      const threadId = await startThread(current);
      const turnId = await startTurn(current, threadId, "Change mode mid-turn");
      await statusChanged(current, threadId, "active");
      await turnStarted(current, threadId, turnId);
      await current.registry.setThreadExecutionMode({ backend: "codex", threadId, executionMode: "full-access" });
      await settle(current);
      await turnCompleted(current, threadId, turnId);
      await statusChanged(current, threadId, "idle");
    },
  },
  {
    name: "review turn",
    async run(current) {
      const threadId = await startThread(current);
      const { turnId } = await current.registry.startReview({ backend: "codex", threadId, target: { type: "uncommittedChanges" }, delivery: "inline" });
      await settle(current);
      await statusChanged(current, threadId, "active");
      await turnStarted(current, threadId, turnId);
      await codex(current, threadId, "item/started", { turnId, item: { id: "review-enter", type: "enteredReviewMode", review: "current changes" } });
      await codex(current, threadId, "item/completed", { turnId, item: { id: "review-enter", type: "enteredReviewMode", review: "current changes" } });
      await codex(current, threadId, "item/completed", { turnId, item: { id: "review-exit", type: "exitedReviewMode", review: "No findings." } });
      await turnCompleted(current, threadId, turnId);
      await statusChanged(current, threadId, "idle");
    },
  },
  {
    name: "task-monitor turn",
    async run(current) {
      const parentThreadId = await startThread(current);
      const parentTurnId = await startTurn(current, parentThreadId, "Watch a task");
      await statusChanged(current, parentThreadId, "active");
      await turnStarted(current, parentThreadId, parentTurnId);
      const created = await ScriptedCodexTransport.request(parentThreadId, "item/tool/call", {
        threadId: parentThreadId, turnId: parentTurnId, callId: "call-monitor", namespace: "pwragent_task_monitors",
        tool: "create_monitor_delegation", arguments: { task: "Wait for the fixture build", pollIntervalSeconds: 30 },
      }) as { success: boolean; contentItems: Array<{ text: string }> };
      expect(created.success, created.contentItems[0]?.text).toBe(true);
      const { monitorThreadId, monitorTurnId } = JSON.parse(created.contentItems[0]!.text) as { monitorThreadId: string; monitorTurnId: string };
      await settle(current);
      await statusChanged(current, monitorThreadId, "active");
      await turnStarted(current, monitorThreadId, monitorTurnId);
      await codex(current, monitorThreadId, "item/completed", { turnId: monitorTurnId, item: { id: "monitor-message", type: "agentMessage", text: "The build passed." } });
      const { monitorId } = JSON.parse(created.contentItems[0]!.text) as { monitorId: string };
      const completed = await ScriptedCodexTransport.request(monitorThreadId, "item/tool/call", {
        threadId: monitorThreadId, turnId: monitorTurnId, callId: "call-complete", namespace: "pwragent_task_monitors",
        tool: "complete_monitoring", arguments: { monitorId, outcome: "success", summary: "The fixture build passed." },
      }) as { success: boolean; contentItems: Array<{ text: string }> };
      expect(completed.success, completed.contentItems[0]?.text).toBe(true);
      await settle(current);
      await turnCompleted(current, monitorThreadId, monitorTurnId);
      await statusChanged(current, monitorThreadId, "idle");
      await turnCompleted(current, parentThreadId, parentTurnId);
      await statusChanged(current, parentThreadId, "idle");
    },
  },
];

type Recording = { description: string[]; scenarios: Record<string, ScenarioRecord> };

const DESCRIPTION = [
  "The ordered turn-event stream of BackendRegistry's event hub, recorded by turn-event-stream.test.ts.",
  "For each scenario: `events` is every AgentEvent the registry's listeners received, in order;",
  "`hub` is one entry per event that entered the hub, listing the hooks the hub called itself, in order.",
  "Ids, clocks and paths are normalized. Phases 3 to 5 of the registry split (Linear PWR-142) must keep",
  "this file unchanged, or change it in a reviewed diff that says why. Re-record with",
  "UPDATE_TURN_EVENT_STREAM=1 pnpm test apps/desktop/src/main/__tests__/turn-event-stream.test.ts",
];

const CHANGE_POLICY = "Phases 3 to 5 of the registry split must keep this recording unchanged; an intended change re-records it with UPDATE_TURN_EVENT_STREAM=1 and says why in the PR.";

/** One line per event and per hook, so a reorder reads as moved lines. */
function serialize(recording: Recording): string {
  const list = (values: string[], indent: string) => values.length
    ? `[\n${values.map((value) => `${indent}  ${JSON.stringify(value)}`).join(",\n")}\n${indent}]`
    : "[]";
  const hub = (entries: HubEntry[]) => entries.length
    ? `[\n${entries.map((entry) => `        {\n          "event": ${JSON.stringify(entry.event)},\n          "hooks": ${list(entry.hooks, "          ")}\n        }`).join(",\n")}\n      ]`
    : "[]";
  const scenarios = Object.entries(recording.scenarios).map(([name, record]) =>
    `    ${JSON.stringify(name)}: {\n      "events": ${list(record.events, "      ")},\n      "hub": ${hub(record.hub)}\n    }`);
  return `{\n  "description": ${list(recording.description, "  ")},\n  "scenarios": {\n${scenarios.join(",\n")}\n  }\n}\n`;
}

describe("BackendRegistry turn-event stream", () => {
  const measured: Record<string, ScenarioRecord> = {};
  let current: Owner | undefined;

  afterEach(async () => {
    await current?.close();
    current = undefined;
  });

  it("records exactly these scenarios", () => {
    if (UPDATE) return;
    const recording = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Recording;
    expect(Object.keys(recording.scenarios)).toEqual(SCENARIOS.map((scenario) => scenario.name));
  });

  for (const scenario of SCENARIOS) {
    it(`keeps the recorded order: ${scenario.name}`, async () => {
      current = await startOwner();
      await scenario.run(current);
      const record = current.record();
      measured[scenario.name] = record;
      if (UPDATE) return;
      const recorded = existsSync(FIXTURE_PATH)
        ? (JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Recording).scenarios[scenario.name]
        : undefined;
      expect(recorded, `No recording for "${scenario.name}". Record it with UPDATE_TURN_EVENT_STREAM=1.`).toBeDefined();
      // Soft, so one failure shows both what listeners saw and what the hub ran.
      expect.soft(record.events, `Event order changed for "${scenario.name}". ${CHANGE_POLICY}`).toEqual(recorded!.events);
      expect.soft(record.hub, `Hub hook order changed for "${scenario.name}". ${CHANGE_POLICY}`).toEqual(recorded!.hub);
    }, 30_000);
  }

  afterAll(() => {
    if (!UPDATE || Object.keys(measured).length !== SCENARIOS.length) return;
    writeFileSync(FIXTURE_PATH, serialize({ description: DESCRIPTION, scenarios: measured }));
  });
});
