import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type AgentEvent } from "@pwragent/shared/contracts/agent";
import { afterEach, expect, it, vi } from "vitest";
import { FakeAcpAgentTransport } from "../acp/testing/fake-acp-agent";
import type { DesktopBackendRegistry } from "../app-server/backend-registry";
import { createDesktopBackendRegistry } from "../app-server/backend-registry-wiring";
import { CodexAppServerClient } from "../codex-app-server/desktop-client";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { StateDb } from "../state/state-db";
import { AcpAgentStore } from "../storage/acp-agent-store";
import { AcpSessionStore } from "../storage/acp-session-store";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createTempStateDb } from "./sqlite-test-utils";

// Rule: a turn started from messaging records its prompt's origin once. The
// owner writes the `user:<turnId>` origin row when the start call returns,
// and the prompt's own user item, published after it, carries that origin
// without writing the row again.

vi.mock("../log", () => ({ getMainLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }));

const ACP = "acp:fixture" as const;
/** A 1x1 PNG, as a pasted image arrives. */
const PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const registries: DesktopBackendRegistry[] = [];
const transports: HeldPromptTransport[] = [];
const databases: StateDb[] = [];
const roots: string[] = [];
afterEach(cleanUp);

async function cleanUp() {
  // A failed assertion leaves the prompt held; release it so close() ends
  // the turn instead of waiting out its shutdown timeout.
  for (const transport of transports.splice(0)) transport.finishTurns();
  await Promise.all(registries.splice(0).map((registry) => registry.close()));
  for (const db of databases.splice(0)) db.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.unstubAllEnvs();
}

/** An ACP agent whose prompt stays open until the test ends the turn. */
class HeldPromptTransport extends FakeAcpAgentTransport {
  private readonly finishers: Array<() => void> = [];

  constructor() {
    super({ initialize: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  }

  override async request(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    if (method !== "session/prompt") return await super.request(method, params, timeoutMs);
    this.requests.push({ method, params });
    await new Promise<void>((resolve) => { this.finishers.push(resolve); });
    return { stopReason: "end_turn" };
  }

  finishTurns(): void {
    for (const finish of this.finishers.splice(0)) finish();
  }
}

async function createFixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-acp-prompt-origin-")));
  roots.push(root);
  vi.stubEnv("PWRAGENT_HOME", path.join(root, "profile-root"));
  const { dbPath, tempDir } = createTempStateDb("pwragent-acp-prompt-origin-db-");
  roots.push(tempDir);
  const db = StateDb.open(dbPath);
  databases.push(db);
  const transport = new HeldPromptTransport();
  transports.push(transport);
  const overlayStore = new SqliteOverlayStore(db);
  const acpAgentStore = new AcpAgentStore(db);
  acpAgentStore.upsertInstalledAgent({ backendId: ACP, registryId: "fixture", name: "Fixture ACP",
    distributionKind: "local", distributionSource: "fixture", installStatus: "installed", authStatus: "not-required",
    verificationStatus: "not-applicable", allowlistRuleId: "fixture", installedAt: 1, updatedAt: 1,
    launchDescriptor: { backendId: ACP, registryId: "fixture", distributionKind: "local", command: process.execPath, args: [], env: {}, cwd: root },
    runtimeCapabilities: { schemaVersion: 1, status: "discovered", checkedAt: 1, agentCapabilities: { loadSession: true } } });
  const registry = createDesktopBackendRegistry({
    codexClient: new CodexAppServerClient({ directoryResolver: async () => [] }),
    overlayStore, messagingStore: null, threadTitleGenerationService: null,
    runtimeInstanceId: "acp-prompt-origin", resolveLiveProfileRuntimeInstanceIds: () => [],
    acpAgentStore, acpSessionStore: new AcpSessionStore(db),
    createAcpTransport: () => transport, discoverLocalAcpAgents: async () => [],
  });
  registries.push(registry);
  const events: AgentEvent[] = [];
  const waiters: Array<{ matches: (event: AgentEvent) => boolean; resolve: (event: AgentEvent) => void }> = [];
  registry.onEvent((event) => {
    events.push(event);
    for (const waiter of waiters.splice(0)) {
      if (waiter.matches(event)) waiter.resolve(event);
      else waiters.push(waiter);
    }
  });
  /** Settles with the turn's prompt item, whether it was published already or arrives later. */
  const promptItem = (turnId: string) => new Promise<AgentEvent>((resolve) => {
    const matches = (event: AgentEvent) => event.notification.method === "item/completed"
      && (event.notification.params as { item?: { id?: unknown } }).item?.id === `user:${turnId}`;
    const published = events.find(matches);
    if (published) resolve(published);
    else waiters.push({ matches, resolve });
  });
  return { root, registry, overlayStore, promptItem, onEvent: (listener: (event: AgentEvent) => void) => registry.onEvent(listener) };
}

it("writes a messaging turn's prompt origin once", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const { root, registry, overlayStore, promptItem } = await createFixture();
  const { threadId } = await registry.startThread({ backend: ACP, cwd: root });

  let event: AgentEvent | undefined;
  const { writes } = await measureSqliteWrites(async () => {
    const started = await registry.startTurn({
      backend: ACP, threadId, messageOrigin: { kind: "messaging" },
      input: [{ type: "text", text: "ship the release notes" }],
    });
    // The prompt's item is published as the start returns; its event
    // reaches listeners only once its origin handling has finished.
    event = await promptItem(started.turnId);
  });

  if (!event) throw new Error("the prompt item was never published");
  const params = event.notification.params as { turnId: string; item: { origin?: unknown } };
  // The item still carries the origin the window renders.
  expect(params.item.origin).toEqual({ kind: "messaging" });
  const origins = await overlayStore.readThreadMessageOrigins({
    backend: ACP, threadId, messageIds: [`user:${params.turnId}`],
  });
  expect(origins[`user:${params.turnId}`]).toEqual({ kind: "messaging" });
  expect(writes.tables.filter((table) => table.table === "thread_message_origins")
    .map((table) => table.commits)).toEqual([1]);

  expectSqliteWriteBudget({
    budgetFile: "acp-prompt-origin-write-budgets.json",
    note: "One ACP turn started from messaging, through its prompt's user item: two ACP session-record writes and one origin row (~36 KB WAL); the prompt item formerly upserted the origin row again (~4 KB WAL), ~0.4 MB/day at 100 messaging turns a day",
    scenario: "acp-messaging-turn-start",
    writes,
  });
});

