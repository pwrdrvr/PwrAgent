import { rmSync } from "node:fs";
import fc from "fast-check";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppUpdateNoticeStore } from "@pwragent/sqlite-storage/app-update-notice-store";
import type { MessagingBindingRecord } from "@pwragent/messaging-interface";
import { TelegramAdapter, type TelegramBotApi, type TelegramSendMessageRequest } from "@pwragent/messaging-provider-telegram";
import { MessagingAppUpdateControls, type ReadyAppUpdateNotice } from "../messaging/app-update-controls";
import type { AppUpdateNotice } from "../../shared/app-metadata";
import { listAgentUpdateNoticeSettings, reconcileAppUpdateRestart, setAgentUpdateNoticeSetting, subscribeAgentUpdateNotices } from "../messaging/agent-update-notices";
import { buildMessagingConversationKey } from "../messaging/core/messaging-store";
import { MessagingController } from "../messaging/core/messaging-controller";
import { MessagingActivityLog } from "../storage/messaging-activity-log";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { messagingInboundHarness } from "./fixtures/messaging-inbound-harness";
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

function startDelivery(options?: { connected(): boolean; persistCard?: boolean }) {
  let receive: ((notice: AppUpdateNotice) => void) | undefined;
  let connect: (() => void) | undefined;
  const deliver = vi.fn(async (target: MessagingBindingRecord, text: string, _machine?: string, _guard?: unknown, ready?: ReadyAppUpdateNotice) => ({
    channel: target.channel.channel, outcome: "presented" as const, deliveredAt: 1, text,
    ...(options?.persistCard && ready ? { card: { connectionId: "fixture-bot", surface: { channel: "slack" as const, id: "fixture-post" } } } : {}),
  }));
  const stop = subscribeAgentUpdateNotices({
    subscribe: (listener) => {
      receive = listener;
      return () => { receive = undefined; };
    },
    selectDelivery: () => !options || options.connected() ? deliver : undefined,
    readMachine: () => "Release workstation",
    onConnection: options ? (listener) => { connect = listener; return () => { connect = undefined; }; } : undefined,
    restoreReadyCards: options?.persistCard,
  });
  return { stop, deliver, connect: () => connect?.(), emit: (phase: AppUpdateNotice["phase"]) => receive?.({ ...selected, phase }) };
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

it("retains only recipients opted in at the event and restores the saved ready surface on a later owner", async () => {
  await seedAgents();
  bindings = [binding(first, "existing", "room"), binding(second, "late", "late-room")];
  setAgentUpdateNoticeSetting(first, true);
  let connected = false;
  const initial = startDelivery({ connected: () => connected, persistCard: true });
  initial.emit("ready");
  setAgentUpdateNoticeSetting(second, true);
  await settleNotices();
  expect(initial.deliver).not.toHaveBeenCalled();
  connected = true;
  initial.connect();
  await settleNotices();
  expect(initial.deliver.mock.calls.map(([binding]) => binding.id)).toEqual(["existing"]);
  initial.stop();
  // A binding opted in after the original event is eligible for a new event
  // from the relaunched updater, but the old card itself is refreshed in place.
  const relaunched = startDelivery({ connected: () => true, persistCard: true });
  relaunched.emit("ready");
  await settleNotices();
  expect(relaunched.deliver.mock.calls.find(([binding]) => binding.id === "existing")?.[4]).toEqual({
    version: selected.version, restore: true,
    previousCard: { connectionId: "fixture-bot", surface: { channel: "slack", id: "fixture-post" } },
  });
  relaunched.stop();
});

it("keeps an unreachable receipt without blocking a healthy destination or rewriting the first observed version", async () => {
  await seedAgents();
  setAgentUpdateNoticeSetting(first, true);
  setAgentUpdateNoticeSetting(second, true);
  const unavailable = binding(first, "unavailable", "old-room");
  const healthy = binding(second, "healthy", "healthy-room");
  bindings = [unavailable, healthy];
  const ledger = new AppUpdateNoticeStore(db);
  const old = { ...first, runtimeId: "old-runtime", version: selected.currentVersion, connectionId: "bot",
    bindingId: unavailable.id, destination: buildMessagingConversationKey(unavailable.channel) };
  const newer = { ...second, runtimeId: "next-runtime", version: selected.version, connectionId: "bot",
    bindingId: healthy.id, destination: buildMessagingConversationKey(healthy.channel) };
  db.setMeta("messaging-app-update-restart", JSON.stringify(old));
  const deliver = vi.fn(async () => ({ channel: "slack" as const, outcome: "presented" as const, deliveredAt: 1 }));
  const reconcile = (runtimeId: string, currentVersion: string) => reconcileAppUpdateRestart({
    runtimeId, currentVersion: () => currentVersion,
    selectDelivery: (target) => target.id === healthy.id ? deliver : undefined,
    readMachine: () => undefined, onConnection: () => () => undefined, isSameConnection: () => true,
  });
  const firstRestart = reconcile("next-runtime", selected.currentVersion);
  await settleNotices();
  firstRestart();
  expect(ledger.saveRestartReceipt(newer)).toBe(true);
  const secondRestart = reconcile("final-runtime", selected.version);
  await settleNotices();
  expect(deliver).toHaveBeenCalledOnce();
  expect(ledger.listRestartReceipts().map(({ receipt }) => receipt)).toEqual([{ ...old, observedVersion: selected.currentVersion }]);
  secondRestart();
});

it("preserves delivery deduplication when adding ready-card storage to an existing profile", () => {
  const fixture = createTempStateDb("app-update-delivery-upgrade-");
  db.close();
  db = StateDb.open(fixture.dbPath);
  try {
    db.raw.exec("ALTER TABLE app_update_notice_deliveries DROP COLUMN ready_surface");
    db.raw.prepare(`INSERT INTO app_update_notice_deliveries(destination, version, phase, thread_key, binding_id)
      VALUES (?, ?, ?, ?, ?)`).run("fixture-room", selected.version, "ready", "old-thread", "old-binding");
    db.close();
    db = StateDb.open(fixture.dbPath);
    const saved = new AppUpdateNoticeStore(db).readDelivery({ destination: "fixture-room", version: selected.version, phase: "ready" });
    expect(saved).toEqual({ bindingId: "old-binding", readySurface: null });
  } finally {
    db.close();
    rmSync(fixture.tempDir, { recursive: true, force: true });
    db = openInMemoryStateDb();
  }
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
      expect(ledger.saveRestartReceipt({ ...receipt, bindingId: "competing" })).toBe(false);
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
    expect(deliver.mock.calls[0]?.[1]).toContain(`restarted on v${selected.version}`);
    expect(ledger.listRestartReceipts()).toEqual([]);
    expectSqliteWriteBudget({ scenario: "app-update-restart-outcome", note: "Record the first observed version and consume the receipt after delivery.", writes: outcome.writes });
  } finally {
    db.close();
    rmSync(fixture.tempDir, { recursive: true, force: true });
    db = openInMemoryStateDb();
  }
});

