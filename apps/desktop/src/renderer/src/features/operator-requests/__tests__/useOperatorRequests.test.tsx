import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ListOperatorRequestsResponse, OperatorRequestsChangedEvent } from "@pwragent/shared";
import { operatorQuestionItemKey, threadTodoThreadKey } from "@pwragent/shared";
import { useOperatorRequests } from "../useOperatorRequests";

const target = { scope: "remote" as const, instanceId: "owner" };
const question = { backend: "codex" as const, threadId: "same", messageId: "same", questions: [{ title: "Where?", options: null }], createdAt: 1 };
function fixture() {
  let changed!: (event: OperatorRequestsChangedEvent) => void;
  const api = {
    listOperatorRequests: vi.fn(async (): Promise<ListOperatorRequestsResponse> => ({
      serverRequests: [], seenKeys: [], questions: [question, { ...question, federationTarget: target }],
    })),
    markOperatorItemsSeen: vi.fn(async () => {}), dismissOperatorQuestion: vi.fn(async () => {}),
    onOperatorRequestsChanged: (listener: typeof changed) => { changed = listener; return () => {}; },
  };
  return { api, changed: (event: OperatorRequestsChangedEvent) => changed(event) };
}
afterEach(() => { cleanup(); delete (window as unknown as { __pwragentFederationTarget?: unknown }).__pwragentFederationTarget; });

describe("operator queue owner identity", () => {
  it("loads in a remote window, reloads invalidations and records owner-qualified seen keys", async () => {
    Object.assign(window, { __pwragentFederationTarget: target });
    const { api, changed } = fixture();
    const { result, rerender } = renderHook(({ mounts }) => useOperatorRequests(api, mounts), { initialProps: { mounts: "" } });
    await waitFor(() => expect(result.current.waits).toHaveLength(2));
    const remote = result.current.waits.find((wait) => wait.federationTarget)!;
    expect(remote.threadKey).toBe(threadTodoThreadKey({ ...question, federationTarget: target }));
    expect(result.current.waitsByThreadKey.size).toBe(2);
    await act(async () => { result.current.markSeen([remote.key]); result.current.markSeen([remote.key]); });
    expect(api.markOperatorItemsSeen).toHaveBeenCalledExactlyOnceWith({ keys: [operatorQuestionItemKey("codex", "same", "same", target)] });
    act(() => changed({ reason: "seen", federationTarget: target }));
    await waitFor(() => expect(api.listOperatorRequests).toHaveBeenCalledTimes(2));
    rerender({ mounts: "new-mount" });
    await waitFor(() => expect(api.listOperatorRequests).toHaveBeenCalledTimes(3));
  });

  it("only folds a remote question once its owner accepts dismissal", async () => {
    const { api } = fixture();
    const { result } = renderHook(() => useOperatorRequests(api));
    await waitFor(() => expect(result.current.ready).toBe(true));
    api.dismissOperatorQuestion.mockRejectedValueOnce(new Error("Owner disconnected"));
    const request = { ...question, federationTarget: target };
    await act(async () => { await expect(result.current.dismissQuestion(request)).rejects.toThrow("Owner disconnected"); });
    expect(result.current.dismissedQuestionKeys.size).toBe(0);
    await act(async () => { await result.current.dismissQuestion(request); });
    expect(api.dismissOperatorQuestion).toHaveBeenLastCalledWith({ backend: "codex", threadId: "same", messageId: "same", federationTarget: target });
    expect([...result.current.dismissedQuestionKeys]).toEqual([operatorQuestionItemKey("codex", "same", "same", target)]);
  });

  it("exposes unavailable-owner errors instead of silently showing an empty queue", async () => {
    const { api } = fixture();
    api.listOperatorRequests.mockRejectedValueOnce(new Error("Update that PwrAgent instance."));
    const { result } = renderHook(() => useOperatorRequests(api));
    await waitFor(() => expect(result.current.error).toBe("Update that PwrAgent instance."));
    expect(result.current.ready).toBe(false);
  });
});
