import { createHash } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { ThreadTurnQueue, type ThreadTurnQueueLifecycleEvent } from "@pwragent/owner-core/thread-turn-queue";
import type { AgentEvent, SteerTurnResponse } from "@pwragent/shared";
import type { MessagingBackendBridge } from "../../messaging/core/messaging-adapter";
import { messagingInboundHarness } from "./messaging-inbound-harness";

// The transport/provider are contrived, but admission, FIFO state and queue
// lifecycle are the actual owner-core implementation used by the registry.
export async function messagingCanonicalQueueHarness(options: {
  channel?: "telegram" | "discord";
  backend?: "codex" | "claude";
  remote?: boolean;
  ownsQueueFlag?: boolean;
} = {}) {
  const real = await messagingInboundHarness({ ...options, ownsQueue: options.ownsQueueFlag ?? true });
  const source = options.backend ?? "codex";
  const target = options.remote ? { scope: "remote" as const, instanceId: "fixture-peer" } : undefined;
  if (target) {
    const binding = (await real.store.getBinding("fixture-binding"))!;
    await real.store.upsertBinding({ ...binding, federatedThread: { backend: source, threadId: binding.threadId, target } });
  }
  const nativeStart = real.backend.startTurn.bind(real.backend);
  const requests: Array<Parameters<MessagingBackendBridge["startTurn"]>[0]> = [];
  const steers: Array<Parameters<NonNullable<MessagingBackendBridge["steerTurn"]>>[0]> = [];
  const pending = new Set<Promise<void>>();
  const hooks: {
    admit?: () => Promise<void>;
    lifecycle?: (event: ThreadTurnQueueLifecycleEvent) => Promise<void>;
    steer?: () => Promise<void>;
    disposition?: SteerTurnResponse["disposition"];
  } = {};
  const emit = (event: ThreadTurnQueueLifecycleEvent): Promise<void> => {
    const handling = (async () => {
      await hooks.lifecycle?.(event);
      await real.controller.handleBackendEvent({ backend: event.entry.backend, federationTarget: target,
        notification: { method: "thread/turnQueue/updated", params: {
          threadId: event.entry.threadId, queueEntryId: event.entry.id, origin: event.entry.origin,
          status: event.type, messageOrigin: event.entry.messageOrigin,
          ...("turnId" in event ? { turnId: event.turnId } : {}),
          ...("position" in event ? { position: event.position } : {}),
        } },
      });
    })();
    pending.add(handling);
    void handling.then(() => pending.delete(handling), () => pending.delete(handling));
    return handling;
  };
  const owner = new ThreadTurnQueue({
    startTurn: entry => nativeStart({ ...entry, federationTarget: target }),
    onLifecycle: emit,
    now: real.controllerOptions.now,
  });
  const queued = () => owner.getQueuedEntries({ backend: source, threadId: "fixture-thread" });
  const contentHash = (entry: { input: unknown; messageOrigin?: unknown }) => createHash("sha256")
    .update(JSON.stringify([entry.input, entry.messageOrigin])).digest("hex");
  const backend: MessagingBackendBridge = {
    ...real.backend,
    startTurn: async request => {
      requests.push(request);
      await hooks.admit?.();
      const result = await owner.submit({ ...request, origin: "messaging" });
      return { backend: request.backend, threadId: request.threadId,
        turnId: result.status === "started" ? result.turnId : result.entry.id,
        queueEntryId: result.entry.id, queueStatus: result.status };
    },
    readQueuedTurn: async request => {
      const entry = queued().find(entry => entry.id === request.queueEntryId);
      if (!entry) throw new Error("Fixture queued input is no longer waiting");
      return { queueEntryId: entry.id, input: entry.input, messageOrigin: entry.messageOrigin, contentHash: contentHash(entry) };
    },
    cancelQueuedTurn: async request => {
      const entry = queued().find(entry => entry.id === request.queueEntryId);
      if (!entry || request.expectedContentHash !== contentHash(entry)) return { queueEntryId: request.queueEntryId, cancelled: false };
      const result = owner.cancelEntryWithDisposition(request.queueEntryId);
      return { queueEntryId: request.queueEntryId, cancelled: result.disposition === "cancelled" };
    },
    steerTurn: async request => {
      steers.push(request);
      await hooks.steer?.();
      return { backend: request.backend, threadId: request.threadId, turnId: request.expectedTurnId, disposition: hooks.disposition };
    },
  };
  real.controllerOptions.backend = backend;
  const settleBus = async () => { await Promise.all([...pending]); await setImmediate(); await Promise.all([...pending]); };
  return {
    ...real, backend, owner, requests, steers, queueHooks: hooks, queued, settleBus,
    callback: (actionId: string) => ({ ...real.event(), kind: "callback" as const, interaction: { channel: real.channel.channel, id: "fixture-interaction" }, actionId }),
    finishOwner: async (terminal: "completed" | "failed" | "cancelled", turnId = `fixture-turn-${real.starts.length}`) => {
      real.setThreadStatus("idle");
      const event: AgentEvent = { backend: source, federationTarget: target, notification: terminal === "failed"
        ? { method: "turn/failed", params: { threadId: "fixture-thread", turnId, turn: { id: turnId, status: "failed", error: { message: "Fixture failure" } } } }
        : { method: "turn/completed", params: { threadId: "fixture-thread", turnId, turn: { id: turnId, status: terminal, output: [] } } } };
      await real.controller.handleBackendEvent(event);
      await owner.releaseThread({ backend: source, threadId: "fixture-thread", turnId, status: event.notification.method });
      await settleBus();
    },
    close: async () => {
      await real.controller.whenQueuedTurnActionsSettled();
      owner.close();
      await settleBus();
      await real.close();
    },
  };
}
