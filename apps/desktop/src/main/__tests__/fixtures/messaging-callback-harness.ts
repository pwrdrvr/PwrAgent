import { setImmediate } from "node:timers/promises";
import type { MessagingPermissionId, NavigationThreadSummary, SubmitServerRequestRequest } from "@pwragent/shared";
import type { MessagingBindingRecord, MessagingCapabilityProfile, MessagingInboundCallbackEvent, MessagingSurfaceIntent, MessagingSurfaceRef } from "@pwragent/messaging-interface";
import { PERMISSIVE_CAPABILITY_PROFILE } from "@pwragent/messaging-interface/testing";
import type { MessagingBackendBridge } from "../../messaging/core/messaging-adapter";
import { MessagingController, type MessagingControllerOptions } from "../../messaging/core/messaging-controller";
import { SqliteMessagingStore } from "../../state/messaging-store-sqlite";
import { openInMemoryStateDb } from "../sqlite-test-utils";

export async function messagingCallbackHarness(options: {
  channel?: "telegram" | "discord";
  profile?: MessagingCapabilityProfile;
  beforeSubmit?: (request: SubmitServerRequestRequest) => Promise<void>;
  store?: SqliteMessagingStore;
} = {}) {
  const db = options.store ? undefined : openInMemoryStateDb();
  const store = options.store ?? new SqliteMessagingStore(db!);
  const channel = options.channel ?? "telegram";
  const binding: MessagingBindingRecord = {
    id: `fixture-binding-${channel}`, backend: "codex", threadId: "fixture-thread", createdAt: 1_000, updatedAt: 1_000,
    authorizedActorIds: ["fixture-actor"], channel: { channel, conversation: { id: `fixture-source-${channel}`, kind: "dm", isDirectMessage: true } },
  };
  await store.upsertBinding(binding);
  const thread: NavigationThreadSummary = {
    id: binding.threadId, source: "codex", title: "Fixture thread", titleSource: "explicit",
    executionMode: "default", linkedDirectories: [], inbox: { inInbox: false },
  };
  const submitted: SubmitServerRequestRequest[] = [];
  const deliveries: { intent: MessagingSurfaceIntent; surface: MessagingSurfaceRef }[] = [];
  const permissions = new Set<MessagingPermissionId>(["thread.status.view", "thread.resume", "message.reply", "approval.respond.escalation", "elicitation.answer"]);
  const backend = {
    getNavigationSnapshot: async () => { throw new Error("Unexpected broad navigation read"); },
    getNavigationSelectedDetail: async request => ({ protocol: 2, revision: "fixture", ref: request.ref, identity: "present", readiness: "ready", thread }),
    getThreadAdmissionState: async () => ({ thread, threadStatus: "active" }),
    startTurn: async request => ({ backend: request.backend, threadId: request.threadId, turnId: "fixture-turn" }),
    readThreadStatus: async () => "active",
    submitServerRequest: async request => {
      await options.beforeSubmit?.(request);
      await setImmediate();
      submitted.push(request);
      return { backend: request.backend, threadId: request.threadId, turnId: request.turnId, requestId: request.requestId };
    },
  } satisfies MessagingBackendBridge;
  let sequence = 0;
  let now = 1_000;
  const controllerOptions: MessagingControllerOptions = {
    store, backend, channel, authorizedActorIds: ["fixture-actor"], now: () => now, logger: {},
    rbacPolicy: {
      isEnforcing: () => true,
      resolve: () => ({ permissions, roleIds: ["fixture"], matchedSubjects: [], rejected: false }),
    },
    adapter: { capabilityProfile: options.profile ?? PERMISSIVE_CAPABILITY_PROFILE, deliver: async intent => {
      await setImmediate();
      const surface = intent.targetSurface ?? { id: `fixture-surface-${++sequence}`, channel };
      deliveries.push({ intent, surface });
      return { outcome: "presented", channel, deliveredAt: 1_000, surface };
    } },
  };
  const controller = new MessagingController(controllerOptions);
  const event = (actionId: string, surface?: MessagingSurfaceRef, value?: MessagingInboundCallbackEvent["value"]): MessagingInboundCallbackEvent => ({
    id: `fixture-event-${++sequence}`, kind: "callback", receivedAt: 1_000, channel: binding.channel,
    actor: { platformUserId: "fixture-actor" }, actionId, value, sourceSurface: surface,
    interaction: { channel, id: surface?.id ?? "fixture-interaction" },
  });
  return {
    controller, store, backend, binding, submitted, deliveries, permissions, event,
    hidePendingIntentsInOverlay: () => {
      controllerOptions.store = new Proxy(store, { get: (target, key) => {
        if (key === "findActivePendingIntentForChannel") return async () => undefined;
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      } });
    },
    approve: async (requestId: string) => {
      // The model's "newer proposal" means a later persisted creation time.
      // A fixed fixture clock makes the store's two records tied, not newer.
      now += 1;
      await controller.handleBackendPendingRequest("codex", { method: "item/commandExecution/requestApproval", params: {
        threadId: binding.threadId, turnId: "fixture-turn", requestId, command: "fixture", prompt: "Allow the fixture command?",
      } });
      const delivery = deliveries.findLast(item => item.intent.kind === "approval" && item.intent.requestContext?.requestId === requestId);
      if (!delivery || delivery.intent.kind !== "approval") throw new Error("Fixture approval was not delivered");
      return { surface: delivery.surface, decisions: delivery.intent.decisions };
    },
    click: async (actionId: string, surface?: MessagingSurfaceRef, value?: MessagingInboundCallbackEvent["value"]) => {
      await controller.handleInboundEvent(event(actionId, surface, value));
    },
    help: async () => {
      await controller.handleInboundEvent({
        id: `fixture-help-${++sequence}`, kind: "command", receivedAt: now,
        channel: binding.channel, actor: { platformUserId: "fixture-actor" },
        command: "help", args: [], rawText: "/help",
      });
      const delivery = deliveries.at(-1);
      if (delivery?.intent.kind !== "confirmation") throw new Error("Fixture help was not delivered");
      return { intent: delivery.intent, surface: delivery.surface };
    },
    close: async () => { controller.dispose(); await controller.whenToolUpdatesSettled(); db?.close(); },
  };
}