it("budgets a changed progress edit through the Telegram adapter and SQLite delivery store", async () => {
  const fixture = createTempStateDb("app-update-progress-budget-");
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  db.close();
  const harness = await messagingInboundHarness({ dbPath: fixture.dbPath, route: "unbound" });
  db = harness.db;
  vi.useFakeTimers();
  let blockers = 1;
  const controls = new MessagingAppUpdateControls({ runtimeId: "fixture-runtime", blockerCount: () => blockers,
    readTarget: () => ({ version: selected.version, selection: "stable" }), install: async () => "refused",
    saveReceipt: () => false, clearReceipt: () => undefined });
  const transport = vi.fn(async (_request: TelegramSendMessageRequest) => ({ message_id: 101, chat: { id: -100777, type: "supergroup" } }));
  const adapter = new TelegramAdapter({ api: { sendMessage: transport, editMessageText: transport } as unknown as TelegramBotApi,
    config: { channel: "telegram", botToken: "12345:fake-token", authorizedActorIds: [{ id: "42", displayName: "" }],
      authorizedSupergroupIds: [{ id: "-100777", displayName: "" }] }, now: Date.now,
    waitForReplyDelay: async (ms) => { vi.setSystemTime(Date.now() + ms); },
    pollOnStart: false, store: harness.store });
  const activity = new MessagingActivityLog(db);
  const audit = vi.spyOn(activity, "record");
  const controller = new MessagingController({ ...harness.controllerOptions, adapter, now: Date.now, appUpdateControls: () => controls,
    authorizedActorIds: ["42"], activityLog: () => activity,
    rbacPolicy: { isEnforcing: () => true, resolve: () => ({ roleIds: ["fixture-role"], matchedSubjects: [],
      permissions: new Set(["message.reply"]), rejected: false }) } });
  try {
    await seedAgents();
    setAgentUpdateNoticeSetting(first, true);
    const target: MessagingBindingRecord = { ...binding(first, "release-watch", "unused"), authorizedActorIds: ["42"],
      channel: { channel: "telegram", conversation: { kind: "channel", id: "-100777" } } };
    await harness.store.upsertBinding(target);
    const started = await controller.deliverAppUpdateNotice(target, `PwrAgent update ready · v${selected.version}`, undefined,
      { isCancelled: () => false }, { version: selected.version });
    const readClick = async () => {
      const handle = transport.mock.lastCall?.[0].reply_markup?.inline_keyboard[0]?.[0]?.callback_data;
      expect(handle).toBeTruthy();
      const callback = await harness.store.resolveCallbackHandle({ handle: handle!, channel: target.channel, actorId: "42", now: Date.now() });
      expect(callback).toBeDefined();
      return { id: "fixture-click", kind: "callback" as const, receivedAt: Date.now(), channel: target.channel,
        actor: { platformUserId: "42" }, interaction: { channel: "telegram", id: handle! }, sourceSurface: started.surface,
        actionId: callback!.actionId, value: callback!.value } as const;
    };
    expect(started.card).toBeDefined();
    const review = await readClick();
    await controller.handleInboundEvent(review);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({
      permission: "tools.instance_management", roleIds: ["fixture-role"], auditAction: review.actionId,
    }) }));
    await controls.handle(review, adapter.retainedSourceConnectionId(), () => true, async () => true, async () => undefined);
    await controls.handle(await readClick(), adapter.retainedSourceConnectionId(), () => true, async () => true, async () => undefined);
    const posts = transport.mock.calls.length;
    const { writes } = await measureSqliteWrites(async () => {
      blockers = 2;
      await vi.advanceTimersByTimeAsync(60_001);
    });
    expect(transport).toHaveBeenCalledTimes(posts + 1);
    expect(transport.mock.lastCall?.[0].text).toContain("2 blockers");
    expectSqliteWriteBudget({ scenario: "app-update-wait-progress", note: "One Telegram progress edit, with unchanged polls read-only. At 12 edits per install and four installs per day, about 1.58 MB/day.", writes });
  } finally {
    controls.dispose();
    controller.dispose();
    vi.useRealTimers();
    await harness.close();
    rmSync(fixture.tempDir, { recursive: true, force: true });
    db = openInMemoryStateDb();
  }
});
