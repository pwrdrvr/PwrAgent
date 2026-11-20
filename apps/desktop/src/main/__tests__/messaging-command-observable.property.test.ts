import { setImmediate } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { ScheduledThreadAction } from "@pwragent/shared/contracts/scheduled-thread-actions";
import type { MessagingBindingRecord, MessagingSurfaceIntent } from "@pwragent/messaging-interface";
import { PERMISSIVE_CAPABILITY_PROFILE } from "@pwragent/messaging-interface/testing";
import type { MessagingBackendBridge } from "../messaging/core/messaging-adapter";
import { MessagingController } from "../messaging/core/messaging-controller";
import { SqliteMessagingStore } from "../state/messaging-store-sqlite";
import { openInMemoryStateDb } from "./sqlite-test-utils";

// Observable oracle: the backend owns acceptance, and the adapter owns visible
// confirmation. No private controller member or command helper calculates the
// expected projection. Run unchanged against pinned main before extraction.
async function harness() {
  const db = openInMemoryStateDb();
  const store = new SqliteMessagingStore(db);
  const trace: string[] = [];
  const intents: MessagingSurfaceIntent[] = [];
  const actions: ScheduledThreadAction[] = [];
  const channel: MessagingBindingRecord["channel"] = {
    channel: "telegram", conversation: { id: "fixture-source", kind: "dm", isDirectMessage: true },
  };
  const binding: MessagingBindingRecord = {
    id: "fixture-binding", backend: "codex", threadId: "fixture-thread", channel,
    authorizedActorIds: ["fixture-actor"], createdAt: 1_000, updatedAt: 1_000,
  };
  await store.upsertBinding(binding);
  let fail = false;
  const backend = {
    getNavigationSnapshot: async () => { throw new Error("Unexpected navigation read"); },
    getThreadAdmissionState: async () => { throw new Error("Unexpected admission read"); },
    startTurn: async () => { throw new Error("Unexpected turn start"); },
    createScheduledThreadAction: async request => {
      trace.push("create");
      expect(request).toMatchObject({ backend: "codex", threadId: "fixture-thread", origin: "messaging", turn: {
        messageOrigin: { kind: "messaging", messaging: { actor: { platformUserId: "fixture-actor" }, surface: { id: "fixture-source" } } },
      } });
      await setImmediate();
      const action: ScheduledThreadAction = {
        ...request, origin: request.origin ?? "messaging", id: `scheduled-action:fixture${actions.length}`, status: fail ? "failed" : "scheduled",
        errorMessage: fail ? "Fixture rejection" : undefined, createdAt: 1_000, updatedAt: 1_000,
      };
      actions.push(action);
      trace.push("accepted");
      return { action };
    },
    listScheduledThreadActions: async () => { trace.push("list"); return { actions }; },
    cancelScheduledThreadAction: async () => {
      trace.push("cancel");
      await setImmediate();
      if (fail) throw new Error("Fixture rejection");
      trace.push("accepted");
      return { action: { ...actions[0], status: "cancelled" as const } };
    },
    sendScheduledThreadActionNow: async () => {
      trace.push("send");
      await setImmediate();
      trace.push("accepted");
      return { action: { ...actions[0], status: fail ? "failed" as const : "started" as const, errorMessage: fail ? "Fixture rejection" : undefined } };
    },
  } satisfies MessagingBackendBridge;
  const options = {
    store, backend,
    adapter: { capabilityProfile: PERMISSIVE_CAPABILITY_PROFILE, deliver: async (intent: MessagingSurfaceIntent) => {
      await setImmediate();
      trace.push("deliver"); intents.push(intent);
      return { outcome: "presented" as const, channel: "telegram" as const, deliveredAt: 1_000, surface: { id: intent.id, channel: "telegram" as const } };
    } },
    channel: "telegram" as const, authorizedActorIds: ["fixture-actor"], now: () => 1_000, logger: {},
  };
  const controller = new MessagingController(options);
  let sequence = 0;
  return {
    trace, intents,
    unbindInOverlay: () => {
      options.store = new Proxy(store, { get: (target, key) => {
        if (key === "findActiveBindingForChannel") return async () => undefined;
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      } });
    },
    command: async (command: string, args: string[], rejected: boolean) => {
      fail = rejected;
      trace.length = 0; intents.length = 0;
      await controller.handleInboundEvent({
        kind: "command", id: `command-${++sequence}`, command, args, rawText: `/${command} ${args.join(" ")}`,
        receivedAt: 1_000, channel, actor: { platformUserId: "fixture-actor" },
      });
    },
    close: async () => { controller.dispose(); await controller.whenToolUpdatesSettled(); db.close(); },
  };
}

describe("messaging command observable protocol", () => {
  it("confirms scheduled work only after backend acceptance and exposes rejection", async () => {
    await fc.assert(fc.asyncProperty(fc.boolean(), fc.constantFrom("send", "now", "cancel", "remove"), fc.boolean(), async (createFails, operation, mutationFails) => {
      const f = await harness();
      try {
        await f.command("schedule", ["2m", "Fixture", "message"], createFails);
        expect(f.trace).toEqual(["create", "accepted", "deliver"]);
        expect(f.intents).toHaveLength(1);
        expect(f.intents[0]).toMatchObject(createFails
          ? { kind: "error", body: "Fixture rejection" }
          : { kind: "confirmation", title: "Message scheduled", body: expect.stringContaining("Fixture message") });
        // Both a failed and an accepted action remain addressable in the owner
        // history. A mutation is a new backend decision, not a local success.
        await f.command("scheduled", [operation, "fixture0"], mutationFails);
        const cancel = operation === "cancel" || operation === "remove";
        expect(f.trace).toEqual(["list", cancel ? "cancel" : "send", ...(cancel && mutationFails ? [] : ["accepted"]), "deliver"]);
        expect(f.intents[0]).toMatchObject(mutationFails
          ? { kind: "error", body: "Fixture rejection" }
          : { kind: "confirmation", title: cancel ? "Scheduled message cancelled" : "Scheduled message sent" });
      } finally { await f.close(); }
    }), { numRuns: 24, seed: 1493810 });
  });

  it("uses the current wrapped overlay store on each command", async () => {
    const f = await harness();
    try {
      f.unbindInOverlay();
      await f.command("schedule", ["2m", "Fixture"], false);
      expect(f.trace).toEqual(["deliver"]);
      expect(f.intents[0]).toMatchObject({ kind: "confirmation", title: "Choose a thread" });
    } finally { await f.close(); }
  });

  it("does not contact the backend for invalid schedule input", async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom([], ["2m"], ["nonsense", "Fixture"]), async args => {
      const f = await harness();
      try {
        await f.command("schedule", [...args], false);
        expect(f.trace).toEqual(["deliver"]);
        expect(f.intents[0]).toMatchObject({ kind: "error", title: "Scheduled message error" });
      } finally { await f.close(); }
    }), { numRuns: 6 });
  });
});
