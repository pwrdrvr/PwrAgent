import { rmSync } from "node:fs";
import fc from "fast-check";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppUpdateNoticeStore } from "@pwragent/sqlite-storage/app-update-notice-store";
import type { MessagingBindingRecord } from "@pwragent/messaging-interface";
import type { AppUpdateNotice } from "../../shared/app-metadata";
import { listAgentUpdateNoticeSettings, reconcileAppUpdateRestart, setAgentUpdateNoticeSetting, subscribeAgentUpdateNotices } from "../messaging/agent-update-notices";
import { buildMessagingConversationKey } from "../messaging/core/messaging-store";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createTempStateDb, openInMemoryStateDb } from "./sqlite-test-utils";

let db: StateDb;
let bindings: MessagingBindingRecord[];
vi.mock("../storage/desktop-messaging-storage", () => ({
  createAppUpdateNoticeStore: () => new AppUpdateNoticeStore(db),
}));
vi.mock("../messaging/desktop-messaging-store", () => ({
  getDesktopMessagingStore: () => ({
    findActiveBindings: async () => bindings,
    getBinding: async (id: string) => bindings.find((binding) => binding.id === id),
  }),
}));

const first = { backend: "codex", threadId: "agent-1" } as const;
const second = { backend: "claude", threadId: "agent-2" } as const;
const selected = { version: "1.4.99", currentVersion: "1.4.98", train: "Stable" };

function binding(identity: typeof first | typeof second, id: string, conversationId: string): MessagingBindingRecord {
  return {
    ...identity, id, targetKind: "agent_thread", createdAt: 1, updatedAt: 1, authorizedActorIds: [],
    channel: { channel: "slack", conversation: { kind: "channel", id: conversationId, title: "#contrived" } },
  };
}

async function seedAgents() {
  const store = new SqliteOverlayStore(db);
  await store.setThreadAgent({ ...first, agent: { name: "Release Watch" } });
  await store.setThreadAgent({ ...second, agent: { name: "Build Desk" } });
  return store;
}

function startDelivery() {
  let receive: ((notice: AppUpdateNotice) => void) | undefined;
  const deliver = vi.fn(async (target: MessagingBindingRecord, text: string) => ({
    channel: target.channel.channel, outcome: "presented" as const, deliveredAt: 1, text,
  }));
  const stop = subscribeAgentUpdateNotices({
    subscribe: (listener) => {
      receive = listener;
      return () => { receive = undefined; };
    },
    selectDelivery: () => deliver,
    readMachine: () => "Release workstation",
  });
  return { stop, deliver, emit: (phase: AppUpdateNotice["phase"]) => receive?.({ ...selected, phase }) };
}

async function settleNotices() {
  // The fixture transport and store complete in microtasks, with no provider I/O.
  await new Promise<void>((resolve) => setImmediate(resolve));
}

beforeEach(() => { db = openInMemoryStateDb(); bindings = []; });
afterEach(() => { db.close(); vi.unstubAllEnvs(); });

it("admits at most one notice per destination and phase, across subscriber restarts", async () => {
  await seedAgents();
  bindings = [binding(first, "a", "same"), binding(second, "b", "same"), binding(first, "c", "other")];
  await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom("available", "ready"), { minLength: 1, maxLength: 16 }), async (phases) => {
    db.raw.prepare("DELETE FROM app_update_notice_deliveries").run();
    setAgentUpdateNoticeSetting(first, true);
    setAgentUpdateNoticeSetting(second, true);
    const posts: string[] = [];
    for (const phase of phases) {
      const running = startDelivery();
      running.emit(phase);
      running.emit(phase);
      await settleNotices();
      posts.push(...running.deliver.mock.calls.map(([target, text]) =>
        `${target.channel.conversation.id}:${text.includes("update ready") ? "ready" : "available"}`));
      running.stop();
    }
    const ready = phases.indexOf("ready");
    const available = phases.indexOf("available");
    const expected = [
      ...(available >= 0 && (ready === -1 || available < ready) ? ["same:available", "other:available"] : []),
      ...(ready >= 0 ? ["same:ready", "other:ready"] : []),
    ];
    expect(posts.sort()).toEqual(expected.sort());
  }), { numRuns: 25 });
});

