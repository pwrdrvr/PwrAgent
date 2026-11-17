import { useLayoutEffect } from "react";
import { act, fireEvent, render } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import fc from "fast-check";
import type { AgentEvent, NavigationThreadSummary } from "@pwragent/shared";
import { Sidebar } from "../../features/navigation/Sidebar";
import { navigationQueryFixture } from "../../test/navigation-query-fixture";
import type { DesktopApi } from "../desktop-api";
import { useThreadNavigation } from "../useThreadNavigation";

// Selecting a loaded sibling changes neither membership nor the owner's saved
// order. Independently completed exact metadata batches must preserve both in
// every publication, including the gap while their identity sets turn over.
it.each([6, 12].flatMap((count) => [false, true].map((reverse) => ({ count, reverse }))))(
  "keeps child rows stable through selection with $count siblings, reverse=$reverse", async ({ count, reverse }) => {
    await stableSelectionHistory(count, reverse, [1, 2, 1, 0], reverse);
  },
);

it("keeps owner order through generated selection histories and a fresh owner reorder", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 3, max: 16 }), fc.array(fc.nat(), { minLength: 3, maxLength: 7 }),
    fc.boolean(), fc.boolean(), (count, selections, reverse, hover) => stableSelectionHistory(count, reverse, selections, hover)), { numRuns: 12 });
});

it("keeps native order when owner-directory ancestry stops before the viewer-mounted parent", async () => {
  await stableSelectionHistory(6, false, [1, 2, 1], false, true);
});

it("keeps a legacy cross-provider parent identity across scoped owner exact reads", async () => {
  await stableSelectionHistory(6, false, [1, 2, 1], false, false, true);
});

