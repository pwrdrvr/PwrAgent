import type { AgentEvent, NavigationThreadSummary } from "@pwragent/shared";
import type { MessagingBindingRecord } from "@pwragent/messaging-interface";
import { PERMISSIVE_CAPABILITY_PROFILE } from "@pwragent/messaging-interface/testing";
import type { MessagingAdapter, MessagingBackendBridge } from "../../messaging/core/messaging-adapter";
import { MessagingController } from "../../messaging/core/messaging-controller";
import { SqliteMessagingStore } from "../../state/messaging-store-sqlite";
import { openInMemoryStateDb } from "../sqlite-test-utils";

export async function privateResponseHarness(options: {
  failContinuation?: boolean;
  privateSupported?: boolean;
  privateDeliveryFails?: boolean;
  beforePrivateDelivery?: () => Promise<void>;
  deliver?: MessagingAdapter["deliver"];
} = {}) {
  const db = openInMemoryStateDb();
  const store = new SqliteMessagingStore(db);
  let sequence = 0;
  let continuationFailures = 0;
  const privateTexts: string[] = [];
  const sourceTexts: string[] = [];
  const thread = (id: string): NavigationThreadSummary => ({
    id, source: "codex", title: "Fixture Agent", titleSource: "explicit", linkedDirectories: [],
    inbox: { inInbox: false }, executionMode: "default",
    agent: { name: "Fixture Agent", instructionLineCount: 1, instructionsTooLong: false, updatedAt: 1_000 },
  });
  const backend = {
    getNavigationSnapshot: async () => { throw new Error("Unexpected broad navigation read"); },
    getNavigationSelectedDetail: async (request) => ({
      protocol: 2, revision: "fixture", ref: request.ref, identity: "present", readiness: "ready", thread: thread(request.ref.threadId),
    }),
    getThreadAdmissionState: async (request) => ({ thread: thread(request.threadId), threadStatus: "idle" }),
    startTurn: async (request) => ({ backend: request.backend, threadId: request.threadId, turnId: `turn-${++sequence}` }),
    readThreadStatus: async () => "idle",
  } satisfies Pick<MessagingBackendBridge, "getNavigationSnapshot" | "getNavigationSelectedDetail" | "getThreadAdmissionState" | "startTurn" | "readThreadStatus">;
  const adapter: MessagingAdapter = {
    capabilityProfile: PERMISSIVE_CAPABILITY_PROFILE,
    ...(options.privateSupported === false ? {} : { resolvePrivateConversation: async () => ({
      outcome: "resolved" as const, channel: "telegram" as const,
      conversation: { id: "private-fixture", kind: "dm" as const, isDirectMessage: true }, updatedAt: 1_000,
    }) }),
    deliver: options.deliver ?? (async (intent) => {
      const text = intent.kind === "message" ? intent.parts.filter(part => part.type === "text").map(part => part.text).join("") : "";
      const privateDelivery = intent.audit?.channel.conversation.id === "private-fixture";
      if (privateDelivery) await options.beforePrivateDelivery?.();
      if (privateDelivery && options.privateDeliveryFails) {
        return { outcome: "failed", channel: "telegram", deliveredAt: 1_000, errorMessage: "Fixture provider failure" };
      }
      if (text) (privateDelivery ? privateTexts : sourceTexts).push(text);
      return {
        outcome: "presented", channel: "telegram", deliveredAt: 1_000,
        surface: { id: intent.id, channel: "telegram" },
        ...(privateDelivery && options.failContinuation && text === "Old private answer" ? { continuation: {
          channel: { channel: "telegram" as const, conversation: { id: "failed-continuation", kind: "thread" as const, isDirectMessage: true } },
        } } : {}),
      };
    }),
  };
  const upsert = store.upsertBinding.bind(store);
  store.upsertBinding = async (binding) => {
    if (binding.channel.conversation.id === "failed-continuation") {
      continuationFailures += 1;
      throw new Error("Fixture continuation persistence failure");
    }
    return await upsert(binding);
  };
  const controller = new MessagingController({
    store, backend: backend as MessagingBackendBridge, adapter, authorizedActorIds: ["fixture-actor"],
    channel: "telegram", now: () => 1_000, logger: {}, inputDebounceMs: 0,
  });
  for (const threadId of ["old-thread", "fill-thread"]) {
    const binding: MessagingBindingRecord = {
      id: `binding-${threadId}`, backend: "codex", threadId, targetKind: "agent_thread",
      channel: { channel: "telegram", conversation: { id: `source-${threadId}`, kind: "channel" } },
      authorizedActorIds: ["fixture-actor"], createdAt: 1_000, updatedAt: 1_000, statusPresentation: "on_demand",
    };
    await store.upsertBinding(binding);
  }
  const event = (notification: AgentEvent["notification"]): AgentEvent => ({ backend: "codex", notification });
  return {
    controller, store, privateTexts, sourceTexts,
    continuationFailures: () => continuationFailures,
    start: async (threadId: string, text = "Fixture input") => {
      const before = sequence;
      await controller.handleInboundEvent({
        id: `inbound-${sequence + 1}`, kind: "text", text, receivedAt: 1_000,
        actor: { platformUserId: "fixture-actor" },
        channel: { channel: "telegram", conversation: { id: `source-${threadId}`, kind: "channel" } },
      });
      if (sequence !== before + 1) throw new Error("Fixture inbound turn was not accepted");
      return `turn-${sequence}`;
    },
    answer: async (threadId: string, turnId: string, text: string) => await controller.handleBackendEvent(event({
      method: "item/completed", params: { threadId, turnId, item: { id: `item-${turnId}`, type: "agentMessage", phase: "final", text } },
    })),
    complete: async (threadId: string, turnId: string) => await controller.handleBackendEvent(event({
      method: "turn/completed", params: { threadId, turnId, turn: { id: turnId, status: "completed", output: [] } },
    })),
    close: async () => { controller.dispose(); await controller.whenToolUpdatesSettled(); db.close(); },
  };
}
