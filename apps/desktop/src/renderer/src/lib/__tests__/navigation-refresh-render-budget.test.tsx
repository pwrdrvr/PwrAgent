import { Profiler } from "react";
import { act, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentEvent, NavigationThreadSummary } from "@pwragent/shared";
import { buildPullRequestStatusKey } from "@pwragent/shared";
import { Sidebar } from "../../features/navigation/Sidebar";
import { ThreadRow } from "../../features/navigation/ThreadRow";
import * as order from "../../features/navigation/navigation-presentation-order";
import { memoRenderObserver } from "../../test/memo-render-observer";
import { navigationQueryFixture } from "../../test/navigation-query-fixture";
import type { DesktopApi } from "../desktop-api";
import { useThreadNavigation } from "../useThreadNavigation";
import { NavigationWindowQueries } from "../navigation-window-queries";

afterEach(() => vi.restoreAllMocks());

it("bounds IPC, row, child projection and byte-sizing work for a small burst in twelve expanded projects", async () => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const directories = Array.from({ length: 12 }, (_, i) => ({
    key: `directory:/project-${i}`, kind: "directory" as const, label: `Project ${i}`, path: `/project-${i}`,
  }));
  let threads: NavigationThreadSummary[] = directories.flatMap((directory, i) => Array.from({ length: 4 }, (_, j) => {
    const parent: NavigationThreadSummary = { id: `parent-${i}-${j}`, source: "codex", title: `Parent ${i} ${j}`,
      titleSource: "explicit", createdAt: 100 - j, updatedAt: 100 - j, inbox: { inInbox: false },
      ...(j < 2 ? { pinnedRank: String(i * 4 + j + 1) } : {}),
      linkedDirectories: [{ id: directory.key, kind: "local", label: directory.label, path: directory.path }],
    };
    return [parent, ...Array.from({ length: 2 }, (_, k): NavigationThreadSummary => ({ ...parent,
      id: `${parent.id}-child-${k}`, title: `Child ${i} ${j} ${k}`, pinnedRank: undefined,
      parentThreadId: parent.id, parentThreadBackend: "codex",
    }))];
  }).flat());
  const listeners = new Set<(event: AgentEvent) => void>();
  const tasks = new Set<() => void>();
  const completions: Array<() => void> = [];
  let gated = false;
  let revision = 0;
  let incomingBytes = 0;
  const read = vi.fn<NonNullable<DesktopApi["getNavigationQueryPage"]>>(async (sent) => {
    const page = { ...navigationQueryFixture(sent, { directories, threads }), countsRevision: String(revision) };
    incomingBytes += Buffer.byteLength(JSON.stringify(page), "utf8");
    if (gated) await new Promise<void>((resolve) => completions.push(resolve));
    return page;
  });
  const api: DesktopApi = { getNavigationQueryPage: read, releaseNavigationQuery: async () => undefined,
    onAgentEvent: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getNavigationSelectedDetail: async ({ ref }) => ({ protocol: 2, ref, revision: "detail", readiness: "ready",
      identity: "present", thread: threads.find((thread) => thread.id === ref.threadId) }),
  };
  let navigation!: ReturnType<typeof useThreadNavigation>;
  let commits = 0;
  let rowRenders = 0;
  const rows = memoRenderObserver<{ thread: NavigationThreadSummary }>(ThreadRow, "ThreadRow");
  rows.install(() => { rowRenders += 1; });
  const childOrder = vi.spyOn(order, "readOwnerChildOrder");
  const encode = vi.spyOn(TextEncoder.prototype, "encode");
  function Window() {
    navigation = useThreadNavigation(api, { scheduleNavigationRefresh: (callback) => {
      tasks.add(callback); return () => { tasks.delete(callback); };
    } });
    return <Profiler id="navigation" onRender={() => { commits += 1; }}>
      <Sidebar backends={[]} browseMode={navigation.browseMode} directories={navigation.directories}
        directoryDisclosure={navigation.directoryDisclosure} threads={navigation.threads} inboxThreads={navigation.inboxThreads}
        pagedNavigation={navigation.pagedNavigation} loading={navigation.loading} selectedItemKey={navigation.selectedItemKey}
        selectedThreadDirectoryKeys={navigation.pagedNavigation.selectedDirectoryKeys}
        onBrowseModeChange={navigation.setBrowseMode} onSelectThread={navigation.selectThread}
        onCreateThread={async () => undefined} onOpenLaunchpad={async () => undefined} />
    </Profiler>;
  }
  const mounted = render(<Window />);
  const idle = () => [...navigation.pagedNavigation.resources.values()].every((resource) => !resource.loading);
  try {
    await waitFor(() => expect(navigation.threads.length).toBeGreaterThan(0));
    await act(async () => {
      navigation.setBrowseMode("directories");
      navigation.directoryDisclosure.setExpandedByKey(Object.fromEntries(directories.map((directory) => [directory.key, true])));
    });
    await waitFor(() => {
      expect(navigation.pagedNavigation.resources.size).toBeGreaterThanOrEqual(73);
      expect(idle()).toBe(true);
    });
    read.mockClear(); childOrder.mockClear(); encode.mockClear(); commits = 0; rowRenders = 0; incomingBytes = 0;
    gated = true;
    revision += 1;
    threads = threads.map((thread) => /^parent-[01]-.*child-0$/.test(thread.id) ? { ...thread, title: `${thread.title} fresh` } : thread);
    await act(async () => {
      const emit = (method: string, params: Record<string, unknown>) => {
        for (const listener of listeners) listener({ backend: "codex", navigationDirectoryScope: { version: 1, directoryKeys: [
          `directory:${params.worktreePath ?? (String(params.threadId).startsWith("parent-0-") ? "/project-0" : "/project-1")}`,
        ] }, notification: { method, params } } as AgentEvent);
      };
      // Seven canonical events, with one repeated Git probe. The Git events
      // patch rows without reading until background/seen schedules the burst.
      emit("navigation/threadGitWorkingState/updated", { worktreePath: "/project-0", gitWorkingState: null, fetchedAt: 101 });
      emit("navigation/threadGitWorkingState/updated", { worktreePath: "/project-1", gitWorkingState: null, fetchedAt: 101 });
      emit("navigation/threadGitWorkingState/updated", { worktreePath: "/project-0", gitWorkingState: null, fetchedAt: 101 });
      for (const i of [0, 1]) {
        emit("thread/backgroundTasks/updated", { threadId: `parent-${i}-0-child-0`, tasks: [] });
        emit("navigation/thread/seen", { threadId: `parent-${i}-0-child-0`, seenUpdatedAt: 101 });
      }
      const scheduled = [...tasks]; tasks.clear(); scheduled.forEach((task) => task());
    });
    // Each physical response lands in a separate React task, as IPC does.
    for (let step = 0; step < 500 && !idle(); step++) {
      await act(async () => { completions.shift()?.(); });
    }
    expect(idle()).toBe(true);
    const childCalls = read.mock.calls.filter(([sent]) => sent.query.kind === "children");
    const unrelatedChildCalls = childCalls.filter(([sent]) => sent.query.kind === "children"
      && !/^parent-[01]-/.test(sent.query.parent.threadId));
    const sizedPages = encode.mock.calls.flatMap(([text], index) => text?.includes('"countsRevision"')
      ? [encode.mock.results[index]!.value as Uint8Array] : []);
    const pageSizes = sizedPages.length;
    const sizedBytes = sizedPages.reduce((total, bytes) => total + bytes.byteLength, 0);
    console.info("navigation burst budget", { calls: read.mock.calls.length, childCalls: childCalls.length,
      unrelatedChildCalls: unrelatedChildCalls.length, commits, rowRenders, childProjections: childOrder.mock.calls.length,
      pageSizes, sizedBytes, incomingBytes });
    expect(unrelatedChildCalls).toHaveLength(0);
    expect(childCalls).toHaveLength(8);
    const directoryCalls = read.mock.calls.filter(([sent]) => sent.query.kind === "directory");
    expect(directoryCalls).toHaveLength(4);
    expect(directoryCalls.every(([sent]) => sent.query.kind === "directory"
      && [directories[0]!.key, directories[1]!.key].includes(sent.query.directoryKey))).toBe(true);
    expect(read).toHaveBeenCalledTimes(14);
    expect(new Set(read.mock.calls.map(([sent]) => JSON.stringify(sent.query))).size).toBe(14);
    expect(commits).toBeLessThanOrEqual(2 * read.mock.calls.length + 3);
    expect(rowRenders).toBeLessThanOrEqual(32);
    expect(childOrder.mock.calls.length).toBeLessThanOrEqual(commits);
    expect(pageSizes).toBeLessThanOrEqual(read.mock.calls.length);
    expect(sizedBytes).toBe(incomingBytes);
  } finally { mounted.unmount(); rows.restore(); completions.splice(0).forEach((finish) => finish()); }
}, 30_000);