async function stableSelectionHistory(count: number, reverse: boolean, selections: number[], hover: boolean, differentOwnerProjects = false, crossProvider = false): Promise<void> {
  const directory = { key: "directory:/fixture", kind: "directory" as const, path: "/fixture", label: "Project" };
  const thread = (id: string, parent?: string): NavigationThreadSummary => ({ id, source: "codex", title: id,
    titleSource: "explicit", createdAt: 100, updatedAt: 100, inbox: { inInbox: false },
    linkedDirectories: [{ id: directory.key, kind: "local", path: directory.path, label: directory.label }],
    ...(parent ? { parentThreadId: parent, parentThreadBackend: "codex" as const } : {}),
    federation: { ref: { backend: "codex", threadId: id, target: { scope: "remote", instanceId: "peer" } }, instanceLabel: "Peer" },
  });
  const parent = thread("parent");
  if (crossProvider) {
    parent.source = "claude";
    parent.federation!.ref.backend = "claude";
  }
  const children = Array.from({ length: count }, (_, i) => ({ ...thread(`child-${i}`, parent.id),
    ...(crossProvider ? { parentThreadBackend: undefined } : {}),
  }));
  const threads = [parent, ...children];
  let viewerThreads = threads;
  // Native owner projects need not match this viewer mount. In particular,
  // the selected child's owner-directory ancestry can stop before its true
  // parent while its native sibling position is still available.
  const ownerDirectories = ["parent", "children"].map((name) => ({ key: `directory:/owner-${name}`,
    kind: "directory" as const, path: `/owner-${name}`, label: `Owner ${name}` }));
  const ownerThreads: NavigationThreadSummary[] = differentOwnerProjects ? threads.map((candidate) => ({ ...candidate,
    linkedDirectories: [{ id: ownerDirectories[candidate.parentThreadId ? 1 : 0]!.key, kind: "local" as const,
      path: ownerDirectories[candidate.parentThreadId ? 1 : 0]!.path,
      label: ownerDirectories[candidate.parentThreadId ? 1 : 0]!.label }],
  })) : threads;
  const listeners = new Set<(event: AgentEvent) => void>();
  const tasks = new Set<() => void>();
  // A mounted subset's viewer page can differ from the native owner's order.
  let expected = children.map((child) => child.id).reverse();
  const replies: Array<() => void> = [];
  let gated = false;
  let recording = false;
  const publications: string[][] = [];
  const read = vi.fn<NonNullable<DesktopApi["getNavigationQueryPage"]>>(async (request) => {
    const remote = request.federationTarget?.scope === "remote";
    const page = navigationQueryFixture(request, { directories: remote && differentOwnerProjects ? ownerDirectories : [directory],
      threads: remote ? ownerThreads : viewerThreads });
    if (request.inventory === "owner" && request.query.kind === "exact") {
      page.entries = page.entries.map((entry) => entry.row.parentThreadId
        ? { ...entry, siblingOrder: expected.indexOf(entry.row.id) } : entry);
      if (gated) await new Promise<void>((resolve) => replies.push(resolve));
    }
    return page;
  });
  const release = vi.fn(async () => undefined);
  const readDetail = vi.fn<NonNullable<DesktopApi["getNavigationSelectedDetail"]>>(async ({ ref }) => ({
    protocol: 2, ref, revision: "detail", readiness: "ready", identity: "present",
    thread: threads.find((candidate) => candidate.id === ref.threadId),
  }));
  const api: DesktopApi = { getNavigationQueryPage: read, releaseNavigationQuery: release,
    onAgentEvent: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getNavigationSelectedDetail: readDetail,
  };
  let navigation!: ReturnType<typeof useThreadNavigation>;
  function Window() {
    navigation = useThreadNavigation(api, { scheduleNavigationRefresh: (task) => {
      tasks.add(task); return () => { tasks.delete(task); };
    } });
    useLayoutEffect(() => {
      if (recording) publications.push([...document.querySelectorAll("[data-thread-key]")]
        .map((row) => row.getAttribute("data-thread-key")!.split(":").at(-1)!)
        .filter((id) => id.startsWith("child-")));
    });
    return <Sidebar backends={[]} browseMode={navigation.browseMode} directories={navigation.directories}
      directoryDisclosure={navigation.directoryDisclosure} threads={navigation.threads} inboxThreads={navigation.inboxThreads}
      pagedNavigation={navigation.pagedNavigation} loading={navigation.loading} selectedItemKey={navigation.selectedItemKey}
      selectedThreadDirectoryKeys={navigation.pagedNavigation.selectedDirectoryKeys} pagesAwaitingRows={navigation.pagesAwaitingRows}
      onBrowseModeChange={navigation.setBrowseMode} onSelectThread={navigation.selectThread}
      onCreateThread={async () => undefined} onOpenLaunchpad={async () => undefined} />;
  }
  const mounted = render(<Window />);
  const drain = async () => {
    for (let i = 0; i < 100; i++) {
      await act(async () => {
        const scheduled = [...tasks]; tasks.clear(); scheduled.forEach((task) => task());
        (reverse ? replies.pop() : replies.shift())?.();
      });
      if ([...navigation.pagedNavigation.resources.values()].every((resource) => !resource.loading) && !replies.length && !tasks.size) return;
    }
    throw new Error("Selection exceeded deterministic response budget");
  };
  try {
    await act(async () => { navigation.setBrowseMode("inbox"); });
    await drain();
    await act(async () => { navigation.selectThread(children[0]!); });
    await drain();
    await act(async () => {
      navigation.setBrowseMode("directories");
      navigation.directoryDisclosure.setExpandedByKey({ [directory.key]: true });
    });
    await drain();
    const childResource = [...navigation.pagedNavigation.resources.values()].find((resource) => resource.state.request.query.kind === "children")!;
    if (count > 10) await act(async () => { await navigation.pagedNavigation.loadMore(childResource.id); });
    await drain();

    const visible = () => [...mounted.container.querySelectorAll("[data-thread-key]")]
      .map((row) => row.getAttribute("data-thread-key")!.split(":").at(-1)!).filter((id) => id.startsWith("child-"));
    expect(visible()).toEqual(expected);
    gated = true;
    const list = mounted.container.querySelector<HTMLElement>(".directory-list")!;
    list.scrollTop = 120;
    let selected = navigation.selectedThread?.id;
    for (const [step, choice] of [...selections, 1, 2, 1].entries()) {
      if (step === selections.length) {
        // A legitimate owner reorder must still publish and become the next
        // stable baseline, even when row revisions and timestamps are equal.
        expected = [...expected.slice(1), expected[0]!];
        recording = false;
        read.mockClear();
        await act(async () => { void navigation.pagedNavigation.refresh([{ scope: "remote", instanceId: "peer" }]); });
        await drain();
        expect(read).toHaveBeenCalledTimes(2);
        expect(visible()).toEqual(expected);
      }
      publications.length = 0;
      recording = true;
      read.mockClear();
      readDetail.mockClear();
      release.mockClear();
      const id = `child-${choice % count}`;
      const row = mounted.container.querySelector(`[data-thread-key="remote:peer:codex:${id}"]`)!;
      const nodes = [...mounted.container.querySelectorAll("[data-thread-key]")];
      if (hover) fireEvent.pointerOver(row, { pointerType: "mouse" });
      fireEvent.scroll(list);
      fireEvent.click(row.querySelector(".thread-row__open")!);
      // Moving off the row exposes the live snapshot during the in-flight
      // replacement; hover freezing must not conceal an underlying jump.
      if (hover) fireEvent.pointerOut(row, { relatedTarget: list });
      await drain();
      expect(navigation.selectedThread?.id).toBe(id);
      for (const publication of publications) expect(publication).toEqual(expected);
      expect(visible()).toEqual(expected);
      [...mounted.container.querySelectorAll("[data-thread-key]")].forEach((node, i) => expect(node).toBe(nodes[i]));
      expect(list.scrollTop).toBe(120);
      expect(read).toHaveBeenCalledTimes(id === selected ? 0 : 3);
      expect(readDetail).toHaveBeenCalledTimes(id === selected ? 0 : 1);
      expect(release).toHaveBeenCalledTimes(id === selected ? 0 : 4);
      selected = id;
      expect(read.mock.calls.filter(([request]) => request.query.kind === "children" || request.query.kind === "directory")).toHaveLength(0);
      expect(navigation.pagedNavigation.resources.get(childResource.id)?.state.page?.entries).toHaveLength(count);
    }
    // Removing a nonselected viewer mount must remove only that row, once.
    // Its owner's population and selected sibling remain unchanged.
    publications.length = 0;
    read.mockClear();
    viewerThreads = viewerThreads.filter((candidate) => candidate.id !== "child-0");
    await act(async () => {
      const event: AgentEvent = { backend: "codex", notification: { method: "navigation/remoteThreadPins/changed",
        params: { instanceId: "peer", threadId: "child-0", pinned: false } } };
      for (const listener of listeners) listener(event);
    });
    await drain();
    const survivors = expected.filter((id) => id !== "child-0");
    for (const publication of publications) expect(publication.filter((id) => id !== "child-0")).toEqual(survivors);
    const membership = publications.map((publication) => publication.includes("child-0"));
    expect(membership.filter((present, i) => i === 0 || present !== membership[i - 1])).toEqual([true, false]);
    expect(visible()).toEqual(survivors);
    expect(navigation.selectedThread?.id).toBe("child-1");
    expect(navigation.pagedNavigation.resources.get(childResource.id)?.state.page?.entries).toHaveLength(count - 1);
    expect(read).toHaveBeenCalledTimes(count > 11 ? 7 : 6);
  } finally { mounted.unmount(); replies.splice(0).forEach((reply) => reply()); }
}
