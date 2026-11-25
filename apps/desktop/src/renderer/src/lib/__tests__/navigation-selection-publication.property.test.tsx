import { useLayoutEffect, useRef } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import { Sidebar } from "../../features/navigation/Sidebar";
import { navigationQueryFixture } from "../../test/navigation-query-fixture";
import type { DesktopApi } from "../desktop-api";
import { useThreadNavigation } from "../useThreadNavigation";

// The test owner must stop model admission before RTL tears down its roots.
// Keep the full assertion too: fast-check may still be reporting/shrinking a
// failure after the currently mounted history has retired.
const activeSelections = new Set<Promise<void>>();
function ownSelectionWork(work: Promise<void>): Promise<void> {
  activeSelections.add(work);
  return work;
}
async function retireSelectionModels(): Promise<void> {
  while (activeSelections.size) {
    const work = [...activeSelections];
    // The test already owns each rejection; teardown only joins its lifetime.
    await Promise.allSettled(work);
    for (const admitted of work) activeSelections.delete(admitted);
  }
  cleanup();
}
afterEach(retireSelectionModels);
function stableSelectionHistory(...args: Parameters<typeof runSelectionHistory>): Promise<void> {
  return ownSelectionWork(runSelectionHistory(...args));
}

// Selecting a loaded sibling changes neither membership nor the owner's saved
// order. Independently completed exact metadata batches must preserve both in
// every publication, including the gap while their identity sets turn over.
it("keeps child rows stable through repeated selection and reverse replies on the first page", async ({ signal }) => {
  await stableSelectionHistory(signal, 6, true, [1, 2, 1, 0], true);
});

it("preserves off-page parent ancestry and owner order across the child pagination boundary", async ({ signal }) => {
  await stableSelectionHistory(signal, 11, false, [10, 1, 10, 0], false, false, false, true);
});

it("keeps viewer child demand with split owner directories across reverse exact replies", async ({ signal }) => {
  await stableSelectionHistory(signal, 12, true, [11, 1, 11, 2], false, true, false, false, true);
});

it("keeps native order when owner-directory ancestry stops before the viewer-mounted parent", async ({ signal }) => {
  await stableSelectionHistory(signal, 6, false, [1, 2, 1], false, true);
});

it("keeps a legacy cross-provider parent identity across scoped owner exact reads", async ({ signal }) => {
  await stableSelectionHistory(signal, 6, false, [1, 2, 1], false, false, true);
});

