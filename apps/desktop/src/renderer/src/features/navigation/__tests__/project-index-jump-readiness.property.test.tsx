import "@testing-library/jest-dom/vitest";
import { act, render } from "@testing-library/react";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import type {
  NavigationDirectoryRow,
  NavigationQueryPage,
  NavigationQueryRequest,
  NavigationRow,
} from "@pwragent/shared/contracts/navigation";
import { Sidebar } from "../Sidebar";
import type { ProjectRevealRequest } from "../DirectoriesList";
import { createNavigationPageState } from "../../../lib/navigation-query-state";
import type { NavigationWindowResource } from "../../../lib/navigation-window-queries";

function directoryRow(index: number): NavigationDirectoryRow {
  const key = `directory:/repo-${index}`;
  return {
    key,
    label: `Repo ${index}`,
    path: `/repo-${index}`,
    kind: "directory",
    counts: { total: 1, pinned: 0, active: 0, unread: 0, review: 0 },
    pinnedRootCount: 0,
    unpinnedRootCount: 1,
    launchpadPresent: false,
  };
}

function threadRow(index: number): NavigationRow {
  const path = `/repo-${index}`;
  return {
    id: `thread-${index}`,
    source: "codex",
    title: `Thread ${index}`,
    titleSource: "explicit",
    ref: { backend: "codex", threadId: `thread-${index}` },
    rowRevision: "r",
    linkedDirectories: [{ id: path, kind: "local", label: `Repo ${index}`, path }],
    inbox: { inInbox: false },
    ordinaryChildCount: 0,
    nativeSubAgentGroupPresent: false,
    queueCount: 0,
    queueState: "unknown",
  };
}

function buildResource(
  id: string,
  query: NavigationQueryRequest["query"],
  options: { page?: Partial<NavigationQueryPage>; loading: boolean; omitPage?: boolean },
): NavigationWindowResource {
  const request: NavigationQueryRequest = {
    protocol: 2,
    consumer: "main-sidebar",
    pageSize: 10,
    query,
  };
  return {
    id,
    loading: options.loading,
    state: {
      ...createNavigationPageState(request),
      ...(options.omitPage ? {} : {
        page: {
          protocol: 2,
          queryKey: id,
          generation: "g",
          ownerEpoch: "owner",
          countsRevision: "r",
          coverage: { state: "complete" },
          counts: { total: 1, pinned: 0, active: 0, unread: 0, review: 0 },
          entries: [],
          directories: [],
          complete: true,
          ...options.page,
        },
      }),
    },
  };
}

async function flushFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  });
}

it("jumps immediately on ProjectIndex clicks even while background directory refreshes or lower directories are loading", async () => {
  await fc.assert(fc.asyncProperty(
    fc.integer({ min: 3, max: 6 }),
    fc.integer({ min: 0, max: 5 }),
    fc.array(fc.boolean(), { minLength: 6, maxLength: 6 }),
    async (count, rawTarget, loadingFlags) => {
      const targetIndex = rawTarget % count;
      const directories = Array.from({ length: count }, (_, index) => directoryRow(index));
      const threads = Array.from({ length: count }, (_, index) => threadRow(index));
      const resources = new Map<string, NavigationWindowResource>([
        [
          "directory-index",
          buildResource("directory-index", { kind: "directory-index" }, {
            loading: false,
            page: { directories },
          }),
        ],
      ]);
      for (let index = 0; index < count; index++) {
        const directory = directories[index]!;
        const thread = threads[index]!;
        const isBelowTarget = index > targetIndex;
        // Every directory at or above the jump target already has a loaded
        // page (even if a background refresh has loading=true). Directories
        // below the target may even be on an initial load without a page.
        const loading = loadingFlags[index] ?? true;
        const omitPage = isBelowTarget && loading;
        resources.set(
          `directory:${directory.key}`,
          buildResource(`directory:${directory.key}`, { kind: "directory", directoryKey: directory.key, roots: "unpinned" }, {
            loading: index === targetIndex ? true : loading,
            omitPage,
            page: {
              entries: [{ row: thread, placement: { kind: "root" }, orderKey: "a" }],
            },
          }),
        );
      }

      const pagedNavigation = {
        resources,
        directories,
        selectedDirectoryKeys: [directories[0]!.key],
        connected: true,
        presentationReady: true,
        invalidate: () => undefined,
        refresh: async () => undefined,
        loadMore: async () => undefined,
        rebaseline: async () => undefined,
        restart: async () => undefined,
        setVisibleAnchor: () => undefined,
      };
      const onComplete = vi.fn();
      const request: ProjectRevealRequest = { key: directories[targetIndex]!.key, jump: true };

      const view = render(
        <Sidebar
          backends={[]}
          browseMode="directories"
          directories={directories}
          loading={false}
          pagedNavigation={pagedNavigation}
          projectRevealRequest={request}
          selectedItemKey={`codex:${threads[0]!.id}`}
          selectedThreadDirectoryKeys={[directories[0]!.key]}
          threads={threads}
          onBrowseModeChange={() => undefined}
          onCreateThread={async () => undefined}
          onOpenLaunchpad={async () => undefined}
          onSelectThread={() => undefined}
          onSetSubthreadsCollapsed={async () => undefined}
          onSetDirectoryThreadsCollapsed={async () => undefined}
        />,
      );
      try {
        await flushFrame();
        const section = view.container.querySelector<HTMLElement>(
          `section.directory-row[data-directory-key="${directories[targetIndex]!.key}"]`,
        );
        expect(section).not.toBeNull();
        const summary = section!.querySelector<HTMLElement>(".directory-row__summary");
        // The jump landed immediately and flashed the target project header
        // instead of blocking on background directory refreshes.
        expect(summary).toHaveClass("is-revealed");
      } finally {
        view.unmount();
        onComplete.mockReset();
      }
    },
  ), { numRuns: 10 });
});

