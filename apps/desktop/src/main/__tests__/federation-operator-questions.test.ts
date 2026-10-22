import { afterEach, describe, expect, it, vi } from "vitest";
import { FEDERATION_OPERATOR_QUESTION_CAPABILITIES, FEDERATION_OPERATOR_QUESTION_METHODS,
  registerFederationOperatorQuestionHandlers } from "../federation/federation-operator-questions";
import { FederationRouter } from "../federation/federation-router";
import { installOperatorRequestService } from "../operator-requests/operator-request-runtime";
import { OperatorRequestService } from "../operator-requests/operator-request-service";
import { OperatorRequestStore } from "../operator-requests/operator-request-store";
import { openInMemoryStateDb } from "./sqlite-test-utils";

const submitThreadReply = vi.hoisted(() => vi.fn(async () => ({ status: "queued", entry: { backend: "codex", threadId: "thread", id: "queue-1" } })));
vi.mock("../app-server/backend-registry", () => ({ getDesktopBackendRegistry: () => ({ submitThreadReply }) }));

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

describe("owner question protocol", () => {
  it("persists dismissals only on the owner, rejects read-only mutations and refuses forwarding targets", async () => {
    const db = openInMemoryStateDb();
    cleanups.push(() => db.close());
    const store = new OperatorRequestStore(db);
    store.insertQuestion({ backend: "codex", threadId: "thread", messageId: "question",
      questions: [{ title: "Which environment?", options: null }], now: 1,
    });
    const changes: unknown[] = [];
    installOperatorRequestService(new OperatorRequestService({ store,
      registry: { listPendingServerRequests: () => [{ backend: "codex", notification: {
        method: "item/commandExecution/requestApproval", params: { threadId: "thread", requestId: "approval" },
      } }], onEvent: () => () => {} },
      broadcast: (event) => changes.push(event),
    }));
    const router = new FederationRouter({ localInstanceId: "owner", methodCapabilities: FEDERATION_OPERATOR_QUESTION_CAPABILITIES });
    registerFederationOperatorQuestionHandlers(router);
    router.registerConnection({ peerId: "viewer", capabilities: ["thread_detail"], sendEnvelope: () => {} });
    const question = { backend: "codex", threadId: "thread", messageId: "question" };
    const send = (method: string, params: unknown) => router.routeEnvelope({ sourcePeerId: "viewer", envelope: {
      id: "request", protocolVersion: 1, createdAt: Date.now(), kind: "request", sourceInstanceId: "viewer", targetInstanceId: "owner", method, params,
    } });
    expect((await send(FEDERATION_OPERATOR_QUESTION_METHODS.dismiss, question)).status).toBe("rejected");
    expect(store.listOpenQuestions()).toHaveLength(1);
    const read = await send(FEDERATION_OPERATOR_QUESTION_METHODS.list, { backend: "codex", threadId: "thread" });
    expect(read.status === "handled" && read.response?.result).toMatchObject({ questions: [{ messageId: "question" }], serverRequests: [] });
    expect((await send(FEDERATION_OPERATOR_QUESTION_METHODS.listPending, {})).status).toBe("rejected");
    expect((await send(FEDERATION_OPERATOR_QUESTION_METHODS.reply, { backend: "codex", threadId: "thread", input: [] })).status).toBe("rejected");
    expect(submitThreadReply).not.toHaveBeenCalled();
    router.registerConnection({ peerId: "viewer", capabilities: ["thread_detail", "turn_control", "pending_request_control"], sendEnvelope: () => {} });
    const pending = await send(FEDERATION_OPERATOR_QUESTION_METHODS.listPending, { backend: "codex", threadId: "thread" });
    expect(pending.status === "handled" && pending.response?.result).toMatchObject([{ notification: { params: { requestId: "approval" } } }]);
    const reply = { backend: "codex", threadId: "thread", input: [{ type: "text", text: "staging" }] };
    expect((await send(FEDERATION_OPERATOR_QUESTION_METHODS.reply, { ...reply, federationTarget: { scope: "remote", instanceId: "other" } })).status).toBe("rejected");
    const accepted = await send(FEDERATION_OPERATOR_QUESTION_METHODS.reply, reply);
    expect(accepted.status === "handled" && accepted.response?.result).toMatchObject({ queueStatus: "queued", queueEntryId: "queue-1" });
    expect(submitThreadReply).toHaveBeenCalledExactlyOnceWith(reply);
    expect((await send(FEDERATION_OPERATOR_QUESTION_METHODS.dismiss, { ...question,
      federationTarget: { scope: "remote", instanceId: "other" },
    })).status).toBe("rejected");
    expect(store.listOpenQuestions()).toHaveLength(1);
    expect((await send(FEDERATION_OPERATOR_QUESTION_METHODS.dismiss, question)).status).toBe("handled");
    expect(store.listOpenQuestions()).toEqual([]);
    const listed = await send(FEDERATION_OPERATOR_QUESTION_METHODS.listDismissed, { backend: "codex", threadId: "thread" });
    expect(listed.status === "handled" && listed.response?.result).toEqual(["question"]);
    await send(FEDERATION_OPERATOR_QUESTION_METHODS.dismiss, question);
    expect(changes).toEqual([{ reason: "questions", backend: "codex", threadId: "thread" }]);
  });
});
