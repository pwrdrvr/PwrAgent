import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import type { NavigationThreadSummary } from "@pwragent/shared";
import type { MessagingActivityStorage } from "@pwragent/owner-core/messaging-activity-storage";
import type { MessagingBindingRecord, MessagingDeliveryResult, MessagingSurfaceIntent } from "@pwragent/messaging-interface";
import { PERMISSIVE_CAPABILITY_PROFILE } from "@pwragent/messaging-interface/testing";
import type { MessagingBackendBridge } from "../messaging/core/messaging-adapter";
import { MessagingController } from "../messaging/core/messaging-controller";
import * as receipts from "../messaging/core/messaging-reply-receipts";
import { StateDb } from "../state/state-db";
import { SqliteMessagingStore } from "../state/messaging-store-sqlite";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

/**
 * Model of the final-reply send state machine (PWR-223). Each final reply
 * meets one fault at a boundary of the send: the marker write, the provider
 * call, the provider's answer, the settle write, or the process itself.
 * After every crash or adapter stop a new controller starts on the same
 * database, as a launch or an adapter restart does, and a last launch ends
 * the run.
 *
 * Oracle: the chat itself. Every final reply is in the chat once, or the
 * operator was told to check it; none is in the chat twice.
 */
const FAULTS = [
  "none",
  // Before the marker: the marker cannot be written.
  "marker-write-fails",
  // After the marker: the process dies before the provider call.
  "crash-before-send",
  // After the marker: the adapter is stopped and nothing replaced it.
  "adapter-stopped",
  // During the send: the provider refuses or errs, landing or not. Only a
  // retryable rate limit proves nothing visible was posted.
  "rate-limited",
  "rate-limited-not-retryable",
  "send-failed",
  "send-throws",
  // After the send: the process dies before the provider answers.
  "crash-after-send",
  // Before the settle: the settle write fails after the provider accepted.
  "settle-write-fails",
] as const;
type Fault = (typeof FAULTS)[number];
type Step = { fault: Fault; landed: boolean };

const BINDING_ID = "fixture-binding";
const THREAD_ID = "fixture-thread";
const CHANNEL = {
  channel: "telegram" as const,
  conversation: { id: "fixture-chat", kind: "dm" as const, isDirectMessage: true, title: "Fixture chat" },
};

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.unstubAllEnvs();
});

/** What outlives a process: the database file, the chat, the transcript. */
function world() {
  const { dbPath, tempDir } = createTempStateDb("reply-delivery-");
  const state = {
    dbPath,
    chat: [] as string[],
    activity: [] as Array<{ summary: string; payload?: Record<string, unknown> }>,
    cards: [] as Array<{ threadId: string; key: string }>,
    transcript: new Map<string, { turnId: string; text: string }>(),
    db: undefined as StateDb | undefined,
  };
  cleanups.push(() => {
    state.db?.close();
    removeTempStateDbDir(tempDir);
  });
  return state;
}
type World = ReturnType<typeof world>;