// The prompt item of an ACP turn carries the origin it was sent with and
// claims the context its start registered, however late its delivery reaches
// the message-context stage, whatever the agent's prompt adds to the
// operator's words, and whether the context holds an origin, images, or both.
//
// Live items on a thread are delivered in order behind any image work in
// flight, so a reply whose images are still loading when the prompt is
// dispatched holds the prompt item back until after the start returns. An
// attached file adds its reference to the agent's prompt, so the prompt's
// text differs from the operator's words the context records.
//
// Each case drives a real registry over SQLite, so the cases are the shrunk
// counterexamples rather than a generated loop.
it.each([
  {
    name: "a messaging prompt held behind image work in flight",
    texts: ["ship the release notes"], fromMessaging: true, attachImage: false, attachFile: false, imageWorkInFlight: true,
  },
  {
    name: "a messaging prompt whose attached file changes the agent's text",
    texts: ["ship the release notes", "then tag it"], fromMessaging: true, attachImage: false, attachFile: true, imageWorkInFlight: false,
  },
  {
    name: "a prompt with an image and a file but no origin, behind image work",
    texts: ["and post the link"], fromMessaging: false, attachImage: true, attachFile: true, imageWorkInFlight: true,
  },
])("gives the prompt item its turn's origin and leaves no context behind: $name", async ({
  texts, fromMessaging, attachImage, attachFile, imageWorkInFlight,
}) => {
  const { root, registry, promptItem, onEvent } = await createFixture();
  const { threadId } = await registry.startThread({ backend: ACP, cwd: root });
  const notes = path.join(root, "notes.txt");
  if (attachFile) await writeFile(notes, "release notes\n");
  const imageWork = Promise.withResolvers<void>();
  const internals = registry as unknown as {
    transcriptImageWork: Map<string, Promise<void>>;
    pendingThreadMessageContexts: Map<string, { threadId: string }>;
  };
  onEvent((event) => {
    // The reply's images start loading once the turn is under way.
    if (imageWorkInFlight && event.notification.method === "turn/started") {
      internals.transcriptImageWork.set(`${ACP}:${threadId}`, imageWork.promise);
    }
  });

  const started = await registry.startTurn({
    backend: ACP, threadId,
    ...(fromMessaging ? { messageOrigin: { kind: "messaging" as const } } : {}),
    input: [
      ...texts.map((text) => ({ type: "text" as const, text })),
      ...(attachImage ? [{ type: "image" as const, url: PIXEL, name: "chart.png" }] : []),
      ...(attachFile ? [{ type: "localFile" as const, path: notes, name: "notes.txt" }] : []),
    ],
  });
  imageWork.resolve();
  const event = await promptItem(started.turnId);

  expect((event.notification.params as { item: { origin?: unknown } }).item.origin)
    .toEqual(fromMessaging ? { kind: "messaging" } : undefined);
  expect([...internals.pendingThreadMessageContexts.values()]
    .filter((pending) => pending.threadId === threadId)).toEqual([]);
});
