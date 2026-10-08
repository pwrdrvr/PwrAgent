import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AgentEvent,
  AppServerBackendKind,
  AppServerPendingRequestNotification,
  OperatorRequestsChangedEvent,
} from "@pwragent/shared";
import {
  codexAsyncQuestionItemId,
  formatCodexAsyncQuestionReply,
  operatorQuestionItemKey,
  operatorServerRequestItemKey,
} from "@pwragent/shared";
import {
  OperatorRequestService,
  type OperatorRequestRegistry,
} from "../operator-requests/operator-request-service";
import {
  OPERATOR_REQUEST_RETENTION_MS,
  OperatorRequestStore,
} from "../operator-requests/operator-request-store";
import { StateDb } from "../state/state-db";
import {
  SQLITE_WRITE_METRICS_ENV,
  measureSqliteWrites,
  resetSqliteWriteMetrics,
} from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { openInMemoryStateDb } from "./sqlite-test-utils";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

type FakeRegistry = OperatorRequestRegistry & {
  pending: Array<{ backend: AppServerBackendKind; notification: AppServerPendingRequestNotification }>;
  emit: (event: AgentEvent) => void;
  listenerCount: () => number;
};

function createRegistry(): FakeRegistry {
  const listeners = new Set<(event: AgentEvent) => void | Promise<void>>();
  const registry: FakeRegistry = {
    pending: [],
    listPendingServerRequests: () => registry.pending,
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit: (event) => {
      for (const listener of listeners) void listener(event);
    },
    listenerCount: () => listeners.size,
  };
  return registry;
}

function approval(threadId: string, requestId: string): AppServerPendingRequestNotification {
  return {
    method: "item/commandExecution/requestApproval",
    params: { threadId, turnId: "turn-1", requestId, command: "pnpm test" },
  } as unknown as AppServerPendingRequestNotification;
}

function event(notification: { method: string; params: unknown }, remote = false): AgentEvent {
  return {
    backend: "codex",
    notification,
    ...(remote ? { federationTarget: { scope: "remote", instanceId: "peer-1" } } : {}),
  } as unknown as AgentEvent;
}

function askedEvent(threadId: string, messageId: string): AgentEvent {
  return event({
    method: "item/completed",
    params: {
      threadId,
      turnId: "turn-1",
      item: {
        type: "agentMessage",
        id: messageId,
        text: "Which environment?",
        delivery: "async",
        questions: [{ title: "Which environment?", options: ["Staging", "Production"] }],
      },
    },
  });
}

function replyEvent(threadId: string, messageId: string): AgentEvent {
  return event({
    method: "item/completed",
    params: {
      threadId,
      turnId: "turn-2",
      item: {
        type: "userMessage",
        id: "user-1",
        content: [{
          type: "text",
          text: formatCodexAsyncQuestionReply([{
            questionItemId: codexAsyncQuestionItemId(messageId, 0),
            question: "Which environment?",
            answer: "Staging",
          }]),
        }],
      },
    },
  });
}

/** A database passed in is the caller's to close. */
function createService(existing?: StateDb) {
  const db = existing ?? openInMemoryStateDb();
  if (!existing) cleanups.push(() => db.close());
  const registry = createRegistry();
  const store = new OperatorRequestStore(db);
  const broadcasts: OperatorRequestsChangedEvent[] = [];
  let now = 1_000;
  const service = new OperatorRequestService({
    registry,
    store,
    broadcast: (change) => broadcasts.push(change),
    now: () => now,
  });
  cleanups.push(() => service.stop());
  return {
    broadcasts,
    db,
    registry,
    service,
    store,
    setNow: (value: number) => {
      now = value;
    },
  };
}

