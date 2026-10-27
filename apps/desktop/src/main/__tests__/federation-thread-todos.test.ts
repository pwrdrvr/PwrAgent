import { describe, expect, it, vi } from "vitest";
import type { FederationRemoteTarget, ThreadTodo, ThreadReview } from "@pwragent/shared";
import { FederatedThreadTodoService, FEDERATION_THREAD_TODO_CAPABILITIES, FEDERATION_THREAD_TODO_METHODS,
  registerFederationThreadTodoHandlers, type ThreadTodoRemoteRequest } from "../federation/federation-thread-todos";
import { FederationRouter } from "../federation/federation-router";

const target: FederationRemoteTarget = { scope: "remote", instanceId: "peer" };
const card: ThreadTodo = { id: "same-card", backend: "codex", threadId: "same-thread", kind: "reminder",
  title: "Owner card", status: "open", createdAt: 1, updatedAt: 1 };
const review: ThreadReview = { id: "same-review", backend: "codex", threadId: "same-thread", sourceKey: "artifact",
  title: "Review", items: [], status: "open", createdAt: 1, updatedAt: 1 };

function operations() {
  return {
    listTodos: vi.fn(async (_request?: unknown) => ({ todos: [card], mergeMethods: { defaultMethod: "rebase" as const, byProject: {} } })),
    listReviews: vi.fn((_request?: unknown) => ({ reviews: [review] })),
    updateReview: vi.fn((_request?: unknown) => ({ review })),
    resolveTodo: vi.fn((_request?: unknown) => ({ todo: card })),
    runAction: vi.fn(async (_request?: unknown) => ({ todo: card })),
    listProjects: vi.fn(async (_request?: unknown) => ({ projects: [] })),
    setItemChecked: vi.fn((_request?: unknown) => ({ todo: card })),
    setProject: vi.fn(async (_request?: unknown) => ({ todo: card })),
    snapshotFeed: vi.fn(async (_request?: unknown) => ({ epoch: "owner", revision: 0, todos: [card] })),
  };
}

function setup(mounts = true) {
  const local = operations();
  const remoteOperations = operations();
  const remote = vi.fn(async (_target, operation, request) => remoteOperations[operation as keyof typeof remoteOperations](request as never)) as unknown as ThreadTodoRemoteRequest;
  const service = new FederatedThreadTodoService({ local, remote,
    mountedThreads: async () => mounts ? [{ target, backend: card.backend, threadId: card.threadId }] : [] });
  return { local, remoteOperations, remote, service };
}

