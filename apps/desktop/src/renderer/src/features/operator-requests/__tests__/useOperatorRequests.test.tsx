import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ListOperatorRequestsResponse, OperatorRequestsChangedEvent } from "@pwragent/shared";
import { operatorQuestionItemKey, threadTodoThreadKey } from "@pwragent/shared";
import { ThreadTodosPanel } from "../../thread-todos/ThreadTodosPanel";
import type { ThreadTodosView } from "../../thread-todos/thread-todos-view";
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
afterEach(() => { cleanup(); vi.restoreAllMocks(); delete (window as unknown as { __pwragentFederationTarget?: unknown }).__pwragentFederationTarget; });

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

  it("does not resubmit a rejected seen batch from a focused panel, refetch, or focus event", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const { api, changed } = fixture();
    const rejected: Array<(error: Error) => void> = [];
    api.markOperatorItemsSeen.mockImplementation(() => new Promise<void>((_resolve, reject) => { rejected.push(reject); }));
    function FocusedPanel() {
      const controller = useOperatorRequests(api);
      const view: ThreadTodosView = {
        ...controller, queueError: controller.error,
        open: [], openByThreadKey: new Map(), revision: 0, runningIds: new Set(), instances: [],
        threadTitle: () => "Example", resolve: async () => undefined, run: async () => undefined,
        setItemChecked: async () => undefined, openThread: () => {}, openStartedThread: () => {},
        respond: async () => {}, openWait: () => {}, threadTitleForKey: () => "Example", threadProjectForKey: () => undefined,
      };
      return <ThreadTodosPanel view={view} threadKey={threadTodoThreadKey({ ...question, federationTarget: target })} onStartReview={() => {}} />;
    }
    const panel = render(<FocusedPanel />);
    await waitFor(() => expect(api.markOperatorItemsSeen).toHaveBeenCalledTimes(1));
    await act(async () => rejected[0]!(new Error("Owner refused seen write")));
    expect(screen.getByRole("alert").textContent).toContain("Owner refused seen write");
    expect(api.markOperatorItemsSeen).toHaveBeenCalledTimes(1);
    act(() => changed({ reason: "questions", federationTarget: target }));
    await waitFor(() => expect(api.listOperatorRequests).toHaveBeenCalledTimes(2));
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(api.markOperatorItemsSeen).toHaveBeenCalledTimes(1);

    // A failed item must not block or join the batch for a newly viewed item.
    api.listOperatorRequests.mockResolvedValue({ serverRequests: [], seenKeys: [], questions: [
      { ...question, federationTarget: target }, { ...question, messageId: "new", federationTarget: target },
    ] });
    act(() => changed({ reason: "questions", federationTarget: target }));
    await waitFor(() => expect(api.markOperatorItemsSeen).toHaveBeenCalledTimes(2));
    expect(api.markOperatorItemsSeen).toHaveBeenLastCalledWith({ keys: [operatorQuestionItemKey("codex", "same", "new", target)] });
    await act(async () => rejected[1]!(new Error("Owner still refuses seen write")));
    expect(api.markOperatorItemsSeen).toHaveBeenCalledTimes(2);

    // Failed writes were never confirmed on the owner; a new controller can
    // attempt persistence again, once, when those items are viewed again.
    panel.unmount();
    render(<FocusedPanel />);
    await waitFor(() => expect(api.markOperatorItemsSeen).toHaveBeenCalledTimes(3));
    expect(api.markOperatorItemsSeen).toHaveBeenLastCalledWith({ keys: [
      operatorQuestionItemKey("codex", "same", "same", target), operatorQuestionItemKey("codex", "same", "new", target),
    ] });
    await act(async () => rejected[2]!(new Error("Owner still refuses seen write")));
    expect(api.markOperatorItemsSeen).toHaveBeenCalledTimes(3);
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

describe("operator queue refresh", () => {
  it("resolves only after a read that started after the call", async () => {
    const { api } = fixture();
    const reads: Array<() => void> = [];
    api.listOperatorRequests.mockImplementation(() => new Promise((resolve) => {
      reads.push(() => resolve({ serverRequests: [], seenKeys: [], questions: [] }));
    }));
    const { result } = renderHook(() => useOperatorRequests(api));
    // The mount's read is in flight; a refresh must not settle on it.
    await waitFor(() => expect(reads).toHaveLength(1));
    let settled = false;
    let refreshed!: Promise<void>;
    act(() => {
      refreshed = result.current.refresh().then(() => { settled = true; });
    });
    await act(async () => reads[0]!());
    await waitFor(() => expect(reads).toHaveLength(2));
    expect(settled).toBe(false);
    await act(async () => reads[1]!());
    await refreshed;
    expect(settled).toBe(true);
    expect(api.listOperatorRequests).toHaveBeenCalledTimes(2);
  });
});
