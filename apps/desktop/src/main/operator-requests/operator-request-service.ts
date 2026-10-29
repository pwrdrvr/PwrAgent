import type {
  AgentEvent,
  AppServerBackendKind,
  AppServerPendingRequestNotification,
  ListOperatorRequestsResponse,
  ListOperatorRequestsRequest,
  OperatorRequestsChangedEvent,
  OperatorServerRequest,
  OperatorQuestionThreadRequest,
} from "@pwragent/shared";
import {
  MAX_OPERATOR_ITEM_KEY_LENGTH,
  codexAsyncQuestionReplyMessageId,
  operatorServerRequestItemKey,
  operatorQuestionItemKey,
  readCodexAsyncQuestionRepliesFromNotification,
  readCodexAsyncQuestionsFromNotification,
} from "@pwragent/shared";
import type { OperatorRequestStore } from "./operator-request-store.js";

/** The registry surface the service reads. */
export type OperatorRequestRegistry = {
  getThreadInfo(identity: { backend: AppServerBackendKind; threadId: string }): { title?: string } | undefined;
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

  list(filter: ListOperatorRequestsRequest = {}): ListOperatorRequestsResponse {
    const matches = (backend: AppServerBackendKind, threadId: string) =>
      (!filter.backend || backend === filter.backend) && (!filter.threadId || threadId === filter.threadId);
    const serverRequests = this.listServerRequests().filter((entry) => matches(entry.backend, entry.notification.params.threadId));
    const questions = this.store.listOpenQuestions().filter((entry) => matches(entry.backend, entry.threadId))
      .map((entry) => ({ ...entry, threadTitle: this.registry.getThreadInfo(entry)?.title }));
    let seenKeys = this.store.listSeenKeys();
    if (filter.backend || filter.threadId) {
      const visibleKeys = new Set([
        ...this.store.listTodoItemKeys(filter),
        ...questions.map((entry) => operatorQuestionItemKey(entry.backend, entry.threadId, entry.messageId)),
        ...serverRequests.map((entry) => operatorServerRequestItemKey(entry.backend, entry.notification.params.threadId, entry.notification.params.requestId)),
      ]);
      seenKeys = seenKeys.filter((key) => visibleKeys.has(key));
    }
    return { serverRequests, questions, seenKeys };
  }

  markSeen(keys: readonly string[]): void {
    const valid = [...new Set(keys)].filter((key) =>
      typeof key === "string" && key.length > 0 && key.length <= MAX_OPERATOR_ITEM_KEY_LENGTH);
    if (this.store.markSeen(valid, this.now()) > 0) {
      this.broadcast({ reason: "seen" });
    }
  }

  listDismissedQuestions(params: OperatorQuestionThreadRequest): string[] {
    return this.store.listDismissedQuestionMessageIds(params);
  }

  dismissQuestion(params: {
    backend: AppServerBackendKind;
    threadId: string;
    messageId: string;
  }): void {
    const changed = this.store.dismissQuestion({
      ...params,
      now: this.now(),
    });
    if (changed) this.broadcast({ reason: "questions", backend: params.backend, threadId: params.threadId });
  }

  private handleEvent(event: AgentEvent): void {
    // A peer's threads are answered on the peer.
    if (event.federationTarget?.scope === "remote") return;
    const { notification } = event;
    // Streamed deltas arrive hundreds a second and never add or answer a
    // request; every change to the pending set rides some other event.
    if (STREAMED_DELTA_METHOD.test(notification.method)) return;
    this.syncRequests();
    if (notification.method === "thread/name/updated") {
      const { threadId, threadName } = notification.params;
      if (typeof threadId === "string" && typeof threadName === "string" && threadName.trim()
        && (this.registry.listPendingServerRequests().some((entry) =>
          entry.backend === event.backend && entry.notification.params.threadId === threadId)
          || this.store.listOpenQuestions().some((entry) =>
            entry.backend === event.backend && entry.threadId === threadId))) {
        this.broadcast({ reason: "requests", backend: event.backend, threadId });
      }
      return;
    }
    if (notification.method === "thread/archived") {
      const changed = this.store.dismissQuestionsForThread({
        backend: event.backend,
        threadId: notification.params.threadId,
        now: this.now(),
      });
      if (changed) this.broadcast({ reason: "questions", backend: event.backend, threadId: notification.params.threadId });
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
      if (inserted) this.broadcast({ reason: "questions", backend: event.backend, threadId });
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
      if (changed) this.broadcast({ reason: "questions", backend: event.backend, threadId });
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
        return {
          backend, notification, createdAt,
          threadTitle: this.registry.getThreadInfo({ backend, threadId: notification.params.threadId })?.title,
        };
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