describe("OperatorRequestService", () => {
  it("lists pending server requests with the time each was first seen", () => {
    const { broadcasts, registry, service, setNow } = createService();
    service.start();
    // Nothing pending at start is nothing to announce.
    expect(broadcasts).toEqual([]);

    registry.pending.push({ backend: "codex", notification: approval("thread-a", "req-1") });
    registry.emit(event({ method: "serverRequest/created", params: { threadId: "thread-a" } }));
    setNow(5_000);
    registry.pending.push({ backend: "codex", notification: approval("thread-b", "req-2") });
    registry.emit(event({ method: "serverRequest/created", params: { threadId: "thread-b" } }));

    expect(broadcasts).toEqual([{ reason: "requests" }, { reason: "requests" }]);
    const listed = service.list().serverRequests;
    expect(listed.map((entry) => [entry.notification.params.requestId, entry.createdAt]))
      .toEqual([["req-2", 5_000], ["req-1", 1_000]]);
  });

  it("broadcasts once per change to the pending set, not per event", () => {
    const { broadcasts, registry, service } = createService();
    registry.pending.push({ backend: "codex", notification: approval("thread-a", "req-1") });
    service.start();
    broadcasts.length = 0;

    for (let index = 0; index < 50; index += 1) {
      registry.emit(event({ method: "item/agentMessage/delta", params: { threadId: "thread-a" } }));
    }
    expect(broadcasts).toEqual([]);

    registry.pending = [];
    registry.emit(event({ method: "serverRequest/resolved", params: { threadId: "thread-a" } }));
    expect(broadcasts).toEqual([{ reason: "requests" }]);
    expect(service.list().serverRequests).toEqual([]);
  });

  it("records an async question and closes it when a reply names it", () => {
    const { broadcasts, registry, service } = createService();
    service.start();
    broadcasts.length = 0;

    registry.emit(askedEvent("thread-a", "msg-1"));
    expect(broadcasts).toEqual([{ reason: "questions" }]);
    expect(service.list().questions).toEqual([{
      backend: "codex",
      threadId: "thread-a",
      messageId: "msg-1",
      questions: [{ title: "Which environment?", options: ["Staging", "Production"] }],
      createdAt: 1_000,
    }]);

    // The same item replayed keeps its row and says nothing.
    registry.emit(askedEvent("thread-a", "msg-1"));
    expect(broadcasts).toHaveLength(1);

    registry.emit(replyEvent("thread-a", "msg-1"));
    expect(broadcasts).toHaveLength(2);
    expect(service.list().questions).toEqual([]);
  });

  it("keeps no question text once the question closes", () => {
    const { db, registry, service } = createService();
    service.start();
    registry.emit(askedEvent("thread-a", "msg-1"));
    service.dismissQuestion({ backend: "codex", threadId: "thread-a", messageId: "msg-1" });

    const row = db.raw
      .prepare("SELECT status, questions_json FROM operator_async_questions")
      .get() as { status: string; questions_json: string };
    expect(row).toEqual({ status: "dismissed", questions_json: "[]" });
  });

  it("closes a thread's questions when the thread is archived", () => {
    const { registry, service } = createService();
    service.start();
    registry.emit(askedEvent("thread-a", "msg-1"));
    registry.emit(askedEvent("thread-b", "msg-2"));

    registry.emit(event({ method: "thread/archived", params: { threadId: "thread-a" } }));
    expect(service.list().questions.map((question) => question.messageId)).toEqual(["msg-2"]);
  });

  it("ignores a peer's events", () => {
    const { broadcasts, registry, service } = createService();
    service.start();
    broadcasts.length = 0;
    registry.emit({ ...askedEvent("thread-a", "msg-1"), federationTarget: { scope: "remote", instanceId: "peer-1" } } as AgentEvent);
    expect(broadcasts).toEqual([]);
    expect(service.list().questions).toEqual([]);
  });

  it("broadcasts a seen mark only when it adds something", () => {
    const { broadcasts, service } = createService();
    service.start();
    broadcasts.length = 0;
    const keys = [
      operatorServerRequestItemKey("codex", "thread-a", "req-1"),
      operatorQuestionItemKey("codex", "thread-a", "msg-1"),
    ];

    service.markSeen(keys);
    service.markSeen(keys);
    service.markSeen(["", "x".repeat(2_000)]);
    expect(broadcasts).toEqual([{ reason: "seen" }]);
    expect(service.list().seenKeys.sort()).toEqual([...keys].sort());
  });

  it("prunes old closed questions and seen marks at start", () => {
    const { registry, service, setNow, store } = createService();
    service.start();
    registry.emit(askedEvent("thread-a", "msg-1"));
    registry.emit(askedEvent("thread-a", "msg-2"));
    service.dismissQuestion({ backend: "codex", threadId: "thread-a", messageId: "msg-1" });
    service.markSeen(["todo:old", operatorQuestionItemKey("codex", "thread-a", "msg-2")]);
    service.stop();

    setNow(1_000 + OPERATOR_REQUEST_RETENTION_MS + 1);
    service.start();
    // A mark for an item still open is kept however old, or it would read
    // as new again.
    expect(store.listSeenKeys()).toEqual([operatorQuestionItemKey("codex", "thread-a", "msg-2")]);
    // An open question is never pruned, however old.
    expect(service.list().questions.map((question) => question.messageId)).toEqual(["msg-2"]);
  });

  it("unsubscribes on stop", () => {
    const { registry, service } = createService();
    service.start();
    expect(registry.listenerCount()).toBe(1);
    service.stop();
    expect(registry.listenerCount()).toBe(0);
  });
});

describe("OperatorRequestService write cost", () => {
  it("commits once per question, per close, and per seen batch; never per event", async () => {
    process.env[SQLITE_WRITE_METRICS_ENV] = "1";
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-operator-budget-"));
    // A write budget records WAL growth, which only a real file has.
    const db = StateDb.open(path.join(root, "state.db"));
    const { registry, service } = createService(db);
    try {
      resetSqliteWriteMetrics();
      service.start();
      const { writes } = await measureSqliteWrites(async () => {
        registry.pending.push({ backend: "codex", notification: approval("thread-a", "req-1") });
        registry.emit(event({ method: "serverRequest/created", params: { threadId: "thread-a" } }));
        registry.emit(askedEvent("thread-a", "msg-1"));
        for (let index = 0; index < 200; index += 1) {
          registry.emit(event({ method: "item/agentMessage/delta", params: { threadId: "thread-a" } }));
        }
        service.markSeen([
          operatorServerRequestItemKey("codex", "thread-a", "req-1"),
          operatorQuestionItemKey("codex", "thread-a", "msg-1"),
          "todo:card-1",
        ]);
        registry.emit(replyEvent("thread-a", "msg-1"));
        registry.pending = [];
        registry.emit(event({ method: "serverRequest/resolved", params: { threadId: "thread-a" } }));
      });
      expectSqliteWriteBudget({
        note:
          "one approval and one async question across 200 streamed events: "
          + "the question's insert, one seen batch, and the reply's close; "
          + "server requests and streamed events write nothing. ~0.03 MB WAL "
          + "per question; ~1.5 MB/day at 50 questions",
        scenario: "operator-requests",
        writes,
      });
    } finally {
      service.stop();
      // Windows cannot remove a directory holding an open database.
      db.close();
      delete process.env[SQLITE_WRITE_METRICS_ENV];
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