it.each([4, 16, 48].flatMap((groups) => [0, 1].map((kind) => ({ groups, kind }))))("bounds unrelated metadata refresh $kind with $groups expanded mounted roots", async ({ groups, kind }) => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const home = { key: "directory:/fixture", kind: "directory" as const, label: "Fixture", path: "/fixture" };
  const target = { scope: "remote" as const, instanceId: "peer" };
  const threads: NavigationThreadSummary[] = Array.from({ length: groups }, (_, i) => {
    const parent: NavigationThreadSummary = { id: `parent-${i}`, source: "codex", title: `Parent ${i}`, titleSource: "explicit",
      pinnedRank: String(i + 1), createdAt: groups - i, inbox: { inInbox: false },
      linkedDirectories: [{ id: home.key, kind: "local", label: home.label, path: home.path }],
      federation: { ref: { backend: "codex", threadId: `parent-${i}`, target }, instanceLabel: "Peer", peerStatus: "connected" },
    };
    return [parent, { ...parent, id: `child-${i}`, title: `Child ${i}`, pinnedRank: undefined,
      parentThreadId: parent.id, parentThreadBackend: "codex" as const,
      federation: { ...parent.federation!, ref: { ...parent.federation!.ref, threadId: `child-${i}` } } }];
  }).flat();
  const listeners = new Set<(event: AgentEvent) => void>();
  const tasks = new Set<() => void>();
  const replies: Array<() => void> = [];
  let gated = false;
  const read = vi.fn<NonNullable<DesktopApi["getNavigationQueryPage"]>>(async (request) => {
    const page = navigationQueryFixture(request, { directories: [home], threads });
    if (gated) await new Promise<void>((resolve) => replies.push(resolve));
    return page;
  });
  const api: DesktopApi = { getNavigationQueryPage: read, releaseNavigationQuery: async () => undefined,
    onAgentEvent: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  let navigation!: ReturnType<typeof useThreadNavigation>;
  let commits = 0;
  let rowRenders = 0;
  const rows = memoRenderObserver<{ thread: NavigationThreadSummary }>(ThreadRow, "ThreadRow");
  rows.install(() => { rowRenders += 1; });
  const publish = vi.spyOn(NavigationWindowQueries.prototype as unknown as { publish: () => void }, "publish");
  function Window() {
    navigation = useThreadNavigation(api, { scheduleNavigationRefresh: (task) => {
      tasks.add(task); return () => { tasks.delete(task); };
    } });
    return <Profiler id="mounted-navigation" onRender={() => { commits += 1; }}>
      <Sidebar backends={[]} browseMode={navigation.browseMode} directories={navigation.directories}
        directoryDisclosure={navigation.directoryDisclosure} threads={navigation.threads} inboxThreads={navigation.inboxThreads}
        pagedNavigation={navigation.pagedNavigation} loading={navigation.loading} selectedItemKey={navigation.selectedItemKey}
        selectedThreadDirectoryKeys={navigation.pagedNavigation.selectedDirectoryKeys}
        onBrowseModeChange={navigation.setBrowseMode} onSelectThread={navigation.selectThread}
        onCreateThread={async () => undefined} onOpenLaunchpad={async () => undefined} />
    </Profiler>;
  }
  const mounted = render(<Window />);
  const idle = () => [...navigation.pagedNavigation.resources.values()].every((resource) => !resource.loading);
  try {
    await waitFor(() => expect(navigation.threads.length).toBeGreaterThan(0));
    await act(async () => {
      navigation.setBrowseMode("directories");
      navigation.directoryDisclosure.setExpandedByKey({ [home.key]: true });
    });
    await waitFor(() => expect(idle()).toBe(true));
    const pins = `directory-pins:${home.key}`;
    if (!navigation.pagedNavigation.resources.get(pins)?.state.page?.complete) {
      await act(async () => { await navigation.pagedNavigation.loadMore(pins); });
    }
    await waitFor(() => {
      expect([...navigation.pagedNavigation.resources.values()].filter((resource) => resource.state.request.query.kind === "children")).toHaveLength(groups);
      expect(idle()).toBe(true);
    });
    const pr = { provider: "github" as const, org: "fixture", repo: "unrelated", number: 1,
      url: "https://github.com/fixture/unrelated/pull/1", state: "passing" as const };
    const changes: AgentEvent[] = [
      { backend: "codex", notification: { method: "navigation/remoteThreadPins/changed", params: { instanceId: "peer",
        rowChanges: [{ backend: "codex", threadId: "offscreen-sibling", ownerInstanceId: "peer" }] } } },
      { backend: "codex", notification: { method: "pullRequest/status/updated", params: { prKey: buildPullRequestStatusKey(pr), pr } } },
    ];
    for (const event of [changes[kind]!]) {
      read.mockClear(); publish.mockClear(); commits = 0; rowRenders = 0; gated = true;
      await act(async () => {
        for (const listener of listeners) listener(event);
        const scheduled = [...tasks]; tasks.clear(); scheduled.forEach((task) => task());
      });
      for (let i = 0; i < 200 && !idle(); i++) await act(async () => { replies.shift()?.(); });
      expect(idle()).toBe(true);
      const childCalls = read.mock.calls.filter(([sent]) => sent.query.kind === "children").length;
      console.info("mounted metadata budget", { groups, method: event.notification.method,
        calls: read.mock.calls.length, childCalls, publications: publish.mock.calls.length, commits, rowRenders });
      expect(childCalls).toBe(0);
      expect(read.mock.calls.length).toBe(groups > 10 ? 5 : 4);
      expect(publish).toHaveBeenCalledTimes(9);
      expect(commits).toBeLessThanOrEqual(10);
      expect(rowRenders).toBe(0);
    }
  } finally { mounted.unmount(); rows.restore(); replies.splice(0).forEach((reply) => reply()); }
}, 30_000);