async function runSelectionHistory(signal: AbortSignal, count: number, reverse: boolean, selections: number[], hover: boolean, differentOwnerProjects = false, crossProvider = false, offPage = false, startAtParent = false, afterReady?: (container: HTMLElement) => Promise<void>): Promise<void> {
  signal.throwIfAborted();
  const directory = { key: "directory:/fixture", kind: "directory" as const, path: "/fixture", label: "Project" };
  const thread = (id: string, parent?: string): NavigationThreadSummary => ({ id, source: "codex", title: id,
    titleSource: "explicit", createdAt: 100, updatedAt: 100, inbox: { inInbox: false },
    linkedDirectories: [{ id: directory.key, kind: "local", path: directory.path, label: directory.label }],
    ...(parent ? { parentThreadId: parent, parentThreadBackend: "codex" as const } : {}),
    federation: { ref: { backend: "codex", threadId: id, target: { scope: "remote", instanceId: "peer" } }, instanceLabel: "Peer" },
  });
  const parent = { ...thread("parent"), ...(offPage ? { pinnedRank: "11" } : {}) };
  if (crossProvider) {
    parent.source = "claude";
    parent.federation!.ref.backend = "claude";
  }
  const children = Array.from({ length: count }, (_, i) => ({ ...thread(`child-${i}`, parent.id),
    ...(crossProvider ? { parentThreadBackend: undefined } : {}),
  }));
  const threads = [...(offPage ? Array.from({ length: 10 }, (_, i) => ({ ...thread(`pin-${i}`), pinnedRank: String(i + 1) })) : []), parent, ...children];
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
    const root = useRef<HTMLDivElement>(null);
    navigation = useThreadNavigation(api, { scheduleNavigationRefresh: (task) => {
      tasks.add(task); return () => { tasks.delete(task); };
    } });
    useLayoutEffect(() => {
      if (recording) publications.push([...root.current!.querySelectorAll("[data-thread-key]")]
        .map((row) => row.getAttribute("data-thread-key")!.split(":").at(-1)!)
        .filter((id) => id.startsWith("child-")));
    });
    return <div ref={root}><Sidebar backends={[]} browseMode={navigation.browseMode} directories={navigation.directories}
      directoryDisclosure={navigation.directoryDisclosure} threads={navigation.threads} inboxThreads={navigation.inboxThreads}
      pagedNavigation={navigation.pagedNavigation} loading={navigation.loading} selectedItemKey={navigation.selectedItemKey}
      selectedThreadDirectoryKeys={navigation.pagedNavigation.selectedDirectoryKeys} pagesAwaitingRows={navigation.pagesAwaitingRows}
      onBrowseModeChange={navigation.setBrowseMode} onSelectThread={navigation.selectThread}
      onCreateThread={async () => undefined} onOpenLaunchpad={async () => undefined} /></div>;
  }
  const mounted = render(<Window />);
  const drain = async () => {
    signal.throwIfAborted();
    for (let i = 0; i < 100; i++) {
      await act(async () => {
        const scheduled = [...tasks]; tasks.clear(); scheduled.forEach((task) => task());
        (reverse ? replies.pop() : replies.shift())?.();
      });
      signal.throwIfAborted();
      if ([...navigation.pagedNavigation.resources.values()].every((resource) => !resource.loading) && !replies.length && !tasks.size) return;
    }
    throw new Error("Selection exceeded deterministic response budget");
  };
  try {
    await act(async () => { navigation.setBrowseMode("inbox"); });
    await drain();
    await act(async () => { navigation.selectThread(startAtParent || offPage ? parent : children[0]!); });
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
    if (afterReady) await afterReady(mounted.container);
    signal.throwIfAborted();
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
  } finally { mounted.unmount(); mounted.container.remove(); replies.splice(0).forEach((reply) => reply()); }
}

function selectionGate() {
  let release!: () => void;
  let opened!: () => void;
  let container!: HTMLElement;
  let clicks = 0;
  const ready = new Promise<void>(resolve => { opened = resolve; });
  const hold = new Promise<void>(resolve => { release = resolve; });
  return {
    ready,
    release,
    get container() { return container; },
    get clicks() { return clicks; },
    afterReady: async (root: HTMLElement) => {
      container = root;
      expect(root.querySelectorAll("[data-thread-key]").length).toBeGreaterThanOrEqual(3);
      root.addEventListener("click", () => { clicks++; });
      opened();
      await hold;
    },
  };
}

it("selection owner abort stops clicks after real child readiness", async () => {
  const owner = new AbortController();
  const reason = new Error("retired selection model");
  const gate = selectionGate();
  const work = stableSelectionHistory(owner.signal, 3, false, [1], false, false, false, false, false, gate.afterReady)
    .then(() => undefined, error => error);
  await gate.ready;
  try {
    owner.abort(reason);
    gate.release();
    expect([await work, gate.clicks]).toEqual([reason, 0]);
  } finally {
    gate.release();
    await work;
  }
});

it("selection owner teardown joins the admitted history before DOM cleanup", async () => {
  const gate = selectionGate();
  const work = stableSelectionHistory(new AbortController().signal, 3, false, [1], false, false, false, false, false, gate.afterReady)
    .then(() => undefined, error => error);
  await gate.ready;
  const retiring = retireSelectionModels();
  const alsoRetiring = retireSelectionModels();
  try {
    expect(gate.container.isConnected && Boolean(gate.container.querySelector("[data-thread-key]"))).toBe(true);
  } finally {
    gate.release();
    await work;
    await Promise.all([retiring, alsoRetiring]);
  }
  expect(await work).toBeUndefined();
});

it("selection owner starts no history after abort", async () => {
  const reason = new Error("already retired selection model");
  const opened = vi.fn(async () => undefined);
  const work = stableSelectionHistory(AbortSignal.abort(reason), 3, false, [1], false, false, false, false, false, opened);
  await expect(work).rejects.toBe(reason);
  expect(opened).not.toHaveBeenCalled();
});
