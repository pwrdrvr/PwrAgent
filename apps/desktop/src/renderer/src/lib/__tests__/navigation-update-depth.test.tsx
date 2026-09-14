import { Component, type ReactNode } from "react";
import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  NavigationDirectoryRow, NavigationQueryEntry, NavigationQueryPage, NavigationRow,
} from "@pwragent/shared";
import type { DesktopApi } from "../desktop-api";
import { useThreadNavigation } from "../useThreadNavigation";
import { Sidebar } from "../../features/navigation/Sidebar";

// Enough directories that the Directories lens demands more collections than
// React's fifty-nested-update limit. Each open directory demands a pinned and
// an unpinned collection, and each page that lands is its own commit.
const DIRECTORY_COUNT = 80;
const directoryKeys = Array.from({ length: DIRECTORY_COUNT }, (_, index) => `/dir-${index}`);
const counts = { total: 10, active: 1, unread: 1, review: 0 };

const row = (id: string, directoryKey: string): NavigationRow => ({
  id, source: "codex", title: id, titleSource: "fallback", ref: { backend: "codex", threadId: id },
  rowRevision: "r", inbox: { inInbox: true }, ordinaryChildCount: 0, subthreadsCollapsed: false,
  nativeSubAgentGroupPresent: false, queueCount: 0, queueState: "unknown",
  linkedDirectories: [{ key: directoryKey, kind: "directory", label: directoryKey, path: directoryKey } as never],
});
const directory = (key: string): NavigationDirectoryRow => ({
  key, kind: "directory", label: key, path: key, counts,
  pinnedRootCount: 0, unpinnedRootCount: 2, launchpadPresent: false,
});
const rootEntry = (value: NavigationRow): NavigationQueryEntry =>
  ({ row: value, placement: { kind: "root" }, orderKey: value.id });

function fixture() {
  const read = vi.fn<NonNullable<DesktopApi["getNavigationQueryPage"]>>(async (request): Promise<NavigationQueryPage> => {
    const query = request.query;
    let entries: NavigationQueryEntry[] = [];
    let directories: NavigationDirectoryRow[] | undefined;
    let selectionDirectory: NavigationDirectoryRow | undefined;
    if (query.kind === "directory-index") directories = (query.keys ?? directoryKeys).map(directory);
    else if (query.kind === "directory") {
      entries = query.roots === "pinned" ? [] : [
        rootEntry(row(`thread-${query.directoryKey}-1`, query.directoryKey)),
        rootEntry(row(`thread-${query.directoryKey}-2`, query.directoryKey)),
      ];
    } else if (query.kind === "exact") {
      entries = query.identities.map((ref) => rootEntry(row(ref.threadId, directoryKeys[0]!)));
      selectionDirectory = directory(directoryKeys[0]!);
    } else if (query.kind === "lens") {
      entries = directoryKeys.map((key) => rootEntry(row(`thread-${key}-1`, key)));
    }
    // Land each page in its own task, the way an IPC round trip does.
    await new Promise((resolve) => setTimeout(resolve, 1));
    return {
      protocol: 2, queryKey: JSON.stringify(query), generation: "g", ownerEpoch: "owner",
      countsRevision: "r", coverage: { state: "complete" }, counts, entries, complete: true,
      ...(directories ? { directories } : {}), ...(selectionDirectory ? { selectionDirectory } : {}),
    };
  });
  const detail = vi.fn<NonNullable<DesktopApi["getNavigationSelectedDetail"]>>(async (request) => ({
    protocol: 2, ref: request.ref, revision: "detail", readiness: "ready", identity: "present",
    thread: row(request.ref.threadId, directoryKeys[0]!),
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
  // React reports a caught boundary error through console.error.
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
  const mounted = render(<Boundary ref={(instance) => { if (instance) boundary = instance; }}><Window /></Boundary>);
  try {
    await waitFor(() => expect(navigation.threads.length).toBeGreaterThan(0));
    await act(async () => { navigation.setBrowseMode("directories"); });
    await waitFor(() => expect(navigation.directories.length).toBe(DIRECTORY_COUNT));

    // Opening every directory puts two collection reads per directory in
    // flight, and each page lands in its own commit. Before this was fixed,
    // the selection effect dispatched a no-op disclosure update on every one
    // of those commits, so React stopped the renderer at fifty.
    await act(async () => {
      navigation.directoryDisclosure.setExpandedByKey(
        Object.fromEntries(directoryKeys.map((key) => [key, true])),
      );
    });
    await waitFor(
      () => expect(navigation.pagedNavigation.resources.size).toBeGreaterThan(2 * DIRECTORY_COUNT),
    );
    // A renderer that died stops settling, so stop waiting on either outcome
    // and let the assertion below name the failure.
    await waitFor(() => expect(Boolean(boundary.state.error)
      || [...navigation.pagedNavigation.resources.values()].every((resource) => !resource.loading)).toBe(true),
      { timeout: 15_000 });

    expect(boundary.state.error).toBeUndefined();
    expect(reported.filter((entry) => entry.includes("Maximum update depth exceeded"))).toEqual([]);
  } finally {
    mounted.unmount();
  }
}, 30_000);
