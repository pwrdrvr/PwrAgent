import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentEvent, AppServerReadThreadResponse, FederationPeerSummary, NavigationThreadSummary } from "@pwragent/shared";
import type { DesktopApi } from "../desktop-api";
import { useRecentRemoteThreads } from "../useRecentRemoteThreads";
import { useFederationThreadEventSubscriptions } from "../useFederationThreadEventSubscriptions";
import { useThreadSessionState } from "../useThreadSessionState";
import { threadOwnerPlatform } from "../federated-thread-events";
import { useFederationPeerConnectivity } from "../useFederationPeerConnectivity";

function remoteThread(id: string, instanceId = "owner"): NavigationThreadSummary {
  return {
    id, source: "codex", title: id, titleSource: "explicit", linkedDirectories: [],
    inbox: { inInbox: false }, updatedAt: 1_000, threadStatus: "idle",
    federation: {
      ref: { backend: "codex", threadId: id, target: { scope: "remote", instanceId } },
      instanceLabel: instanceId, peerStatus: "connected",
      capabilities: ["event_subscriptions", "thread_detail", "thread_navigation", "pending_request_control"],
    },
  };
}

function snapshot(id: string): AppServerReadThreadResponse {
  return {
    backend: "codex", threadId: id, fetchedAt: 1_000, threadStatus: "idle", replayRevision: `revision-${id}`,
    replay: {
      entries: [{ type: "message", id: `base-${id}`, role: "user", text: `Base ${id}` }], messages: [],
      pagination: { supportsPagination: true, hasPreviousPage: true, previousCursor: "older" },
    },
  };
}

const pendingInteractions: NonNullable<AppServerReadThreadResponse["pendingRequest"]>[] = [
  { method: "item/commandExecution/requestApproval", params: {
    threadId: "A", turnId: "turn-A", itemId: "command-A", requestId: "request-A", command: "echo test",
  } },
  { method: "item/tool/requestUserInput", params: {
    threadId: "A", turnId: "turn-A", requestId: "request-A", questions: [{
      id: "choice", header: "Choice", question: "Continue?", isOther: false, isSecret: false,
      options: [{ label: "Yes", description: "Continue." }],
    }],
  } },
  { method: "mcpServer/elicitation/request", params: {
    threadId: "A", turnId: "turn-A", requestId: "request-A", serverName: "fixture", mode: "form",
    message: "Continue?", requestedSchema: { type: "object", properties: {} },
  } },
];

