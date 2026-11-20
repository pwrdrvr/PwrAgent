import { setImmediate } from "node:timers/promises";
import type {
  NavigationThreadSummary,
  ThreadMessagingBindingTransition,
} from "@pwragent/shared/contracts/navigation";
import type { MessagingBindingRecord, MessagingChannelRef, MessagingInboundCommandEvent, MessagingSurfaceIntent, MessagingSurfaceRef } from "@pwragent/messaging-interface";
import { PERMISSIVE_CAPABILITY_PROFILE } from "@pwragent/messaging-interface/testing";
import type { MessagingAdapter, MessagingBackendBridge } from "../../messaging/core/messaging-adapter";
import { MessagingController, type MessagingControllerOptions } from "../../messaging/core/messaging-controller";
import { SqliteMessagingStore } from "../../state/messaging-store-sqlite";
import { openInMemoryStateDb } from "../sqlite-test-utils";

export async function messagingBindingHarness(options: {
  channel?: "telegram" | "discord";
  rename?: boolean;
  pinStatus?: boolean;
  clock?: () => number;
  store?: SqliteMessagingStore;
} = {}) {
  const db = options.store ? undefined : openInMemoryStateDb();
  const store = options.store ?? new SqliteMessagingStore(db!);
  const channel: MessagingChannelRef = { channel: options.channel ?? "telegram", conversation: {
    kind: "dm", id: `binding-fixture-${options.channel ?? "telegram"}`, isDirectMessage: true, title: "Fixture conversation",
  } };
  const trace: string[] = [];
  const deliveries: MessagingSurfaceIntent[] = [];
  const transitions: ThreadMessagingBindingTransition[] = [];
  const threads = new Map(["thread-a", "thread-b"].map(id => [id, {
    id, source: "codex", title: `Fixture ${id}`, titleSource: "explicit", executionMode: "default", linkedDirectories: [], inbox: { inInbox: false },
  } satisfies NavigationThreadSummary]));
  const faults = { cleanup: false, audit: false, listener: false, retire: false };
  const hooks: { beforeDelivery?: (intent: MessagingSurfaceIntent) => Promise<void> } = {};
  const backend = {
    getNavigationSnapshot: async () => { throw new Error("Unexpected broad navigation read"); },
    getNavigationSelectedDetail: async request => ({ protocol: 2, revision: "fixture", ref: request.ref,
      identity: "present", readiness: "ready", thread: threads.get(request.ref.threadId),
    }),
    getThreadAdmissionState: async request => ({ thread: threads.get(request.threadId), threadStatus: "idle" }),
    readThreadStatus: async () => "idle",
    startTurn: async request => ({ backend: request.backend, threadId: request.threadId, turnId: "fixture-turn" }),
    recordMessagingBindingTransition: async request => {
      trace.push(`audit:${request.transition.action}`);
      if (faults.audit) throw new Error("Fixture audit failure");
      transitions.push(request.transition);
    },
  } satisfies MessagingBackendBridge;
  const overlay = new Proxy(store, { get: (target, key) => {
    if (key === "upsertBinding") return async (...args: Parameters<SqliteMessagingStore["upsertBinding"]>) => {
      trace.push("persist"); return await target.upsertBinding(...args);
    };
    if (key === "revokeBinding") return async (...args: Parameters<SqliteMessagingStore["revokeBinding"]>) => {
      trace.push("revoke"); return await target.revokeBinding(...args);
    };
    if (key === "deletePendingIntentsForChannel") return async (...args: Parameters<SqliteMessagingStore["deletePendingIntentsForChannel"]>) => {
      if (faults.cleanup) throw new Error("Fixture pending cleanup failure");
      return await target.deletePendingIntentsForChannel(...args);
    };
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  let sequence = 0;
  let now = 1_000;
  const controllerOptions: MessagingControllerOptions = {
    store: overlay, backend, channel: channel.channel, authorizedActorIds: ["fixture-actor"], now: options.clock ?? (() => ++now),
    logger: {}, onBindingChanged: () => { trace.push("changed"); if (faults.listener) throw new Error("Fixture listener failure"); },
    adapter: {
      capabilityProfile: PERMISSIVE_CAPABILITY_PROFILE,
      ...(options.rename ? { setConversationTitle: async (request: Parameters<NonNullable<MessagingAdapter["setConversationTitle"]>>[0]) => ({
        outcome: "updated" as const, title: request.title, channel: request.channel.channel,
        conversation: request.channel.conversation, updatedAt: now,
      }) } : {}),
      deliver: async intent => {
        await hooks.beforeDelivery?.(intent);
        await setImmediate();
        if (faults.retire && intent.id.startsWith("status-retire:")) throw new Error("Fixture retirement failure");
        deliveries.push(intent);
        if (intent.id.startsWith("activity-closed:")) trace.push("activity:closed");
        if (intent.id.startsWith("status-retire:")) trace.push("status:retired");
        if (intent.kind === "dismiss") trace.push("unpin");
        if (intent.kind === "confirmation" && intent.title.includes("detached")) trace.push("confirmed");
        const surface: MessagingSurfaceRef = intent.targetSurface ?? { channel: channel.channel, id: `fixture-surface-${++sequence}` };
        return { outcome: options.pinStatus && intent.delivery?.pin ? "pinned" : "presented", channel: channel.channel, deliveredAt: now, surface };
      },
    },
  };
  const controller = new MessagingController(controllerOptions);
  const event = (command: string): MessagingInboundCommandEvent => ({
    kind: "command", id: `fixture-command-${++sequence}`, command, args: [], rawText: `/${command}`,
    receivedAt: now, channel, actor: { platformUserId: "fixture-actor" },
  });
  const active = () => store.findActiveBindingForChannel(channel);
  return {
    controller, controllerOptions, store, channel, backend, hooks, faults, trace, deliveries, transitions, event, active,
    bind: async (threadId: string) => {
      await controller.handleInboundEvent({ ...event("resume"), kind: "callback", actionId: `bind:codex:${threadId}`,
        value: { backend: "codex", threadId }, interaction: { channel: channel.channel, id: "fixture-picker" },
      });
      const binding = await active();
      if (!binding) throw new Error("Fixture binding was not created");
      return binding;
    },
    command: async (command: string) => { await controller.handleInboundEvent(event(command)); },
    metadata: async (title: string) => {
      channel.conversation.title = title;
      await controller.handleInboundChannelMetadata({ channel, observedAt: ++now, eventId: `fixture-metadata-${++sequence}` });
    },
    revoke: async (binding: MessagingBindingRecord) => await controller.handleBindingRevokeRequest(binding),
    close: async () => { controller.dispose(); await controller.whenToolUpdatesSettled(); db?.close(); },
  };
}