describe("federated To-do ownership", () => {
  it("merges only mounted thread cards and keeps colliding local ids and merge preferences distinct", async () => {
    const { service, remote, local } = setup();
    const listed = await service.request("listTodos", { status: "open" });
    expect(listed.todos).toHaveLength(2);
    expect(listed.todos[0]).toEqual(card);
    expect(listed.todos[1]).toMatchObject({ federationTarget: target, mergeMethod: "rebase" });
    expect(listed.todos[1]!.id).not.toBe(card.id);
    expect(remote).toHaveBeenCalledWith(target, "listTodos", { status: "open", backend: "codex", threadId: "same-thread" });
    await service.request("resolveTodo", { id: listed.todos[1]!.id, status: "dismissed" });
    expect(remote).toHaveBeenLastCalledWith(target, "resolveTodo", { id: card.id, status: "dismissed" });
    expect(local.resolveTodo).not.toHaveBeenCalled();
  });

  it("routes the remote window's lists, projects, reviews and every operator mutation to the owner", async () => {
    const { service, remote, local, remoteOperations } = setup();
    const listed = await service.request("listTodos", { status: "open" }, target);
    expect(local.listTodos).not.toHaveBeenCalled();
    const id = listed.todos[0]!.id;
    await service.request("setItemChecked", { id, itemId: "step", checked: true });
    await service.request("setProject", { id, projectKey: "directory:/owner" });
    await service.request("runAction", { id, mergeMethod: "squash", rememberMergeMethod: true, allowOpenItems: true });
    await service.request("resolveTodo", { id, status: "open" });
    expect(remoteOperations.setItemChecked).toHaveBeenCalledWith({ id: card.id, itemId: "step", checked: true });
    expect(remoteOperations.setProject).toHaveBeenCalledWith({ id: card.id, projectKey: "directory:/owner" });
    expect(remoteOperations.runAction).toHaveBeenCalledWith({ id: card.id, mergeMethod: "squash", rememberMergeMethod: true, allowOpenItems: true });
    const reviews = await service.request("listReviews", { backend: "codex", threadId: "same-thread" }, target);
    expect(reviews.reviews[0]).toMatchObject({ federationTarget: target });
    await service.request("updateReview", { id: review.id, itemId: "finding", status: "addressed", federationTarget: target });
    expect(remoteOperations.updateReview).toHaveBeenCalledWith({ id: review.id, itemId: "finding", status: "addressed" });
    await service.request("listProjects", {}, target);
    expect(remote).toHaveBeenLastCalledWith(target, "listProjects", {});
    expect(local.runAction).not.toHaveBeenCalled();
    expect(local.updateReview).not.toHaveBeenCalled();
  });

  it("forwards dispatch picks to the card's owner without changing the viewer's local state", async () => {
    const { service, local, remoteOperations } = setup();
    const modelSettings = { backend: "claude" as const, model: "opus", reasoningEffort: "high" };
    await service.request("runAction", { id: "remote-todo:peer:same-card", modelSettings });
    expect(remoteOperations.runAction).toHaveBeenCalledWith({ id: "same-card", modelSettings });
    expect(local.runAction).not.toHaveBeenCalled();
  });

  it.each(["addressed", "dismissed", "open", "handled"] as const)("routes review status %s and its evidence to the original owner", async (status) => {
    const { service, local, remoteOperations } = setup();
    const request = { id: review.id, ...(status !== "handled" ? { itemId: "finding" } : {}), status,
      note: "Verified the owner-side fix", url: "https://example.com/commit/123" };
    await service.request("updateReview", { ...request, federationTarget: target });
    expect(remoteOperations.updateReview).toHaveBeenCalledExactlyOnceWith(request);
    expect(local.updateReview).not.toHaveBeenCalled();
  });

  it("sends a finding decline under the name every owner accepts, and renames an older owner's findings", async () => {
    const { service, remoteOperations } = setup();
    await service.request("updateReview", { id: review.id, itemId: "finding", status: "declined", note: "Intended.",
      federationTarget: target });
    expect(remoteOperations.updateReview).toHaveBeenLastCalledWith({ id: review.id, itemId: "finding", status: "dismissed", note: "Intended." });
    // A whole review's own dismissal is not a finding's.
    await service.request("updateReview", { id: review.id, status: "dismissed", note: "Superseded.", federationTarget: target });
    expect(remoteOperations.updateReview).toHaveBeenLastCalledWith({ id: review.id, status: "dismissed", note: "Superseded." });

    const older = { ...review, items: [
      { id: "a", title: "Declined", status: "dismissed", createdAt: 1, updatedAt: 1 },
      { id: "b", title: "Open", status: "open", createdAt: 1, updatedAt: 1 },
    ] } as unknown as ThreadReview;
    remoteOperations.listReviews.mockReturnValueOnce({ reviews: [older] });
    remoteOperations.updateReview.mockReturnValueOnce({ review: older });
    const listed = await service.request("listReviews", { backend: "codex", threadId: "same-thread" }, target);
    expect(listed.reviews[0]!.items.map((item) => item.status)).toEqual(["declined", "open"]);
    const updated = await service.request("updateReview", { id: review.id, itemId: "b", status: "open", federationTarget: target });
    expect(updated.review.items.map((item) => item.status)).toEqual(["declined", "open"]);
    expect(updated.review.federationTarget).toEqual(target);
  });

  it("never falls back to a colliding local record when the owner is unavailable", async () => {
    const local = operations();
    const unavailable = vi.fn(async () => { throw new Error("Peer offline"); });
    const service = new FederatedThreadTodoService({ local, remote: unavailable, mountedThreads: async () => [] });
    await expect(service.request("resolveTodo", { id: "remote-todo:peer:same-card", status: "done" })).rejects.toThrow("Peer offline");
    expect(local.resolveTodo).not.toHaveBeenCalled();
    await expect(service.request("resolveTodo", { id: "remote-todo:peer:same-card", status: "done",
      federationTarget: { scope: "remote", instanceId: "other" } })).rejects.toThrow("owner does not match");
  });

  it("keeps local cards available when a mounted owner is offline", async () => {
    const local = operations();
    const onUnavailable = vi.fn();
    const service = new FederatedThreadTodoService({ local, onUnavailable,
      remote: async () => { throw new Error("Peer offline"); },
      mountedThreads: async () => [{ target, backend: card.backend, threadId: card.threadId }] });
    const response = await service.request("listTodos", {});
    expect(response.todos).toEqual([card]);
    expect(response.errors).toEqual(["peer: Peer offline"]);
    expect(onUnavailable).toHaveBeenCalledOnce();
  });

  it("reports an unavailable instance once across multiple mounted threads without hiding available cards", async () => {
    const unavailable = { instanceId: "older", label: "Build Mini", reason: "unsupported" as const };
    const service = new FederatedThreadTodoService({ local: operations(),
      remote: vi.fn(async (target) => target.instanceId === "older"
        ? { todos: [], unavailableInstances: [unavailable] } : { todos: [card] }) as ThreadTodoRemoteRequest,
      mountedThreads: async () => [
        { target: { scope: "remote", instanceId: "older" }, backend: "codex", threadId: "one" },
        { target: { scope: "remote", instanceId: "older" }, backend: "codex", threadId: "two" },
        { target, backend: "codex", threadId: "available" },
      ],
    });
    const response = await service.request("listTodos", {});
    expect(response.todos).toHaveLength(2);
    expect(response.unavailableInstances).toEqual([unavailable]);
    expect(response.errors).toBeUndefined();
  });
});

describe("To-do federation protocol", () => {
  it("serves owner-local reads and refuses mutations from read-only peers", async () => {
    const local = operations();
    const router = new FederationRouter({ localInstanceId: "owner", methodCapabilities: FEDERATION_THREAD_TODO_CAPABILITIES });
    registerFederationThreadTodoHandlers(router, local);
    router.registerConnection({ peerId: "viewer", capabilities: ["thread_detail"], sendEnvelope: () => {} });
    const send = (method: string, params: unknown) => router.routeEnvelope({ sourcePeerId: "viewer", envelope: {
      id: "request", protocolVersion: 1, createdAt: Date.now(), kind: "request", sourceInstanceId: "viewer", targetInstanceId: "owner", method, params,
    } });
    expect((await send(FEDERATION_THREAD_TODO_METHODS.listTodos, { status: "open" })).status).toBe("handled");
    for (const operation of ["updateReview", "resolveTodo", "runAction", "setItemChecked", "setProject"] as const) {
      expect((await send(FEDERATION_THREAD_TODO_METHODS[operation], { id: card.id, status: "dismissed" })).status).toBe("rejected");
      expect(local[operation]).not.toHaveBeenCalled();
    }
    expect((await send(FEDERATION_THREAD_TODO_METHODS.listTodos, { federationTarget: target })).status).toBe("rejected");
  });
});