it("logs a renderer diagnostic warning when a project jump is delayed waiting for navigation readiness", async () => {
  const directories = [directoryRow(0), directoryRow(1)];
  const threads = [threadRow(0), threadRow(1)];
  const logRendererDiagnostic = vi.fn(async () => undefined);
  const previousApi = (window as unknown as { pwragent?: unknown }).pwragent;
  (window as unknown as { pwragent?: unknown }).pwragent = { logRendererDiagnostic };
  let now = 10_000;
  const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => now);
  try {
    const makeNavigation = (presentationReady: boolean) => ({
      resources: new Map<string, NavigationWindowResource>([
        ["directory-index", buildResource("directory-index", { kind: "directory-index" }, { loading: false, page: { directories } })],
        ["directory:directory:/repo-0", buildResource("directory:directory:/repo-0", { kind: "directory", directoryKey: directories[0]!.key, roots: "unpinned" }, { loading: !presentationReady, omitPage: !presentationReady })],
        ["directory:directory:/repo-1", buildResource("directory:directory:/repo-1", { kind: "directory", directoryKey: directories[1]!.key, roots: "unpinned" }, { loading: !presentationReady, omitPage: !presentationReady })],
      ]),
      directories,
      selectedDirectoryKeys: [directories[0]!.key],
      connected: true,
      presentationReady,
      invalidate: () => undefined,
      refresh: async () => undefined,
      loadMore: async () => undefined,
      rebaseline: async () => undefined,
      restart: async () => undefined,
      setVisibleAnchor: () => undefined,
    });
    const request: ProjectRevealRequest = { key: directories[1]!.key, jump: true };
    const { rerender, unmount } = render(
      <Sidebar
        backends={[]}
        browseMode="directories"
        directories={directories}
        loading={false}
        pagedNavigation={makeNavigation(false)}
        projectRevealRequest={request}
        selectedItemKey={`codex:${threads[0]!.id}`}
        selectedThreadDirectoryKeys={[directories[0]!.key]}
        threads={threads}
        onBrowseModeChange={() => undefined}
        onCreateThread={async () => undefined}
        onOpenLaunchpad={async () => undefined}
        onSelectThread={() => undefined}
        onSetSubthreadsCollapsed={async () => undefined}
        onSetDirectoryThreadsCollapsed={async () => undefined}
      />,
    );
    try {
      await flushFrame();
      expect(logRendererDiagnostic).not.toHaveBeenCalled();

      // Simulate a 2.5s stall waiting for navigation readiness.
      now += 2_500;
      rerender(
        <Sidebar
          backends={[]}
          browseMode="directories"
          directories={directories}
          loading={false}
          pagedNavigation={makeNavigation(true)}
          projectRevealRequest={request}
          selectedItemKey={`codex:${threads[0]!.id}`}
          selectedThreadDirectoryKeys={[directories[0]!.key]}
          threads={threads}
          onBrowseModeChange={() => undefined}
          onCreateThread={async () => undefined}
          onOpenLaunchpad={async () => undefined}
          onSelectThread={() => undefined}
          onSetSubthreadsCollapsed={async () => undefined}
          onSetDirectoryThreadsCollapsed={async () => undefined}
        />,
      );
      await flushFrame();
      expect(logRendererDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
        level: "warn",
        message: "project index jump delayed",
      }));
    } finally {
      unmount();
    }
  } finally {
    nowSpy.mockRestore();
    (window as unknown as { pwragent?: unknown }).pwragent = previousApi;
  }
});
