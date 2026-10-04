import type {
  AgentEvent,
  AppServerBackendKind,
  AppServerPendingRequestNotification,
  ListOperatorRequestsResponse,
  OperatorRequestsChangedEvent,
  OperatorServerRequest,
} from "@pwragent/shared";
import {
  MAX_OPERATOR_ITEM_KEY_LENGTH,
  codexAsyncQuestionReplyMessageId,
  operatorServerRequestItemKey,
  readCodexAsyncQuestionRepliesFromNotification,
  readCodexAsyncQuestionsFromNotification,
} from "@pwragent/shared";
import type { OperatorRequestStore } from "./operator-request-store.js";

/** The registry surface the service reads. */
export type OperatorRequestRegistry = {
  listPendingServerRequests(): Array<{
    backend: AppServerBackendKind;
    notification: AppServerPendingRequestNotification;
  }>;
  onEvent(listener: (event: AgentEvent) => void | Promise<void>): () => void;
};

export type OperatorRequestServiceOptions = {
  registry: OperatorRequestRegistry;
  store: OperatorRequestStore;
  broadcast: (event: OperatorRequestsChangedEvent) => void;
  now?: () => number;
};

/**
 * What every local thread is waiting on the operator for.
 *
 * Server requests are read live from the registry, which already holds every
 * one; this only remembers when each was first seen. Async questions are not
 * requests at all, so the service records each from its `item/completed` event
 * and closes it when a reply names it, the operator dismisses it, or its
 * thread is archived.
 *
 * The change event is a marker. It fires when the set of pending requests
 * changes, a question opens or closes, or a seen mark lands; never per
 * streamed event: deltas are skipped, and the request signature is compared
 * before anything is sent.
 */
export class OperatorRequestService {
  private readonly registry: OperatorRequestRegistry;
  private readonly store: OperatorRequestStore;
  private readonly broadcast: (event: OperatorRequestsChangedEvent) => void;
  private readonly now: () => number;
  private readonly firstSeenAt = new Map<string, number>();
  private requestSignature = "";
  private unsubscribe: (() => void) | undefined;

  constructor(options: OperatorRequestServiceOptions) {
    this.registry = options.registry;
    this.store = options.store;
    this.broadcast = options.broadcast;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    this.stop();
    try {
      this.store.prune(this.now());
    } catch {
      // Pruning is housekeeping; a failure leaves old rows for next start.
    }
    this.requestSignature = "";
    this.syncRequests();
    this.unsubscribe = this.registry.onEvent((event) => {
      this.handleEvent(event);
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  list(): ListOperatorRequestsResponse {
    return {
      serverRequests: this.listServerRequests(),
      questions: this.store.listOpenQuestions(),
      seenKeys: this.store.listSeenKeys(),
    };
  }

  markSeen(keys: readonly string[]): void {
    const valid = [...new Set(keys)].filter((key) =>
      typeof key === "string" && key.length > 0 && key.length <= MAX_OPERATOR_ITEM_KEY_LENGTH);
    if (this.store.markSeen(valid, this.now()) > 0) {
      this.broadcast({ reason: "seen" });
    }
  }

  dismissQuestion(params: {
    backend: AppServerBackendKind;
    threadId: string;
    messageId: string;
  }): void {
    const changed = this.store.resolveQuestions({
      backend: params.backend,
      threadId: params.threadId,
      messageIds: [params.messageId],
      status: "dismissed",
      now: this.now(),
    });
    if (changed) this.broadcast({ reason: "questions" });
  }

  private handleEvent(event: AgentEvent): void {
    // A peer's threads are answered on the peer.
    if (event.federationTarget?.scope === "remote") return;
    const { notification } = event;
    // Streamed deltas arrive hundreds a second and never add or answer a
    // request; every change to the pending set rides some other event.
    if (STREAMED_DELTA_METHOD.test(notification.method)) return;
    this.syncRequests();
    if (notification.method === "thread/archived") {
      const changed = this.store.dismissQuestionsForThread({
        backend: event.backend,
        threadId: notification.params.threadId,
        now: this.now(),
      });
      if (changed) this.broadcast({ reason: "questions" });
      return;
    }
    if (notification.method !== "item/completed") return;
    const threadId = readThreadId(notification.params);
    if (!threadId) return;
    const asked = readCodexAsyncQuestionsFromNotification(notification);
    if (asked) {
      const inserted = this.store.insertQuestion({
        backend: event.backend,
        threadId,
        messageId: asked.itemId,
        questions: asked.questions,
        now: this.now(),
      });
      if (inserted) this.broadcast({ reason: "questions" });
      return;
    }
    const replies = readCodexAsyncQuestionRepliesFromNotification(notification);
    if (replies) {
      const changed = this.store.resolveQuestions({
        backend: event.backend,
        threadId,
        messageIds: [...new Set(replies.map((reply) =>
          codexAsyncQuestionReplyMessageId(reply.questionItemId)))],
        status: "answered",
        now: this.now(),
      });
      if (changed) this.broadcast({ reason: "questions" });
    }
  }

  /**
   * Compares the registry's pending keys with the last set seen. Cheap: the
   * map holds a handful of entries at most, and nothing is sent unless the
   * set changed.
   */
  private syncRequests(): void {
    const pending = this.registry.listPendingServerRequests();
    const keys = pending.map(({ backend, notification }) =>
      operatorServerRequestItemKey(backend, notification.params.threadId, notification.params.requestId));
    const signature = keys.join("\n");
    if (signature === this.requestSignature) return;
    this.requestSignature = signature;
    const live = new Set(keys);
    const now = this.now();
    for (const key of keys) {
      if (!this.firstSeenAt.has(key)) this.firstSeenAt.set(key, now);
    }
    for (const key of [...this.firstSeenAt.keys()]) {
      if (!live.has(key)) this.firstSeenAt.delete(key);
    }
    this.broadcast({ reason: "requests" });
  }

  private listServerRequests(): OperatorServerRequest[] {
    return this.registry.listPendingServerRequests()
      .map(({ backend, notification }) => {
        const key = operatorServerRequestItemKey(
          backend,
          notification.params.threadId,
          notification.params.requestId,
        );
        // A request listed before its event reached the service gets its
        // time now, and keeps it.
        let createdAt = this.firstSeenAt.get(key);
        if (createdAt === undefined) {
          createdAt = this.now();
          this.firstSeenAt.set(key, createdAt);
        }
        return { backend, notification, createdAt };
      })
      .sort((left, right) => right.createdAt - left.createdAt);
  }
}

/** `item/agentMessage/delta`, `item/commandExecution/outputDelta`, and kin. */
const STREAMED_DELTA_METHOD = /delta$/i;

function readThreadId(params: unknown): string | undefined {
  const threadId = params && typeof params === "object"
    ? (params as { threadId?: unknown }).threadId
    : undefined;
  return typeof threadId === "string" && threadId ? threadId : undefined;
}
