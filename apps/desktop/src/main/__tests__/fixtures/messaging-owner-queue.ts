import { createHash, randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { ThreadTurnQueue } from "@pwragent/owner-core/thread-turn-queue";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import type { MessagingBackendBridge } from "../../messaging/core/messaging-adapter";

// Native backend is a double; admission, held failures, cancellation and drain
// are the real owner. The event port is the registry's public bus boundary.
export function messagingOwnerQueue(options: {
  readonly startTurn: MessagingBackendBridge["startTurn"];
  readonly emit: (event: AgentEvent) => Promise<void>;
}) {
  const requests = new Map<string, Parameters<MessagingBackendBridge["startTurn"]>[0]>();
  const pending = new Set<Promise<unknown>>();
  let closed = false;
  const externalActive = new Set<string>();
  const key = (backend: string, threadId: string) => JSON.stringify([backend, threadId]);
  function track<T>(promise: Promise<T>): Promise<T> {
    pending.add(promise);
    void promise.then(() => pending.delete(promise), () => pending.delete(promise));
    return promise;
  }
  const owner = new ThreadTurnQueue({
    isThreadActive: params => externalActive.has(key(params.backend, params.threadId)),
    startTurn: entry => track((async () => {
      const request = requests.get(entry.id)!;
      const result = await options.startTurn({ ...request, input: entry.input });
      await options.emit({ backend: entry.backend, federationTarget: request.federationTarget,
        notification: { method: "turn/started", params: { threadId: entry.threadId, turn: { id: result.turnId, status: "inProgress", items: [] } } },
      });
      return result;
    })()),
    onLifecycle: event => track((async () => {
      const request = requests.get(event.entry.id);
      await options.emit({ backend: event.entry.backend, federationTarget: request?.federationTarget,
        notification: { method: "thread/turnQueue/updated", params: {
          threadId: event.entry.threadId, queueEntryId: event.entry.id, origin: event.entry.origin,
          status: event.type, messageOrigin: event.entry.messageOrigin,
          ...("turnId" in event ? { turnId: event.turnId } : {}), ...("position" in event ? { position: event.position } : {}),
        } },
      });
      if (event.type === "terminal" || event.type === "cancelled") requests.delete(event.entry.id);
    })()),
  });
  const find = (id: string) => owner.getAllQueuedEntries().find(entry => entry.id === id);
  const hash = (entry: { input: unknown; messageOrigin?: unknown }) => createHash("sha256").update(JSON.stringify([entry.input, entry.messageOrigin])).digest("hex");
  const ports: Pick<MessagingBackendBridge, "startTurn" | "readQueuedTurn" | "cancelQueuedTurn"> = {
    startTurn: async request => {
      const id = randomUUID();
      requests.set(id, request);
      try {
        const result = await owner.submit({ ...request, id, origin: "messaging" });
        return { backend: request.backend, threadId: request.threadId, turnId: result.status === "started" ? result.turnId : result.entry.id,
          queueStatus: result.status, queueEntryId: result.entry.id };
      } catch (error) { requests.delete(id); throw error; }
    },
    readQueuedTurn: async request => {
      const entry = find(request.queueEntryId);
      if (!entry) throw new Error("Queued input is no longer waiting");
      return { queueEntryId: entry.id, input: entry.input, messageOrigin: entry.messageOrigin, contentHash: hash(entry) };
    },
    cancelQueuedTurn: async request => {
      const entry = find(request.queueEntryId);
      return { queueEntryId: request.queueEntryId, cancelled: Boolean(entry && hash(entry) === request.expectedContentHash
        && owner.cancelEntryWithDisposition(entry.id).disposition === "cancelled") };
    },
  };
  return {
    owner, ports,
    markActive: (backend: string, threadId: string) => { externalActive.add(key(backend, threadId)); },
    emit: async (event: AgentEvent) => {
      await options.emit(event);
      const { method, params } = event.notification;
      const threadId = "threadId" in params && typeof params.threadId === "string" ? params.threadId : undefined;
      if (!threadId) return;
      if (method === "turn/started") externalActive.add(key(event.backend, threadId));
      if (method === "turn/completed" || method === "turn/failed") {
        const turn = params.turn;
        const turnId = turn && typeof turn === "object" && "id" in turn && typeof turn.id === "string" ? turn.id : undefined;
        externalActive.delete(key(event.backend, threadId));
        track(owner.releaseThread({ backend: event.backend, threadId, turnId, status: method }));
      } else if (method === "thread/status/changed" && params.status && typeof params.status === "object" && "type" in params.status && params.status.type === "idle") {
        externalActive.delete(key(event.backend, threadId));
        track(owner.releaseThread({ backend: event.backend, threadId, status: "idle" }));
      }
    },
    settled: async () => { await setImmediate(); await Promise.allSettled([...pending]); if (closed) requests.clear(); },
    close: () => { closed = true; owner.close(); },
  };
}
