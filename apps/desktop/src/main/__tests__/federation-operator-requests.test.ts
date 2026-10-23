import { describe, expect, it, vi } from "vitest";
import type { ListOperatorRequestsResponse } from "@pwragent/shared";
import { operatorQuestionItemKey, operatorTodoItemKey, projectOperatorItemKey } from "@pwragent/shared";
import { FederatedOperatorRequestService } from "../federation/federation-operator-requests";
import type { OperatorQuestionOperation } from "../federation/federation-operator-questions";

const target = { scope: "remote" as const, instanceId: "owner" };
const local: ListOperatorRequestsResponse = {
  questions: [{ backend: "codex", threadId: "thread", messageId: "question", questions: [{ title: "Deploy?", options: null }], createdAt: 1 }],
  serverRequests: [{ backend: "codex", notification: { method: "item/commandExecution/requestApproval",
    params: { threadId: "thread", requestId: "approval" } }, createdAt: 1 }],
  seenKeys: ["question:codex:thread:question", "todo:review:1"],
};
function fixture() {
  const localList = vi.fn(() => structuredClone(local));
  const localMarkSeen = vi.fn();
  const remote = vi.fn(async (_target: typeof target, operation: OperatorQuestionOperation) =>
    operation === "list" ? { ...structuredClone(local), serverRequests: [] }
      : operation === "listPending" ? structuredClone(local.serverRequests) : undefined);
  const mount = { target, backend: "codex" as const, threadId: "thread" };
  const onUnavailable = vi.fn();
  const service = new FederatedOperatorRequestService({ localList, localMarkSeen,
    remote: remote as ConstructorParameters<typeof FederatedOperatorRequestService>[0]["remote"],
    mountedThreads: async () => [mount, mount], onUnavailable });
  return { service, localList, localMarkSeen, remote, onUnavailable };
}

describe("federated operator queue", () => {
  it("aggregates exact mounted threads once and keeps colliding item identities and seen state separate", async () => {
    const { service, remote } = fixture();
    const response = await service.list();
    expect(remote).toHaveBeenCalledTimes(2);
    expect(remote).toHaveBeenCalledWith(target, "list", { backend: "codex", threadId: "thread" });
    expect(remote).toHaveBeenCalledWith(target, "listPending", { backend: "codex", threadId: "thread" });
    expect(response.questions).toEqual([local.questions[0], { ...local.questions[0], federationTarget: target }]);
    expect(response.serverRequests).toEqual([local.serverRequests[0], { ...local.serverRequests[0], federationTarget: target }]);
    expect(response.seenKeys).toContain(operatorQuestionItemKey("codex", "thread", "question", target));
    expect(response.seenKeys).toContain(operatorTodoItemKey("remote-todo:owner:review%3A1"));
    expect(response.seenKeys).toContain("todo:review:1");
  });

  it("lists only the owner in a remote window", async () => {
    const { service, localList } = fixture();
    expect((await service.list({}, target)).questions).toEqual([{ ...local.questions[0], federationTarget: target }]);
    expect(localList).not.toHaveBeenCalled();
  });

  it("preserves expected coverage gaps for remote windows and deduplicates mounted owners", async () => {
    const unavailable = { instanceId: "owner", label: "Studio Mac", reason: "disconnected" as const };
    const service = new FederatedOperatorRequestService({ localList: () => structuredClone(local), localMarkSeen: vi.fn(),
      remote: vi.fn(async (_target, operation) => operation === "list"
        ? { questions: [], serverRequests: [], seenKeys: [], unavailableInstances: [unavailable] } : []) as
        ConstructorParameters<typeof FederatedOperatorRequestService>[0]["remote"],
      mountedThreads: async () => ["one", "two"].map((threadId) => ({ target, backend: "codex", threadId })),
    });
    const windowResponse = await service.list({}, target);
    expect(windowResponse.unavailableInstances).toEqual([unavailable]);
    expect(windowResponse.questions).toEqual([]);
    const mountedResponse = await service.list();
    expect(mountedResponse.questions).toEqual(local.questions);
    expect(mountedResponse.unavailableInstances).toEqual([unavailable]);
    expect(mountedResponse.errors).toBeUndefined();
  });

  it("batches seen marks once per owner without persisting remote marks locally", async () => {
    const { service, remote, localMarkSeen } = fixture();
    await service.markSeen({ keys: ["todo:local", projectOperatorItemKey("todo:review:1", target),
      operatorQuestionItemKey("codex", "thread", "question", target)] });
    expect(localMarkSeen).toHaveBeenCalledExactlyOnceWith(["todo:local"]);
    expect(remote).toHaveBeenCalledExactlyOnceWith(target, "markSeen", { keys: ["todo:review:1", "question:codex:thread:question"] });
  });

  it("routes unprojected remote-window marks to that owner and rejects mismatched owners", async () => {
    const { service, remote, localMarkSeen } = fixture();
    await service.markSeen({ keys: ["todo:1"] }, target);
    expect(remote).toHaveBeenCalledWith(target, "markSeen", { keys: ["todo:1"] });
    await expect(service.markSeen({ keys: [projectOperatorItemKey("todo:1", target)] }, { scope: "remote", instanceId: "other" }))
      .rejects.toThrow("owner does not match");
    expect(localMarkSeen).not.toHaveBeenCalled();
  });

  it("never falls back to local state when the owner is unavailable", async () => {
    const { service, remote, localList, localMarkSeen } = fixture();
    remote.mockRejectedValue(new Error("Disconnected"));
    await expect(service.list({}, target)).rejects.toThrow("Disconnected");
    await expect(service.markSeen({ keys: [projectOperatorItemKey("todo:1", target)] })).rejects.toThrow("Disconnected");
    expect(localList).not.toHaveBeenCalled();
    expect(localMarkSeen).not.toHaveBeenCalled();
  });
});
