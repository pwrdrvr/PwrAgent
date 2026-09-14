import { Component, type ReactNode } from "react";
import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildThreadIdentityKey } from "@pwragent/shared";
import type { NavigationDirectorySummary, NavigationThreadSummary } from "@pwragent/shared";
import type { DesktopApi } from "../desktop-api";
import { navigationQueryFixture } from "../../test/navigation-query-fixture";
import { useThreadNavigation } from "../useThreadNavigation";
import { Sidebar } from "../../features/navigation/Sidebar";

/**
 * Enough open directories that the Directories lens demands more collections
 * than React's fifty-nested-update limit, with margin. Each open directory
 * demands a pinned and an unpinned collection, and each page that lands is its
 * own commit: measured against this fixture, 122 demanded collections tripped
 * the limit on every run and 100 never did. Do not lower this below ~60
 * directories without re-measuring — an undersized count passes whether or not
 * the defect is present.
 */
const DIRECTORY_COUNT = 80;
const directoryPaths = Array.from({ length: DIRECTORY_COUNT }, (_, index) => `/dir-${index}`);

const thread = (path: string, ordinal: number): NavigationThreadSummary => ({
  id: `thread-${path}-${ordinal}`, source: "codex", title: `Thread ${path} ${ordinal}`,
  titleSource: "explicit", executionMode: "default", updatedAt: 1_800_000_000_000 - ordinal,
  inbox: { inInbox: false },
  linkedDirectories: [{ id: path, kind: "local", label: path, path }],
});
const threadsByPath = new Map(directoryPaths.map((path) => [path, [thread(path, 1), thread(path, 2)]]));
const population = {
  directories: directoryPaths.map((path): NavigationDirectorySummary => ({
    key: `directory:${path}`, kind: "directory", label: path, path,
    needsAttentionCount: 0, directoryThreadsCollapsed: false,
    threadKeys: threadsByPath.get(path)!.map((member) => buildThreadIdentityKey(member.source, member.id)),
  })),
  threads: [...threadsByPath.values()].flat(),
};

function fixture() {
  const read = vi.fn<NonNullable<DesktopApi["getNavigationQueryPage"]>>(async (request) => {
    // Land each page in its own task, the way an IPC round trip does.
    await new Promise((resolve) => setTimeout(resolve, 1));
    return navigationQueryFixture(request, population);
  });
  const detail = vi.fn<NonNullable<DesktopApi["getNavigationSelectedDetail"]>>(async (request) => ({
    protocol: 2, ref: request.ref, revision: "detail", readiness: "ready", identity: "present",
    thread: population.threads.find((candidate) => candidate.id === request.ref.threadId)
      ?? population.threads[0]!,
  }));
  return { read, api: {
    getNavigationQueryPage: read, getNavigationSelectedDetail: detail,
    getNavigationSnapshot: vi.fn(async () => { throw new Error("Legacy navigation must not run"); }),
    releaseNavigationQuery: vi.fn(async () => undefined), onAgentEvent: () => () => undefined,
  } satisfies DesktopApi };
}

/** Stands in for RendererErrorBoundary, which is what lost the sidebar. */
class Boundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }
  render(): ReactNode {
    return this.state.error ? null : this.props.children;
  }
}

beforeEach(() => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
});
afterEach(() => vi.restoreAllMocks());

it("opens every directory in one lens without exceeding React's update depth", async () => {
  const f = fixture();
  // React reports a boundary error through console.error. Capture every line
  // rather than filtering for one string: a render this size should produce no
  // console.error at all, so anything here is a diagnostic worth failing on.
  const reported: string[] = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { reported.push(String(args[0])); });
  let boundary!: Boundary;
  let navigation!: ReturnType<typeof useThreadNavigation>;
  function Window() {
    navigation = useThreadNavigation(f.api);
    return <Sidebar backends={[]} browseMode={navigation.browseMode} directories={navigation.directories}
      directoryDisclosure={navigation.directoryDisclosure}
      selectedThreadDirectoryKeys={navigation.pagedNavigation.selectedDirectoryKeys}
      threads={navigation.threads} inboxThreads={navigation.inboxThreads}
      pagedNavigation={navigation.pagedNavigation} loading={navigation.loading}
      selectedItemKey={navigation.selectedItemKey} onBrowseModeChange={navigation.setBrowseMode}
      onSelectThread={navigation.selectThread} onCreateThread={async () => undefined}
      onOpenLaunchpad={async () => undefined} />;
  }
  // A renderer that died stops settling, so every wait below takes the boundary
  // as an exit too — otherwise a throw that lands earlier than expected fails
  // as an opaque timeout instead of naming itself.
  const settled = async (ready: () => boolean, timeout?: number): Promise<void> => {
    await waitFor(() => expect(Boolean(boundary.state.error) || ready()).toBe(true), { timeout });
  };
  const mounted = render(<Boundary ref={(instance) => { if (instance) boundary = instance; }}><Window /></Boundary>);
  try {
    await settled(() => navigation.threads.length > 0);
    await act(async () => { navigation.setBrowseMode("directories"); });
    await settled(() => navigation.directories.length === DIRECTORY_COUNT);

    // Opening every directory puts two collection reads per directory in
    // flight, and each page lands in its own commit. Before this was fixed,
    // the selection effect dispatched a no-op disclosure update on every one
    // of those commits, so React stopped the renderer at fifty.
    await act(async () => {
      navigation.directoryDisclosure.setExpandedByKey(
        Object.fromEntries(population.directories.map((directory) => [directory.key, true])),
      );
    });
    await settled(() => navigation.pagedNavigation.resources.size > 2 * DIRECTORY_COUNT);
    await settled(
      () => [...navigation.pagedNavigation.resources.values()].every((resource) => !resource.loading),
      15_000,
    );

    expect(boundary.state.error).toBeUndefined();
    expect(reported).toEqual([]);
  } finally {
    mounted.unmount();
  }
}, 30_000);