it("has no opt-in backfill and removes the opt-in when the Agent is cleared or archived", async () => {
  const overlay = await seedAgents();
  bindings = [binding(first, "a", "same")];
  const subscriber = startDelivery();
  subscriber.emit("available");
  expect(setAgentUpdateNoticeSetting(first, true)).toBe(true);
  subscriber.emit("available");
  await settleNotices();
  expect(subscriber.deliver).not.toHaveBeenCalled();
  subscriber.emit("ready");
  await settleNotices();
  expect(subscriber.deliver).toHaveBeenCalledOnce();
  expect(subscriber.deliver.mock.calls[0]?.[1]).toContain("Settings → Updates → Restart to Update");
  await overlay.setThreadAgent({ ...first, agent: null });
  expect(setAgentUpdateNoticeSetting(first, true)).toBe(false);
  expect((await listAgentUpdateNoticeSettings()).map(({ name }) => name)).toEqual(["Build Desk"]);
  expect(setAgentUpdateNoticeSetting(second, true)).toBe(true);
  await overlay.setThreadArchiveTombstone({ ...second, archivedAt: 2 });
  expect(setAgentUpdateNoticeSetting(second, true)).toBe(false);
  subscriber.stop();
});

it("budgets one opted-in Agent and the successful notice ledger write", async () => {
  const fixture = createTempStateDb("app-update-notice-budget-");
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  db.close();
  db = StateDb.open(fixture.dbPath);
  try {
    await seedAgents();
    bindings = [binding(first, "a", "same")];
    const subscriber = startDelivery();
    const optIn = await measureSqliteWrites(() => setAgentUpdateNoticeSetting(first, true));
    expectSqliteWriteBudget({ scenario: "app-update-notice-opt-in",
      note: "One operator opt-in, once per Agent. About 0 MB/day.", writes: optIn.writes });
    const notice = await measureSqliteWrites(async () => {
      subscriber.emit("ready");
      subscriber.emit("ready");
      await settleNotices();
    });
    expect(subscriber.deliver).toHaveBeenCalledOnce();
    expectSqliteWriteBudget({ scenario: "app-update-notice-ledger",
      note: "One accepted notice plus its repeated event. Measures the new ledger write; provider delivery bookkeeping uses the existing path.", writes: notice.writes });
    subscriber.stop();
  } finally {
    db.close();
    rmSync(fixture.tempDir, { recursive: true, force: true });
    db = openInMemoryStateDb();
  }
});

it("reports a handed-off version only after relaunch and budgets the receipt and its consumption", async () => {
  const fixture = createTempStateDb("app-update-restart-budget-");
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  db.close();
  db = StateDb.open(fixture.dbPath);
  try {
    await seedAgents();
    setAgentUpdateNoticeSetting(first, true);
    const target = binding(first, "release-watch", "releases");
    bindings = [target];
    const ledger = new AppUpdateNoticeStore(db);
    const receipt = { ...first, runtimeId: "original", version: selected.version, connectionId: "workspace:release-bot",
      bindingId: target.id, destination: buildMessagingConversationKey(target.channel) };
    const { writes } = await measureSqliteWrites(async () => {
      expect(ledger.saveRestartReceipt(receipt)).toBe(true);
      expect(ledger.saveRestartReceipt({ ...receipt, runtimeId: "competing" })).toBe(false);
    });
    expectSqliteWriteBudget({ scenario: "app-update-restart-receipt", note: "Persist one accepted native handoff and refuse a competing write.", writes });
    const deliver = vi.fn(async (_target: MessagingBindingRecord, _text: string) => ({
      channel: "slack" as const, outcome: "presented" as const, deliveredAt: 1,
    }));
    const reconcile = (runtimeId: string, currentVersion: string) => reconcileAppUpdateRestart({
      runtimeId, currentVersion: () => currentVersion, selectDelivery: () => deliver,
      readMachine: () => undefined, onConnection: () => () => undefined,
      isSameConnection: (_binding, connectionId) => connectionId === receipt.connectionId,
    });
    const stopOld = reconcile(receipt.runtimeId, selected.currentVersion);
    await settleNotices();
    expect(deliver).not.toHaveBeenCalled();
    stopOld();
    const outcome = await measureSqliteWrites(async () => {
      const stopNew = reconcile("relaunched", selected.version);
      await settleNotices();
      stopNew();
    });
    expect(deliver.mock.calls[0]?.[1]).toContain(`v${selected.version} is running`);
    expect(ledger.readRestartReceipt()).toBeUndefined();
    expectSqliteWriteBudget({ scenario: "app-update-restart-outcome", note: "Consume the restart receipt after the provider accepts the outcome.", writes: outcome.writes });
  } finally {
    db.close();
    rmSync(fixture.tempDir, { recursive: true, force: true });
    db = openInMemoryStateDb();
  }
});
