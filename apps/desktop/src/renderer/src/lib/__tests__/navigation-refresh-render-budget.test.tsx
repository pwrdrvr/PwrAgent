import { Profiler } from "react";
import { act, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentEvent, NavigationThreadSummary } from "@pwragent/shared";
import { Sidebar } from "../../features/navigation/Sidebar";
import { ThreadRow } from "../../features/navigation/ThreadRow";
import * as order from "../../features/navigation/navigation-presentation-order";
import { memoRenderObserver } from "../../test/memo-render-observer";
import { navigationQueryFixture } from "../../test/navigation-query-fixture";
import type { DesktopApi } from "../desktop-api";
import { useThreadNavigation } from "../useThreadNavigation";

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
  const read = vi.fn<NonNullable<DesktopApi["getNavigationQueryPage"]>>(async (sent) => {
    const page = { ...navigationQueryFixture(sent, { directories, threads }), countsRevision: String(revision) };
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
    read.mockClear(); childOrder.mockClear(); encode.mockClear(); commits = 0; rowRenders = 0;
    gated = true;
    revision += 1;
    threads = threads.map((thread) => thread.id.endsWith("child-0") ? { ...thread, title: `${thread.title} fresh` } : thread);
    await act(async () => {
      const emit = (method: string, params: Record<string, unknown>) => {
        for (const listener of listeners) listener({ backend: "codex", notification: { method, params } } as AgentEvent);
      };
      // Seven canonical events, with one repeated Git probe. The Git events
      // patch rows without reading until background/seen schedules the burst.
      emit("navigation/threadGitWorkingState/updated", { worktreePath: "/project-0", state: "clean" });
      emit("navigation/threadGitWorkingState/updated", { worktreePath: "/project-1", state: "clean" });
      emit("navigation/threadGitWorkingState/updated", { worktreePath: "/project-0", state: "clean" });
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
    const pageSizes = encode.mock.calls.filter(([text]) => text?.includes('"countsRevision"')).length;
    console.info("navigation burst budget", { calls: read.mock.calls.length, childCalls: childCalls.length,
      unrelatedChildCalls: unrelatedChildCalls.length, commits, rowRenders, childProjections: childOrder.mock.calls.length, pageSizes });
    expect(unrelatedChildCalls).toHaveLength(0);
    expect(childCalls).toHaveLength(8);
    expect(childOrder.mock.calls.length).toBeLessThanOrEqual(commits);
    expect(pageSizes).toBeLessThanOrEqual(read.mock.calls.length);
  } finally { mounted.unmount(); rows.restore(); completions.splice(0).forEach((finish) => finish()); }
}, 30_000);
