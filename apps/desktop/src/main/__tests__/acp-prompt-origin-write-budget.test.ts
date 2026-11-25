import { mkdtemp, realpath, rm } from "node:fs/promises";
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

const registries: DesktopBackendRegistry[] = [];
const databases: StateDb[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(registries.splice(0).map((registry) => registry.close()));
  for (const db of databases.splice(0)) db.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.unstubAllEnvs();
});

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
  registry.onEvent((event) => { events.push(event); });
  return { root, registry, overlayStore, transport, events };
}

it("writes a messaging turn's prompt origin once", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const { root, registry, overlayStore, transport, events } = await createFixture();
  const { threadId } = await registry.startThread({ backend: ACP, cwd: root });

  let promptItem: Promise<AgentEvent> | undefined;
  const { writes } = await measureSqliteWrites(async () => {
    const started = await registry.startTurn({
      backend: ACP, threadId, messageOrigin: { kind: "messaging" },
      input: [{ type: "text", text: "ship the release notes" }],
    });
    // The prompt's item is published after the start returns; its event
    // reaches listeners only once its origin handling has finished.
    promptItem = new Promise<AgentEvent>((resolve, reject) => {
      const find = () => events.find((event) => event.notification.method === "item/completed"
        && (event.notification.params as { item?: { id?: unknown } }).item?.id === `user:${started.turnId}`);
      const deadline = Date.now() + 5_000;
      const poll = () => {
        const found = find();
        if (found) resolve(found);
        else if (Date.now() > deadline) reject(new Error("the prompt item was never published"));
        else setTimeout(poll, 5);
      };
      poll();
    });
    await promptItem;
  });

  const event = await promptItem!;
  const params = event.notification.params as { turnId: string; item: { origin?: unknown } };
  // The item still carries the origin the window renders.
  expect(params.item.origin).toEqual({ kind: "messaging" });
  const origins = await overlayStore.readThreadMessageOrigins({
    backend: ACP, threadId, messageIds: [`user:${params.turnId}`],
  });
  expect(origins[`user:${params.turnId}`]).toEqual({ kind: "messaging" });
  expect(writes.tables.filter((table) => table.table === "thread_message_origins")
    .map((table) => table.commits)).toEqual([1]);
  transport.finishTurns();

  expectSqliteWriteBudget({
    budgetFile: "acp-prompt-origin-write-budgets.json",
    note: "One ACP turn started from messaging, through its prompt's user item: two ACP session-record writes and one origin row (~36 KB WAL); the prompt item formerly upserted the origin row again (~4 KB WAL), ~0.4 MB/day at 100 messaging turns a day",
    scenario: "acp-messaging-turn-start",
    writes,
  });
});
