import { Profiler } from "react";
import { act, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentEvent, NavigationLaunchpadDraft, NavigationThreadSummary } from "@pwragent/shared";
import { Sidebar } from "../../features/navigation/Sidebar";
import { ThreadRow } from "../../features/navigation/ThreadRow";
import { memoRenderObserver } from "../../test/memo-render-observer";
import { navigationQueryFixture } from "../../test/navigation-query-fixture";
import type { DesktopApi } from "../desktop-api";
import { NavigationWindowQueries } from "../navigation-window-queries";
import { useThreadNavigation } from "../useThreadNavigation";

afterEach(() => vi.restoreAllMocks());

// Metamorphic property: doubling unrelated expanded directories and child
// collections cannot increase the revalidation cost of one completed action.
// Membership notifications have their own discovery budget; action replies
// must not repeat that wave or mark unrelated membership uncertain again.
it.each([4, 8, 16])("bounds create, off-page select and submit reply work with %i expanded directories", async (groups) => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const defaults = { backend: "codex" as const, executionMode: "default" as const };
  const directories = Array.from({ length: groups }, (_, i) => ({ key: `directory:/project-${i}`,
    kind: "directory" as const, label: `Project ${i}`, path: `/project-${i}` }));
  let draft: NavigationLaunchpadDraft | undefined;
  let threads: NavigationThreadSummary[] = directories.flatMap((directory, i) => {
    const parent: NavigationThreadSummary = { id: `parent-${i}`, source: "codex", title: `Parent ${i}`,
      titleSource: "explicit", createdAt: 100, updatedAt: 100, inbox: { inInbox: false },
      linkedDirectories: [{ id: directory.key, kind: "local", label: directory.label, path: directory.path }] };
    return [parent, { ...parent, id: `child-${i}`, title: `Child ${i}`, parentThreadId: parent.id, parentThreadBackend: "codex" }];
  });
  const listeners = new Set<(event: AgentEvent) => void>();
  const tasks = new Set<() => void>();
  const replies: Array<() => void> = [];
  let gated = false;
  const read = vi.fn<NonNullable<DesktopApi["getNavigationQueryPage"]>>(async (request) => {
    const page = navigationQueryFixture(request, { directories: directories.map((directory) => ({ ...directory,
      ...(draft?.directoryKey === directory.key ? { launchpad: draft } : {}) })), threads });
    if (request.inventory === "viewer" && ["directory", "directory-index", "exact"].includes(request.query.kind)) {
      const query = request.query;
      const dependencies = query.kind === "directory" ? threads.filter((thread) =>
        thread.linkedDirectories.some((directory) => `directory:${directory.path}` === query.directoryKey)) : threads;
      page.metadataDependencies = { version: 1, prKeys: [],
        threadKeys: dependencies.map((thread) => JSON.stringify([null, thread.source, thread.id])) };
    }
    if (gated) await new Promise<void>((resolve) => replies.push(resolve));
    return page;
  });
  let returnMaterialized: (() => void) | undefined;
  const emit = (event: AgentEvent) => { for (const listener of listeners) listener(event); };
  const api: DesktopApi = { getNavigationQueryPage: read, releaseNavigationQuery: async () => undefined,
    onAgentEvent: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getNavigationSelectedDetail: async ({ ref }) => ({ protocol: 2, ref, revision: "detail", readiness: "ready",
      identity: "present", thread: threads.find((thread) => thread.id === ref.threadId) }),
    ensureDirectoryLaunchpad: async (request) => {
      draft = { ...defaults, directoryKey: request.directoryKey, directoryKind: "directory", directoryLabel: "Project 0",
        directoryPath: "/project-0", workMode: "local", prompt: "Fixture task", createdAt: 1, updatedAt: 1 };
      return { launchpad: draft, defaults };
    },
    getNavigationLaunchpadConfig: async ({ directoryKey }) => ({ protocol: 2, revision: "config", directoryKey, defaults, launchpad: draft }),
    manageLaunchpadCreation: async () => ({}),
    materializeDirectoryLaunchpad: async () => {
      threads = [...threads, { ...threads[0]!, id: "created", title: "Created", pinnedRank: "1", createdAt: 200 }];
      draft = undefined;
      emit({ backend: "codex", notification: { method: "thread/started", params: { threadId: "created" } } });
      await new Promise<void>((resolve) => { returnMaterialized = resolve; });
      return { backend: "codex", threadId: "created", workMode: "local", executionMode: "default" };
    },
  };
  let navigation!: ReturnType<typeof useThreadNavigation>;
  let commits = 0;
  let rowRenders = 0;
  const rows = memoRenderObserver(ThreadRow, "ThreadRow");
  rows.install(() => { rowRenders += 1; });
  const publish = vi.spyOn(NavigationWindowQueries.prototype as unknown as { publish: () => void }, "publish");
  function Window() {
    navigation = useThreadNavigation(api, { scheduleNavigationRefresh: (task) => {
      tasks.add(task); return () => { tasks.delete(task); };
    } });
    return <Profiler id="action-budget" onRender={() => { commits += 1; }}>
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
  const drain = async (settled: () => boolean = () => true) => {
    for (let i = 0; i < 300; i++) {
      await act(async () => {
        const scheduled = [...tasks]; tasks.clear(); scheduled.forEach((task) => task());
        replies.shift()?.();
      });
      if (settled() && idle() && !tasks.size && !replies.length) return;
    }
    throw new Error("Action did not settle within its deterministic response budget");
  };
  const reset = () => { read.mockClear(); publish.mockClear(); commits = 0; rowRenders = 0; gated = true; };
  const budget = (action: string) => {
    const calls = read.mock.calls.map(([request]) => request);
    console.info("navigation action budget", { action, groups, calls: calls.length, publications: publish.mock.calls.length, commits, rowRenders });
    expect(calls.filter((request) => request.query.kind === "children")).toHaveLength(action === "pr-discovery" ? 1 : 0);
    const affectedDirectory = directories[action === "pr-discovery" ? 1 : 0]!.key;
    expect(calls.filter((request) => request.query.kind === "directory" && request.query.directoryKey !== affectedDirectory)).toHaveLength(0);
    const budgets: Record<string, { calls: number; publications: number; commits: number; rowRenders: number }> = {
      create: { calls: 1, publications: 3, commits: 7, rowRenders: 3 },
      select: { calls: 3, publications: 8, commits: 12, rowRenders: 1 },
      "submit-reply": { calls: 2, publications: 5, commits: 8, rowRenders: 5 },
      "pr-discovery": { calls: 5, publications: 11, commits: 12, rowRenders: 0 },
    };
    expect({ calls: calls.length, publications: publish.mock.calls.length, commits, rowRenders }).toEqual(budgets[action]);
  };
  try {
    await waitFor(() => expect(navigation.threads.length).toBeGreaterThan(0));
    await act(async () => {
      navigation.setBrowseMode("directories");
      navigation.directoryDisclosure.setExpandedByKey(Object.fromEntries(directories.map((directory) => [directory.key, true])));
    });
    await drain();
    expect([...navigation.pagedNavigation.resources.values()].filter((resource) => resource.state.request.query.kind === "children")).toHaveLength(groups);

    for (const action of ["create", "select"] as const) {
      reset();
      let done = false;
      await act(async () => {
        if (action === "select") threads = [...threads, { ...threads[0]!, id: "off-page", title: "Off-page" }];
        void (action === "create" ? navigation.createThread("codex")
          : navigation.showThread({ backend: "codex", threadId: "off-page" })).then(() => { done = true; });
      });
      await drain(() => done);
      budget(action);
      if (action === "select") expect(navigation.selectedThread?.id).toBe("off-page");
    }
    reset();
    let discovered = false;
    await act(async () => { void navigation.refreshThreadMetadata(threads.find((thread) => thread.id === "parent-1")!)
      .then(() => { discovered = true; }); });
    await drain(() => discovered);
    // This action does update its parent's child metadata. Unrelated children
    // remain excluded by the owner's complete membership.
    expect(read.mock.calls.filter(([request]) => request.query.kind === "children").map(([request]) => request.query))
      .toEqual([{ kind: "children", parent: { backend: "codex", threadId: "parent-1" }, directoryKey: directories[1]!.key }]);
    budget("pr-discovery");
    await act(async () => { navigation.selectDirectoryLaunchpad(directories[0]!.key); });
    await drain();
    let submitted = false;
    await act(async () => { void navigation.materializeDirectoryLaunchpad(directories[0]!.key, [{ type: "text", text: "Fixture task" }])
      .then(() => { submitted = true; }); });
    await drain(() => Boolean(returnMaterialized));
    // The genuine membership wave has settled before the RPC reply, as in
    // capture 0002. The reply must not repeat every expanded collection.
    reset();
    await act(async () => { returnMaterialized!(); });
    await drain(() => submitted);
    budget("submit-reply");
    expect(navigation.selectedThread?.id).toBe("created");
    expect(navigation.threads.some((thread) => thread.id === "created")).toBe(true);
    expect(read.mock.calls.some(([request]) => request.diagnostic?.trigger === "action/materialize-launchpad")).toBe(true);
  } finally { mounted.unmount(); rows.restore(); replies.splice(0).forEach((reply) => reply()); returnMaterialized?.(); }
}, 15_000);
