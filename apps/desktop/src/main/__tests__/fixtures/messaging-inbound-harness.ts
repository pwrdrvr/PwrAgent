import { setImmediate } from "node:timers/promises";
import type { NavigationThreadSummary } from "@pwragent/shared";
import type { MessagingChannelRef, MessagingInboundTextEvent, MessagingSurfaceIntent } from "@pwragent/messaging-interface";
import { PERMISSIVE_CAPABILITY_PROFILE } from "@pwragent/messaging-interface/testing";
import type { MessagingBackendBridge } from "../../messaging/core/messaging-adapter";
import { MessagingController, type MessagingControllerOptions } from "../../messaging/core/messaging-controller";
import { SqliteMessagingStore } from "../../state/messaging-store-sqlite";
import { openInMemoryStateDb } from "../sqlite-test-utils";

export async function messagingInboundHarness(options: {
  channel?: "telegram" | "discord";
  backend?: "codex" | "claude";
  route?: "binding" | "default-agent";
  shared?: boolean;
  reportsMention?: boolean;
  responseMode?: "every_message" | "mention_only";
  fullAccess?: boolean;
  allowResume?: boolean;
  ownsQueue?: boolean;
  clock?: () => number;
  maxActions?: number;
} = {}) {
  const db = openInMemoryStateDb();
  const store = new SqliteMessagingStore(db);
  let now = 1_000;
  let sequence = 0;
  let status: "idle" | "active" = "idle";
  const channel: MessagingChannelRef = { channel: options.channel ?? "telegram", conversation: {
    id: "fixture-conversation", kind: options.shared ? "channel" : "dm", isDirectMessage: !options.shared,
  } };
  const trace: string[] = [];
  const deliveries: MessagingSurfaceIntent[] = [];
  const starts: Array<Parameters<MessagingBackendBridge["startTurn"]>[0]> = [];
  const admissions: string[] = [];
  const hooks: {
    start?: () => Promise<void>;
    admission?: (threadId: string) => Promise<void>;
    outcome: "started" | "queued" | "failed";
    postStartFailure?: boolean;
  } = { outcome: "started" };
  const thread = (id: string): NavigationThreadSummary => ({
    id, source: options.backend ?? "codex", title: "Fixture target", titleSource: "explicit", linkedDirectories: [], inbox: { inInbox: false },
    executionMode: options.fullAccess ? "full-access" : "default",
    agent: options.route === "default-agent" ? { name: "Fixture Agent", instructionLineCount: 1, instructionsTooLong: false, updatedAt: now } : undefined,
  });
  const backend = {
    ownsTurnQueue: options.ownsQueue ?? true,
    getNavigationSnapshot: async () => { throw new Error("Inbound replies must not walk the fleet"); },
    getNavigationSelectedDetail: async request => ({ protocol: 2, revision: "fixture", ref: request.ref,
      identity: "present", readiness: "ready", thread: thread(request.ref.threadId),
    }),
    getThreadAdmissionState: async request => {
      admissions.push(request.threadId);
      await hooks.admission?.(request.threadId);
      return { thread: thread(request.threadId), threadStatus: status };
    },
    readThreadStatus: async () => status,
    startTurn: async request => {
      starts.push(request); trace.push("start:issued");
      await hooks.start?.();
      if (hooks.outcome === "failed") { trace.push("start:failed"); throw new Error("Fixture startup failure"); }
      trace.push("start:accepted");
      if (hooks.outcome === "started") status = "active";
      return { backend: request.backend, threadId: request.threadId, turnId: `fixture-turn-${starts.length}`,
        ...(hooks.outcome === "queued" ? { queueStatus: "queued" as const, queueEntryId: `fixture-queue-${starts.length}` } : {}),
      };
    },
  } satisfies MessagingBackendBridge;
  const actionCapabilities = PERMISSIVE_CAPABILITY_PROFILE.actions;
  const controllerOptions: MessagingControllerOptions = {
    store, backend, channel: channel.channel, authorizedActorIds: ["fixture-actor"], now: options.clock ?? (() => ++now), inputDebounceMs: 0,
    responseModeForConversation: () => options.responseMode ?? "every_message",
    fullAccessControls: { allowThreadResume: options.allowResume ?? true, allowEscalation: false, warningPolicy: "always" },
    logger: {
      info: message => { if (message === "messaging turn started") trace.push("started:reported"); },
      debug: message => { if (message === "messaging inbound metadata refresh failed") trace.push("metadata:failed"); },
    },
    adapter: {
      capabilityProfile: { ...PERMISSIVE_CAPABILITY_PROFILE, conversationInput: {
        ...PERMISSIVE_CAPABILITY_PROFILE.conversationInput, reportsBotMention: options.reportsMention ?? false,
      }, ...(options.maxActions === undefined || !actionCapabilities
        ? {} : { actions: { ...actionCapabilities, maxActions: options.maxActions } }) },
      deliver: async intent => {
        trace.push(`deliver:${intent.kind}`);
        if (hooks.postStartFailure && intent.kind === "status") throw new Error("Fixture post-acceptance failure");
        deliveries.push(intent);
        return { outcome: "presented", channel: channel.channel, deliveredAt: now,
          surface: { channel: channel.channel, id: `fixture-surface-${++sequence}` },
        };
      },
    },
  };
  const controller = new MessagingController(controllerOptions);
  if (options.route === "default-agent") {
    await store.upsertDefaultAgentAssignment({ id: "fixture-default", scope: { kind: "conversation", channel },
      target: { kind: "agent", backend: "codex", threadId: "fixture-thread" }, createdAt: now, updatedAt: now,
    });
  } else {
    await store.upsertBinding({ id: "fixture-binding", backend: options.backend ?? "codex", threadId: "fixture-thread", channel,
      authorizedActorIds: ["fixture-actor"], createdAt: now, updatedAt: now,
    });
  }
  const event = (text = "Fixture prompt", mention = false): MessagingInboundTextEvent => ({
    id: `fixture-event-${++sequence}`, kind: "text", actor: { platformUserId: "fixture-actor" }, channel, text, receivedAt: now, botMention: mention,
  });
  return {
    db, controller, controllerOptions, backend, store, channel, trace, deliveries, starts, admissions, hooks, event,
    setThreadStatus: (next: "idle" | "active") => { status = next; },
    finish: async (terminal: "completed" | "failed" | "cancelled", turnId = `fixture-turn-${starts.length}`) => {
      status = "idle";
      await controller.handleBackendEvent({ backend: options.backend ?? "codex", notification: terminal === "failed" ? {
        method: "turn/failed",
        params: { threadId: "fixture-thread", turnId, turn: { id: turnId, status: "failed", error: { message: "Fixture terminal failure" } } },
      } : {
        method: "turn/completed",
        params: { threadId: "fixture-thread", turnId, turn: { id: turnId, status: terminal, output: [] } },
      } });
      await setImmediate();
    },
    close: async () => { controller.dispose(); await controller.whenToolUpdatesSettled(); await setImmediate(); db.close(); },
  };
}
