import { useMemo } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import type { AppServerPendingThreadStart } from "@pwragent/shared/contracts/normalized-app-server";
import { act, renderHook, waitFor } from "../../test/phase-probes";
import { useComposerDraftStore } from "../../features/composer/useComposerDraftStore";
import { navigationOwnerApiFixture, type NavigationOwnerFixtureApi as DesktopApi } from "../../test/navigation-owner-api-fixture";
import { useThreadNavigation as useRealThreadNavigation } from "../useThreadNavigation";

/**
 * The hook's side of a pending start: it draws only this machine's starts,
 * hands a landed start over to its thread's row after a read, and drops a
 * refused start at once.
 */

function useThreadNavigation(api: DesktopApi) {
  const composerDraftStore = useComposerDraftStore();
  const ownerApi = useMemo(() => navigationOwnerApiFixture(api, () => undefined), [api]);
  return useRealThreadNavigation(ownerApi, { composerDraftStore });
}

const start: AppServerPendingThreadStart = {
  startId: "thread-todo:card-1:run-1",
  title: "Fix the flaky export test",
  submittedAt: 1_000,
  backend: "codex",
  workMode: "worktree",
  cwd: "/repo/project",
  directoryKey: "directory:/repo/project",
  directoryLabel: "project",
  parentThreadId: "parent",
  parentThreadBackend: "codex",
  progressThread: { backend: "codex", threadId: "parent" },
};

function report(phase: "starting" | "landed" | "ended", patch: Partial<AgentEvent> = {}, createdThreadId?: string): AgentEvent {
  return {
    backend: "codex",
    notification: {
      method: "thread/start/pending",
      params: { start, phase, ...(createdThreadId ? { createdThreadId } : {}) },
    },
    ...patch,
  } as AgentEvent;
}

function mount() {
  let emit: ((event: AgentEvent) => void) | undefined;
  const readPopulation = vi.fn(async () => ({
    backend: "all" as const,
    fetchedAt: Date.now(),
    unchanged: false,
    inboxThreadKeys: [],
    threads: [],
    directories: [],
    launchpadDefaults: { backend: "codex" as const, executionMode: "default" as const },
  }));
  const api: DesktopApi = {
    readPopulation,
    onAgentEvent: (callback) => {
      emit = callback;
      return () => undefined;
    },
  };
  const hook = renderHook(() => useThreadNavigation(api));
  return { ...hook, emit: (event: AgentEvent) => act(() => { emit?.(event); }) };
}

afterEach(() => {
  delete (window as unknown as { __pwragentFederationTarget?: unknown }).__pwragentFederationTarget;
});

describe("useThreadNavigation pending thread starts", () => {
  it("draws a start from starting, keys it on landing, and retires it after a read once ended", async () => {
    const { result, emit } = mount();
    await waitFor(() => expect(result.current.loading).toBe(false));

    emit(report("starting"));
    expect(result.current.pendingThreadStartRows).toEqual([expect.objectContaining({
      title: "Fix the flaky export test",
      parentThreadKey: "codex:parent",
    })]);
    const selectionKey = result.current.pendingThreadStartRows[0]!.selectionKey;
    expect(result.current.pendingThreadStartTarget(selectionKey)).toEqual({ backend: "codex", threadId: "parent" });

    emit(report("landed", {}, "child"));
    expect(result.current.pendingThreadStartRows[0]).toMatchObject({ threadKey: "codex:child" });
    expect(result.current.pendingThreadStartTarget(selectionKey)).toEqual({ backend: "codex", threadId: "child" });

    emit(report("ended", {}, "child"));
    await waitFor(() => expect(result.current.pendingThreadStartRows).toEqual([]));
    // A late repeat of the start's reports never draws it again.
    emit(report("starting"));
    expect(result.current.pendingThreadStartRows).toEqual([]);
  });

  it("drops a refused start as soon as it ends", async () => {
    const { result, emit } = mount();
    await waitFor(() => expect(result.current.loading).toBe(false));

    emit(report("starting"));
    expect(result.current.pendingThreadStartRows).toHaveLength(1);
    emit(report("ended"));
    expect(result.current.pendingThreadStartRows).toEqual([]);
  });

  it("ignores a peer's start, and every start in a window showing a peer", async () => {
    const peer = { scope: "remote" as const, instanceId: "peer" };
    const { result, emit } = mount();
    await waitFor(() => expect(result.current.loading).toBe(false));

    emit(report("starting", { federationTarget: peer }));
    expect(result.current.pendingThreadStartRows).toEqual([]);

    (window as unknown as { __pwragentFederationTarget?: unknown }).__pwragentFederationTarget = peer;
    emit(report("starting"));
    expect(result.current.pendingThreadStartRows).toEqual([]);
  });
});
