import { useLayoutEffect } from "react";
import { act, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import { Sidebar } from "../../features/navigation/Sidebar";
import { navigationQueryFixture } from "../../test/navigation-query-fixture";
import type { DesktopApi } from "../desktop-api";
import { useThreadNavigation } from "../useThreadNavigation";

afterEach(() => vi.restoreAllMocks());

// The owner is the oracle for membership. Removing one viewer mount may
// remove that row, but cannot temporarily withdraw unrelated loaded roots or
// their disclosed children. Inspect every React commit, not just final state.
it.each([4, 8].flatMap((groups) => ["settled", "before-dispatch", "after-dispatch"].map((reply) => ({ groups, reply }))))(
  "publishes a removal coherently with $groups expanded projects, reply=$reply", async ({ groups, reply }) => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const directories = Array.from({ length: groups }, (_, i) => ({ key: `directory:/fixture-${i}`,
    kind: "directory" as const, label: `Project ${i}`, path: `/fixture-${i}` }));
  let threads: NavigationThreadSummary[] = directories.flatMap((directory, i) => {
    const parent: NavigationThreadSummary = { id: `parent-${i}`, source: "codex", title: `Parent ${i}`, titleSource: "explicit",
      createdAt: 100, updatedAt: 100, inbox: { inInbox: false },
      ...(i === 0 ? { federation: { ref: { backend: "codex" as const, threadId: `parent-${i}`,
        target: { scope: "remote" as const, instanceId: "peer" } }, instanceLabel: "Peer" } } : {}),
      linkedDirectories: [{ id: directory.key, kind: "local", path: directory.path, label: directory.label }] };
    return [parent, { ...parent, id: `child-${i}`, title: `Child ${i}`, parentThreadId: parent.id, parentThreadBackend: "codex",
      ...(parent.federation ? { federation: { ...parent.federation, ref: { ...parent.federation.ref, threadId: `child-${i}` } } } : {}) }];
  });
  const removed: NavigationThreadSummary = { ...threads[1]!, id: "removed", title: "Removed viewer mount",
    federation: { ref: { backend: "codex", threadId: "removed", target: { scope: "remote", instanceId: "peer" } }, instanceLabel: "Peer" } };
  const extraChildren = Array.from({ length: 11 }, (_, i) => ({ ...removed, id: `extra-${i}`, title: `Extra child ${i}`,
    federation: { ...removed.federation!, ref: { ...removed.federation!.ref, threadId: `extra-${i}` } } }));
  threads = [...threads, ...extraChildren, removed];
  const ownerThreads = threads;
  const listeners = new Set<(event: AgentEvent) => void>();
  const tasks = new Set<() => void>();
  const completions: Array<() => void> = [];
  let gated = false;
  let recording = false;
  const publications: string[][] = [];
  const read = vi.fn<NonNullable<DesktopApi["getNavigationQueryPage"]>>(async (request) => {
    // Viewer removal never changes the owner's thread or its relationships.
    const target = request.federationTarget;
    const population = target?.scope === "remote" ? ownerThreads.filter((thread) =>
      thread.federation?.ref.target.scope === "remote" && thread.federation.ref.target.instanceId === target.instanceId) : threads;
    const page = navigationQueryFixture(request, { directories, threads: population });
    if (gated) await new Promise<void>((resolve) => completions.push(resolve));
    return page;
  });
  const api: DesktopApi = { getNavigationQueryPage: read, releaseNavigationQuery: async () => undefined,
    onAgentEvent: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getNavigationSelectedDetail: async ({ ref }) => ({ protocol: 2, ref, revision: "detail", readiness: "ready", identity: "present",
      thread: ownerThreads.find((thread) => thread.id === ref.threadId) }),
  };
  let navigation!: ReturnType<typeof useThreadNavigation>;
  function Window() {
    navigation = useThreadNavigation(api, { scheduleNavigationRefresh: (task) => {
      tasks.add(task); return () => { tasks.delete(task); };
    } });
    useLayoutEffect(() => {
      if (recording) publications.push([...new Set([...document.querySelectorAll("[data-thread-key]")]
        .map((row) => row.getAttribute("data-thread-key")!.split(":").at(-1)!))].sort());
    });
    return <Sidebar backends={[]} browseMode={navigation.browseMode} directories={navigation.directories}
      directoryDisclosure={navigation.directoryDisclosure} threads={navigation.threads} inboxThreads={navigation.inboxThreads}
      pagedNavigation={navigation.pagedNavigation} loading={navigation.loading} selectedItemKey={navigation.selectedItemKey}
      selectedThreadDirectoryKeys={navigation.pagedNavigation.selectedDirectoryKeys}
      pagesAwaitingRows={navigation.pagesAwaitingRows}
      onBrowseModeChange={navigation.setBrowseMode} onSelectThread={navigation.selectThread}
      onCreateThread={async () => undefined} onOpenLaunchpad={async () => undefined} />;
  }
  const mounted = render(<Window />);
  const idle = () => [...navigation.pagedNavigation.resources.values()].every((resource) => !resource.loading);
  const drain = async (done: () => boolean = () => true) => {
    for (let i = 0; i < 300; i++) {
      await act(async () => {
        const scheduled = [...tasks]; tasks.clear(); scheduled.forEach((task) => task());
        // IPC responses land independently, so each can expose a partial publication.
        // Reverse delivery in the early-reply case also exercises pages
        // arriving in a different order from dispatch.
        (reply !== "settled" ? completions.pop() : completions.shift())?.();
      });
      if (done() && idle() && !tasks.size && !completions.length) return;
    }
    throw new Error("Removal exceeded its deterministic response budget");
  };
  try {
    await waitFor(() => expect(navigation.threads.length).toBeGreaterThan(0));
    await act(async () => {
      navigation.setBrowseMode("directories");
      navigation.directoryDisclosure.setExpandedByKey(Object.fromEntries(directories.map((directory) => [directory.key, true])));
    });
    await drain();
    await act(async () => { navigation.selectThread(removed); });
    await drain();
    const childResource = [...navigation.pagedNavigation.resources.values()].find((resource) =>
      resource.state.request.query.kind === "children" && resource.state.request.query.parent.threadId === "parent-0"
      && resource.state.request.query.directoryKey !== undefined)!;
    await act(async () => { await navigation.pagedNavigation.loadMore(childResource.id); });
    await drain();
    expect(childResource.state.request.query.kind).toBe("children");
    expect(navigation.pagedNavigation.resources.get(childResource.id)!.state.page?.entries).toHaveLength(13);
    expect(navigation.threads).toHaveLength(2 * groups + 12);
    const stable = threads.filter((thread) => thread.id !== removed.id).map((thread) => thread.id).sort();
    gated = true; recording = true; read.mockClear();
    await act(async () => {
      threads = threads.filter((thread) => thread.id !== removed.id);
      const event: AgentEvent = { backend: "codex", notification: { method: "navigation/remoteThreadPins/changed",
        params: { instanceId: "peer", threadId: removed.id, pinned: false } } };
      for (const listener of listeners) listener(event);
    });
    let finished = false;
    if (reply === "settled") await drain();
    if (reply === "after-dispatch") {
      await act(async () => {
        const scheduled = [...tasks]; tasks.clear(); scheduled.forEach((task) => task());
      });
      expect(completions.length).toBeGreaterThan(0);
    }
    const wave = read.mock.calls.length;
    await act(async () => { void navigation.refresh("action/remote-pin-remove").then(() => { finished = true; }); });
    if (reply === "after-dispatch") expect(finished).toBe(false);
    await drain(() => finished);
    for (const published of publications) expect(published.filter((id) => id !== removed.id)).toEqual(stable);
    const membership = publications.map((published) => published.includes(removed.id));
    const transitions = membership.filter((value, i) => i === 0 || value !== membership[i - 1]);
    expect(transitions).toEqual([true, false]);
    expect(navigation.selectedThread?.id).toBe(removed.id);
    // The action reply must consume its notification's work, without buying
    // another discovery wave across every unrelated expanded collection.
    if (reply === "settled") expect(read.mock.calls.length - wave).toBe(0);
    expect(read.mock.calls).toHaveLength(3 * groups + 3);
    expect(navigation.pagedNavigation.resources.get(childResource.id)!.state.page?.entries).toHaveLength(12);
  } finally { mounted.unmount(); completions.splice(0).forEach((complete) => complete()); }
}, 15_000);