/** One process: a database handle and a controller with the step's faults. */
function boot(w: World, fault: { current?: Step; crashed?: () => void }, now?: () => number) {
  w.db?.close();
  w.db = StateDb.open(w.dbPath);
  const store = new SqliteMessagingStore(w.db);
  const faulty = new Proxy(store, { get: (target, key) => {
    if (key === "recordDelivery") return async (delivery: Parameters<SqliteMessagingStore["recordDelivery"]>[0]) => {
      if (fault.current?.fault === "marker-write-fails" && delivery.id.startsWith(receipts.OPEN_REPLY_RECEIPT_PREFIX)) {
        throw new Error("Fixture marker write failure");
      }
      return await target.recordDelivery(delivery);
    };
    if (key === "settleDelivery") return async (params: Parameters<SqliteMessagingStore["settleDelivery"]>[0]) => {
      if (fault.current?.fault === "settle-write-fails") throw new Error("Fixture settle write failure");
      return await target.settleDelivery(params);
    };
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const thread = {
    id: THREAD_ID, source: "codex", title: "Fixture thread", titleSource: "explicit", executionMode: "default",
    linkedDirectories: [], inbox: { inInbox: false },
  } satisfies NavigationThreadSummary;
  const backend = {
    getNavigationSnapshot: async () => { throw new Error("Unexpected broad navigation read"); },
    getNavigationSelectedDetail: async (request) => ({
      protocol: 2, revision: "fixture", ref: request.ref, identity: "present", readiness: "ready", thread,
    }),
    getThreadAdmissionState: async () => ({ thread, threadStatus: "active" }),
    readThreadStatus: async () => "active",
    startTurn: async (request) => ({ backend: request.backend, threadId: request.threadId, turnId: "fixture-turn" }),
    readThreadAssistantReply: async (request) => {
      const entry = w.transcript.get(request.itemId);
      return entry?.turnId === request.turnId ? entry.text : undefined;
    },
  } satisfies MessagingBackendBridge;
  const activityLog = {
    record: (entry: Parameters<MessagingActivityStorage["record"]>[0]) => {
      w.activity.push({ summary: entry.summary, payload: entry.payload });
      return { ...entry, id: w.activity.length, createdAt: entry.createdAt ?? 0 };
    },
    recordPlatformResponseActivity: () => {},
    list: () => [],
    getPlatformActivitySummary: () => ({ platforms: [] }),
  } as unknown as MessagingActivityStorage;
  const deliver = async (intent: MessagingSurfaceIntent): Promise<MessagingDeliveryResult> => {
    const text = intent.kind === "message"
      ? intent.parts.map((part) => (part.type === "text" ? part.text : "")).join("")
      : "";
    const ok: MessagingDeliveryResult = {
      channel: "telegram", deliveredAt: 1, outcome: "presented", surface: { channel: "telegram", id: `surface-${w.chat.length}` },
    };
    const step = fault.current;
    if (!step || intent.kind !== "message" || intent.role !== "assistant") {
      if (text) w.chat.push(text);
      return ok;
    }
    switch (step.fault) {
      case "crash-before-send":
        fault.crashed?.();
        return await new Promise<never>(() => {});
      case "crash-after-send":
        w.chat.push(text);
        fault.crashed?.();
        return await new Promise<never>(() => {});
      case "rate-limited":
      case "rate-limited-not-retryable": {
        const retryable = step.fault === "rate-limited";
        // A non-retryable limit may follow a partly posted message.
        if (!retryable && step.landed) w.chat.push(text);
        return {
          channel: "telegram", deliveredAt: 1, outcome: "failed", errorMessage: "Fixture rate limit",
          rateLimit: { scope: { id: "fixture-scope", platform: "telegram", kind: "dm" }, retryAfterMs: 1_000, retryable },
        };
      }
      case "send-failed":
        if (step.landed) w.chat.push(text);
        return { channel: "telegram", deliveredAt: 1, outcome: "failed", errorMessage: "Fixture send failure" };
      case "send-throws":
        if (step.landed) w.chat.push(text);
        throw new Error("Fixture socket reset");
      default:
        w.chat.push(text);
        return ok;
    }
  };
  const controller = new MessagingController({
    channel: "telegram", authorizedActorIds: ["fixture-actor"], store: faulty, backend, logger: {}, now,
    adapter: { capabilityProfile: PERMISSIVE_CAPABILITY_PROFILE, deliver },
    replacementAdapter: { now: () => undefined, settled: async () => undefined },
    activityLog: () => activityLog,
    raiseDeliveryCheck: (params) => { w.cards.push({ threadId: params.threadId, key: params.key }); },
  });
  return { controller, store };
}

async function bind(store: SqliteMessagingStore): Promise<MessagingBindingRecord> {
  return await store.upsertBinding({
    id: BINDING_ID, backend: "codex", threadId: THREAD_ID, channel: CHANNEL,
    authorizedActorIds: ["fixture-actor"], createdAt: 1, updatedAt: 1,
  });
}

/** The recovery pass a launch or an adapter start runs, if this build has one. */
async function start(controller: MessagingController): Promise<void> {
  const recover = (controller as { recoverDeliveryReceipts?: () => Promise<unknown> }).recoverDeliveryReceipts;
  await recover?.call(controller);
}

function finalReply(index: number) {
  const text = `Final reply ${index}.`;
  return {
    text,
    turnId: `turn-${index}`,
    itemId: `item-${index}`,
    event: {
      backend: "codex" as const,
      notification: {
        method: "item/completed" as const,
        params: {
          threadId: THREAD_ID,
          turnId: `turn-${index}`,
          item: { id: `item-${index}`, type: "agentMessage", text, phase: "final_answer" },
        },
      },
    },
  };
}

async function runModel(steps: readonly Step[]): Promise<World> {
  const w = world();
  const fault: { current?: Step; crashed?: () => void } = {};
  let process = boot(w, fault);
  await bind(process.store);
  await start(process.controller);
  for (const [index, step] of steps.entries()) {
    const reply = finalReply(index);
    w.transcript.set(reply.itemId, { turnId: reply.turnId, text: reply.text });
    fault.current = step;
    if (step.fault === "adapter-stopped") process.controller.dispose();
    let crash = false;
    const crashed = new Promise<void>((resolve) => {
      fault.crashed = () => { crash = true; resolve(); };
    });
    // A crashed process never finishes the send; do not wait for it.
    await Promise.race([
      process.controller.handleBackendEvent(reply.event).catch(() => {}),
      crashed,
    ]);
    fault.current = undefined;
    fault.crashed = undefined;
    if (crash) {
      // The process exits: nothing it held in memory survives.
      process.controller.dispose();
      receipts.forgetInFlightReplyReceiptsForTests();
      process = boot(w, fault);
      await start(process.controller);
    } else if (step.fault === "adapter-stopped") {
      process = boot(w, fault);
      await start(process.controller);
    }
  }
  // The next launch, twice: a second pass must change nothing.
  process.controller.dispose();
  receipts.forgetInFlightReplyReceiptsForTests();
  process = boot(w, fault);
  await start(process.controller);
  await start(process.controller);
  process.controller.dispose();
  return w;
}

function outcome(w: World, index: number) {
  const reply = finalReply(index);
  return {
    copies: w.chat.filter((text) => text.includes(reply.text)).length,
    flagged: w.activity.some((entry) => entry.payload?.turnId === reply.turnId)
      && w.cards.some((card) => card.threadId === THREAD_ID),
  };
}

describe("final reply delivery model", () => {
  it("delivers every final reply once or flags it, whatever fault each send meets", async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.record({ fault: fc.constantFrom(...FAULTS), landed: fc.boolean() }), { minLength: 1, maxLength: 5 }),
      async (steps) => {
        const w = await runModel(steps);
        for (const [index, step] of steps.entries()) {
          const { copies, flagged } = outcome(w, index);
          // Never sent again after it may have landed.
          expect(copies, `reply ${index} (${step.fault}) copies`).toBeLessThanOrEqual(1);
          // Delivered once, or flagged.
          expect(copies === 1 || flagged, `reply ${index} (${step.fault}) lost`).toBe(true);
          // Proved non-delivery is sent again, and a clean send raises nothing.
          if (step.fault === "adapter-stopped" || step.fault === "rate-limited") {
            expect(copies, `reply ${index} (${step.fault}) resent`).toBe(1);
          }
          if (step.fault === "none" || step.fault === "marker-write-fails") {
            expect(flagged, `reply ${index} (${step.fault}) false alarm`).toBe(false);
          }
        }
        // Text never enters SQLite.
        const rows = w.db!.raw
          .prepare("SELECT payload FROM deliveries")
          .all() as { payload: string }[];
        for (const [index] of steps.entries()) {
          expect(rows.some((row) => row.payload.includes(finalReply(index).text))).toBe(false);
        }
      },
    ), { numRuns: 60 });
  });

  // The two losses PWR-223 named, pinned so they never depend on the seed.
  it.each([
    ["the adapter is stopped before the send", "adapter-stopped", 1],
    ["PwrAgent restarts between the turn's end and the send", "crash-before-send", 0],
  ] as const)("keeps a final reply when %s", async (_name, fault, copies) => {
    const w = await runModel([{ fault, landed: false }]);
    expect(outcome(w, 0)).toEqual({ copies, flagged: copies === 0 });
  });

  it.each([true, false])("sends an owed approval card again only while it is pending (pending: %s)", async (pending) => {
    const w = world();
    const process = boot(w, {}, () => 5_000);
    const binding = await bind(process.store);
    const intent: MessagingSurfaceIntent = {
      id: "approval-intent", kind: "approval", bindingId: binding.id, createdAt: 1, title: "Run fixture command?",
      decisions: [{ id: "accept", label: "Approve", decision: "accept" }],
    } as MessagingSurfaceIntent;
    if (pending) {
      await process.store.upsertPendingIntent({
        id: "pending-approval", bindingId: binding.id, channel: CHANNEL, intent,
        allowedActorIds: ["fixture-actor"], createdAt: 1, expiresAt: 1_000_000,
      });
    }
    const identity = {
      kind: "approval" as const, backend: "codex" as const, bindingId: binding.id, threadId: THREAD_ID, pendingIntentId: "pending-approval",
    };
    const { bindingId: _bindingId, ...fields } = identity;
    await process.store.recordDelivery(receipts.openReplyReceiptRecord({
      openId: receipts.openReplyReceiptId(identity), bindingId: binding.id, channel: "telegram", intentId: intent.id, at: 1,
      receipt: { ...fields, state: "owed", reason: "adapter-stopped", markedAt: 1, attempts: 1 },
    }));
    await start(process.controller);
    process.controller.dispose();
    expect(await process.store.listDeliveriesWithIdPrefix(receipts.OPEN_REPLY_RECEIPT_PREFIX)).toEqual([]);
    expect(w.activity).toEqual([]);
    expect(w.cards).toEqual([]);
    const settled = Object.values((await process.store.readSnapshot()).deliveries).map((row) => row.receipt?.state);
    expect(settled).toEqual([pending ? "sent" : "withdrawn"]);
  });

  it("flags an owed reply older than 24 hours instead of sending it", async () => {
    const w = world();
    const fault: { current?: Step } = {};
    let process = boot(w, fault);
    await bind(process.store);
    const reply = finalReply(0);
    w.transcript.set(reply.itemId, { turnId: reply.turnId, text: reply.text });
    process.controller.dispose();
    await process.controller.handleBackendEvent(reply.event);
    const [open] = await process.store.listDeliveriesWithIdPrefix(receipts.OPEN_REPLY_RECEIPT_PREFIX);
    expect(open?.receipt).toMatchObject({ state: "owed", reason: "adapter-stopped" });
    // Downgrade: receipts add no table, column or migration. v1.4.12 reads a
    // deliveries row as opaque JSON and keeps it only with these four fields.
    expect(open).toMatchObject({
      id: expect.any(String), channel: "telegram", outcome: "discarded", deliveredAt: expect.any(Number),
    });
    expect((await process.store.readSnapshot()).deliveries[open!.id]).toEqual(open);
    process = boot(w, fault, () => open!.receipt!.markedAt + receipts.REPLY_RECEIPT_TTL_MS + 1);
    await start(process.controller);
    process.controller.dispose();
    expect(outcome(w, 0)).toEqual({ copies: 0, flagged: true });
  });

  it("has a checked-in write budget: two commits per final reply", async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const w = world();
    const process = boot(w, {});
    await bind(process.store);
    const replies = [0, 1, 2, 3, 4].map(finalReply);
    for (const reply of replies) w.transcript.set(reply.itemId, { turnId: reply.turnId, text: reply.text });
    const { writes } = await measureSqliteWrites(async () => {
      for (const reply of replies) await process.controller.handleBackendEvent(reply.event);
    });
    process.controller.dispose();
    expect(w.chat).toHaveLength(5);
    expectSqliteWriteBudget({
      scenario: "messaging-final-reply-receipt",
      note: "Five final replies to one binding: per reply, a pending marker and one settle commit that replaces the delivery row every send already wrote; no message text.",
      writes,
    });
  });
});