describe("recent remote threads", () => {
  it("retains five selections by owner identity, ignores background activity and releases revoked interests", () => {
    const threads = Array.from({ length: 6 }, (_, index) => remoteThread(String(index)));
    const rendered = renderHook(({ selectedThread, threads }) => useRecentRemoteThreads({ selectedThread, threads }), {
      initialProps: { selectedThread: threads[0]!, threads },
    });
    for (const selectedThread of threads.slice(1)) rendered.rerender({ selectedThread, threads });
    expect(rendered.result.current.map((thread) => thread.id)).toEqual(["5", "4", "3", "2", "1"]);
    const background = { ...threads[1]!, updatedAt: 2_000 };
    rendered.rerender({ selectedThread: threads[5]!, threads: [background, ...threads.filter((thread) => thread.id !== "1")] });
    expect(rendered.result.current.map((thread) => thread.id)).toEqual(["5", "4", "3", "2", "1"]);
    expect(rendered.result.current[4]!.updatedAt).toBe(2_000);
    const otherOwner = remoteThread("5", "other-owner");
    rendered.rerender({ selectedThread: otherOwner, threads });
    expect(rendered.result.current.slice(0, 2).map((thread) => thread.federation?.ref.target)).toEqual([
      { scope: "remote", instanceId: "other-owner" }, { scope: "remote", instanceId: "owner" },
    ]);
    const revoked = { ...otherOwner, federation: { ...otherOwner.federation!, capabilities: [] } };
    rendered.rerender({ selectedThread: revoked, threads });
    expect(rendered.result.current).not.toContainEqual(otherOwner);
  });

  it.each([false, true])("streams only the visible thread and catches up its cached snapshot on return (filtering=%s)", async (liveTranscriptEventFiltering) => {
    const threads = [remoteThread("A"), remoteThread("B")];
    let ownerSnapshot = snapshot("A");
    const readThread = vi.fn(async ({ threadId }: { threadId: string }) => threadId === "A" ? ownerSnapshot : snapshot(threadId));
    const setFederationEventSubscriptions = vi.fn(async ({ subscriptions }) => ({ subscriptions }));
    const desktopApi: DesktopApi = { readThread, setFederationEventSubscriptions, onAgentEvent: () => () => undefined };
    const rendered = renderHook(({ thread }) => {
      const retainedRemoteThreads = useRecentRemoteThreads({ selectedThread: thread, threads });
      useFederationThreadEventSubscriptions({ desktopApi, enabled: true, selectedThread: thread, threads });
      const session = useThreadSessionState({ desktopApi, thread, retainedRemoteThreads, liveTranscriptEventFiltering });
      return { ...session, retainedRemoteThreads };
    }, { initialProps: { thread: threads[0]! } });
    await waitFor(() => expect(rendered.result.current.response?.threadId).toBe("A"));
    rendered.rerender({ thread: threads[1]! });
    await waitFor(() => expect(rendered.result.current.response?.threadId).toBe("B"));
    expect(rendered.result.current.retainedRemoteThreads.map((thread) => thread.id)).toEqual(["B", "A"]);
    expect(setFederationEventSubscriptions).toHaveBeenLastCalledWith({
      consumer: "thread_view",
      subscriptions: [expect.objectContaining({ eventClassSelections: {
        navigation: { kind: "threads", threads: [{ backend: "codex", threadId: "A" }, { backend: "codex", threadId: "B" }] },
        transcript: { kind: "threads", threads: [{ backend: "codex", threadId: "B" }] },
        pending_requests: { kind: "threads", threads: [{ backend: "codex", threadId: "B" }] },
      } })],
    });
    // A completes without any transcript event or navigation timestamp reaching this window.
    ownerSnapshot = { ...snapshot("A"), replayRevision: "completed-A", replay: {
      ...snapshot("A").replay,
      entries: [...snapshot("A").replay.entries, {
        type: "message", id: "answer-A", role: "assistant", text: "Completed while viewing B.",
      }],
    } };
    rendered.rerender({ thread: threads[0]! });
    await waitFor(() => expect(readThread).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(rendered.result.current.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "base-A", text: "Base A" }),
      expect.objectContaining({ id: "answer-A", text: "Completed while viewing B." }),
    ])));
    expect(readThread).toHaveBeenLastCalledWith(expect.objectContaining({ threadId: "A", knownRevision: "revision-A" }));
    expect(rendered.result.current.response?.replay.pagination.previousCursor).toBe("older");
    expect(setFederationEventSubscriptions).toHaveBeenCalledTimes(3);
    rendered.unmount();
    expect(setFederationEventSubscriptions).toHaveBeenLastCalledWith({ consumer: "thread_view", subscriptions: [] });
  });

  it.each(pendingInteractions)("reconciles an off-screen resolved $method on return", async (pendingRequest) => {
    const threads = [remoteThread("A"), remoteThread("B")];
    let ownerSnapshot = { ...snapshot("A"), pendingRequest } as AppServerReadThreadResponse;
    const readThread = vi.fn(async ({ threadId }: { threadId: string }) => threadId === "A" ? ownerSnapshot : snapshot(threadId));
    const desktopApi: DesktopApi = { readThread, onAgentEvent: () => () => undefined };
    const rendered = renderHook(({ thread }) => useThreadSessionState({ desktopApi, thread, retainedRemoteThreads: threads }), {
      initialProps: { thread: threads[0]! },
    });
    await waitFor(() => expect(rendered.result.current.pendingStatusText).toMatch(/^Waiting for/));
    rendered.rerender({ thread: threads[1]! });
    await waitFor(() => expect(rendered.result.current.response?.threadId).toBe("B"));
    ownerSnapshot = { ...snapshot("A"), replayRevision: "resolved-A" };
    rendered.rerender({ thread: threads[0]! });
    await waitFor(() => expect(rendered.result.current.response?.replayRevision).toBe("resolved-A"));
    expect(rendered.result.current.pendingRequest).toBeUndefined();
    expect(rendered.result.current.pendingUserInput).toBeUndefined();
    expect(rendered.result.current.pendingMcpInteraction).toBeUndefined();
    expect(rendered.result.current.pendingStatusText).toBeUndefined();
    expect(rendered.result.current.activeTurnId).toBeUndefined();
  });

  it.each(["arrived", "resolved"])("preserves a live request that %s during catch-up", async (change) => {
    const threads = [remoteThread("A"), remoteThread("B")];
    const pendingRequest = pendingInteractions[0]!;
    const initial = { ...snapshot("A"), ...(change === "resolved" ? { pendingRequest } : {}) };
    let finishRead!: (response: AppServerReadThreadResponse) => void;
    const readThread = vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(snapshot("B"))
      .mockImplementationOnce(() => new Promise<AppServerReadThreadResponse>((resolve) => { finishRead = resolve; }));
    let emit: (event: AgentEvent) => void = () => undefined;
    const desktopApi: DesktopApi = { readThread, onAgentEvent: (listener) => { emit = listener; return () => undefined; } };
    const rendered = renderHook(({ thread }) => useThreadSessionState({ desktopApi, thread, retainedRemoteThreads: threads }), {
      initialProps: { thread: threads[0]! },
    });
    await waitFor(() => expect(rendered.result.current.response?.threadId).toBe("A"));
    rendered.rerender({ thread: threads[1]! });
    await waitFor(() => expect(rendered.result.current.response?.threadId).toBe("B"));
    rendered.rerender({ thread: threads[0]! });
    await waitFor(() => expect(readThread).toHaveBeenCalledTimes(3));
    act(() => emit({ backend: "codex", federationTarget: { scope: "remote", instanceId: "owner" },
      notification: change === "arrived" ? pendingRequest : {
        method: "serverRequest/resolved", params: { threadId: "A", requestId: "request-A" },
      },
    }));
    await act(async () => finishRead({ ...initial, replayRevision: "catch-up-A" }));
    await waitFor(() => expect(rendered.result.current.loading).toBe(false));
    expect(rendered.result.current.pendingRequest?.params.requestId).toBe(change === "arrived" ? "request-A" : undefined);
  });

  it("recovers a retained thread after a background stream gap using its owner revision", async () => {
    const threads = [remoteThread("A"), remoteThread("B")];
    const readThread = vi.fn(async ({ threadId, knownRevision }: { threadId: string; knownRevision?: string }) => knownRevision
      ? { ...snapshot(threadId), unchanged: true, replay: { entries: [], messages: [], pagination: { supportsPagination: false, hasPreviousPage: false } } }
      : snapshot(threadId));
    let emit: (event: AgentEvent) => void = () => undefined;
    const desktopApi: DesktopApi = { readThread, onAgentEvent: (listener) => { emit = listener; return () => undefined; } };
    const rendered = renderHook(({ thread }) => useThreadSessionState({ desktopApi, thread, retainedRemoteThreads: threads }), {
      initialProps: { thread: threads[0]! },
    });
    await waitFor(() => expect(rendered.result.current.response?.threadId).toBe("A"));
    rendered.rerender({ thread: threads[1]! });
    await waitFor(() => expect(rendered.result.current.response?.threadId).toBe("B"));
    act(() => emit({ backend: "codex", notification: { method: "federation/eventStream/changed", params: { instanceId: "owner", epoch: "recovered-stream" } } }));
    await waitFor(() => expect(readThread).toHaveBeenCalledTimes(3));
    rendered.rerender({ thread: threads[0]! });
    await waitFor(() => expect(readThread).toHaveBeenCalledTimes(4));
    expect(readThread).toHaveBeenLastCalledWith(expect.objectContaining({ threadId: "A", knownRevision: "revision-A" }));
    expect(rendered.result.current.entries).toEqual(expect.arrayContaining([expect.objectContaining({ id: "base-A" })]));
  });

  it("keeps the retained session through the health probe when switching owners", async () => {
    const threads = [remoteThread("A"), remoteThread("B", "other-owner")];
    const readThread = vi.fn(async ({ threadId }: { threadId: string }) => snapshot(threadId));
    let finishHealth: (() => void) | undefined;
    const desktopApi = {
      readThread,
      onAgentEvent: () => () => undefined,
      setFederationEventSubscriptions: vi.fn(async ({ subscriptions }) => ({ subscriptions })),
      readFederationHealth: vi.fn(() => new Promise((resolve) => {
        finishHealth = () => resolve({ health: { peers: [
          { id: "owner", status: "connected" }, { id: "other-owner", status: "connected" },
        ] } });
      })),
    } as DesktopApi;
    const rendered = renderHook(({ thread }) => {
      const retainedRemoteThreads = useRecentRemoteThreads({ selectedThread: thread, threads });
      useFederationThreadEventSubscriptions({ desktopApi, enabled: true, selectedThread: thread, threads });
      const target = thread.federation!.ref.target;
      const connectivity = useFederationPeerConnectivity({ desktopApi, target: target.scope === "remote" ? target : undefined });
      return useThreadSessionState({ desktopApi, thread, retainedRemoteThreads, suspended: !connectivity.ready || !connectivity.connected });
    }, { initialProps: { thread: threads[0]! } });
    await act(async () => finishHealth?.());
    await waitFor(() => expect(rendered.result.current.response?.threadId).toBe("A"));
    rendered.rerender({ thread: threads[1]! });
    await act(async () => finishHealth?.());
    await waitFor(() => expect(rendered.result.current.response?.threadId).toBe("B"));
    rendered.rerender({ thread: threads[0]! });
    await act(async () => finishHealth?.());
    expect(rendered.result.current.entries).toEqual(expect.arrayContaining([expect.objectContaining({ id: "base-A" })]));
    await waitFor(() => expect(readThread).toHaveBeenCalledTimes(3));
    expect(desktopApi.setFederationEventSubscriptions).toHaveBeenCalledTimes(3);
  });

  it("evicts the sixth-oldest snapshot and does not reuse its forgotten revision", async () => {
    const threads = Array.from({ length: 6 }, (_, index) => remoteThread(String(index)));
    const readThread = vi.fn(async ({ threadId }: { threadId: string }) => snapshot(threadId));
    const desktopApi: DesktopApi = { readThread, onAgentEvent: () => () => undefined };
    const rendered = renderHook(({ thread }) => {
      const retainedRemoteThreads = useRecentRemoteThreads({ selectedThread: thread, threads });
      return useThreadSessionState({ desktopApi, thread, retainedRemoteThreads });
    }, { initialProps: { thread: threads[0]! } });
    for (const thread of threads) {
      rendered.rerender({ thread });
      await waitFor(() => expect(rendered.result.current.response?.threadId).toBe(thread.id));
    }
    rendered.rerender({ thread: threads[0]! });
    await waitFor(() => expect(readThread).toHaveBeenCalledTimes(7));
    expect(readThread).toHaveBeenLastCalledWith(expect.objectContaining({ threadId: "0", knownRevision: "" }));
  });
});

it("shows the owning desktop platform and never substitutes the viewer for an unknown remote owner", () => {
  const peers = [{ id: "owner", host: { platform: "darwin" } }] as FederationPeerSummary[];
  expect(threadOwnerPlatform({ target: { scope: "remote", instanceId: "owner" }, peers, localPlatform: "win32" })).toBe("darwin");
  expect(threadOwnerPlatform({ target: { scope: "remote", instanceId: "unknown" }, peers, localPlatform: "win32" })).toBeUndefined();
  expect(threadOwnerPlatform({ peers, localPlatform: "win32" })).toBe("win32");
});
