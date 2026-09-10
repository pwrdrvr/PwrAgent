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

  it.each([false, true])("keeps inactive transcript updates and reopens without a read (filtering=%s)", async (liveTranscriptEventFiltering) => {
    const threads = [remoteThread("A"), remoteThread("B")];
    const readThread = vi.fn(async ({ threadId }: { threadId: string }) => snapshot(threadId));
    const setFederationEventSubscriptions = vi.fn(async ({ subscriptions }) => ({ subscriptions }));
    let emit: (event: AgentEvent) => void = () => undefined;
    const desktopApi: DesktopApi = { readThread, setFederationEventSubscriptions, onAgentEvent: (listener) => {
      emit = listener; return () => undefined;
    } };
    const rendered = renderHook(({ thread }) => {
      const retainedRemoteThreads = useRecentRemoteThreads({ selectedThread: thread, threads });
      useFederationThreadEventSubscriptions({ desktopApi, enabled: true, selectedThread: thread, threads, retainedRemoteThreads });
      return useThreadSessionState({ desktopApi, thread, retainedRemoteThreads, liveTranscriptEventFiltering });
    }, { initialProps: { thread: threads[0]! } });
    await waitFor(() => expect(rendered.result.current.response?.threadId).toBe("A"));
    rendered.rerender({ thread: threads[1]! });
    await waitFor(() => expect(rendered.result.current.response?.threadId).toBe("B"));
    const federationTarget = { scope: "remote" as const, instanceId: "owner" };
    act(() => {
      emit({ backend: "codex", federationTarget, notification: { method: "turn/started", params: {
        threadId: "A", turn: { id: "turn-A", status: "in_progress" },
      } } });
      emit({ backend: "codex", federationTarget, notification: { method: "item/completed", params: {
        threadId: "A", turnId: "turn-A", item: { id: "answer-A", type: "agentMessage", phase: "final_answer", text: "Arrived while viewing B." },
      } } });
      emit({ backend: "codex", federationTarget, notification: { method: "turn/completed", params: {
        threadId: "A", turnId: "turn-A", turn: { id: "turn-A", status: "completed", output: [] },
      } } });
    });
    rendered.rerender({ thread: { ...threads[0]!, updatedAt: 2_000 } });
    await act(async () => undefined);
    expect(rendered.result.current.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "base-A", text: "Base A" }),
      expect.objectContaining({ id: "answer-A", text: "Arrived while viewing B." }),
    ]));
    expect(rendered.result.current.activeTurnId).toBeUndefined();
    expect(rendered.result.current.response?.replay.pagination.previousCursor).toBe("older");
    expect(readThread).toHaveBeenCalledTimes(2);
    // Switching back only changes LRU ordering, not the subscription set.
    expect(setFederationEventSubscriptions).toHaveBeenCalledTimes(2);
    expect(setFederationEventSubscriptions.mock.calls.every(([request]) => request.subscriptions.length > 0)).toBe(true);
    rendered.unmount();
    expect(setFederationEventSubscriptions).toHaveBeenLastCalledWith({ consumer: "thread_view", subscriptions: [] });
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
      useFederationThreadEventSubscriptions({ desktopApi, enabled: true, selectedThread: thread, threads, retainedRemoteThreads });
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
    expect(readThread).toHaveBeenCalledTimes(2);
    expect(desktopApi.setFederationEventSubscriptions).toHaveBeenCalledTimes(2);
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
