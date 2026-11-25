import "@testing-library/jest-dom/vitest";
import { act, render, waitFor } from "@testing-library/react";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import type { NavigationQueryPage } from "@pwragent/shared/contracts/navigation";
import type { DesktopApi } from "../../../lib/desktop-api";
import { useBoundedNavigationWindow } from "../../../lib/useBoundedNavigationWindow";
import { useNavigationDirectoryDisclosure } from "../../../lib/useNavigationDirectoryDisclosure";
import { navigationQueryFixture } from "../../../test/navigation-query-fixture";
import type { ProjectRevealRequest } from "../DirectoriesList";
import { Sidebar } from "../Sidebar";

async function flushFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  });
}

async function checkJump(count: number, target: number, blocker: number, roots: "pinned" | "unpinned", delay = 0) {
  const directories = Array.from({ length: count }, (_, index) => ({
    key: `directory:/repo-${index}`,
    label: `Repo ${index}`,
    path: `/repo-${index}`,
    kind: "directory" as const,
  }));
  const threads = directories.map((directory, index) => ({
    id: `thread-${index}`,
    source: "codex" as const,
    title: `Thread ${index}`,
    titleSource: "explicit" as const,
    linkedDirectories: [{ id: directory.path, kind: "local" as const, label: directory.label, path: directory.path }],
    inbox: { inInbox: false },
  }));
  const targetKey = directories[target]!.key;
  const blockerKey = directories[blocker]!.key;
  const belowKey = directories[target + 1]!.key;
  const resourcePrefix = roots === "pinned" ? "directory-pins:" : "directory:";
  const blockerId = `${resourcePrefix}${blockerKey}`;
  const belowId = `directory:${belowKey}`;
  const refreshId = roots === "pinned" ? `directory:${targetKey}` : `directory-pins:${targetKey}`;
  let releaseBlocker!: () => void;
  const blockerPending = new Promise<void>((resolve) => { releaseBlocker = resolve; });
  const desktopApi: DesktopApi = {
    getNavigationQueryPage: async (request) => {
      const query = request.query;
      if (query.kind === "directory") {
        if (query.directoryKey === blockerKey && query.roots === roots) await blockerPending;
        if (request.anchor || (query.directoryKey === belowKey && query.roots === "unpinned")) {
          return new Promise<NavigationQueryPage>(() => undefined);
        }
      }
      return navigationQueryFixture(request, { directories, threads });
    },
  };
  let navigation!: ReturnType<typeof useBoundedNavigationWindow>;
  function Window({ projectRevealRequest }: { projectRevealRequest?: ProjectRevealRequest }) {
    const directoryDisclosure = useNavigationDirectoryDisclosure({
      // The jump itself opens a closed target. All other directories
      // already have demand, including one below the target.
      version: 1, selection: null, unpinnedExpandedByKey: {}, loadedRowsByQuery: {},
      expandedByKey: Object.fromEntries(directories.map(({ key }) => [key, key !== targetKey])),
    });
    navigation = useBoundedNavigationWindow({
      desktopApi, browseMode: "directories", enabled: true, visible: true,
      attentionView: { id: "window", promoteOnTurnEnd: true },
      expandedByKey: directoryDisclosure.expandedByKey,
      unpinnedExpandedByKey: directoryDisclosure.unpinnedExpandedByKey,
    });
    return <Sidebar
      backends={[]}
      browseMode="directories"
      directories={navigation.directories}
      directoryDisclosure={directoryDisclosure}
      loading={false}
      pagedNavigation={navigation}
      projectRevealRequest={projectRevealRequest}
      threads={threads}
      onBrowseModeChange={() => undefined}
      onCreateThread={async () => undefined}
      onOpenLaunchpad={async () => undefined}
      onSelectThread={() => undefined}
      onSetSubthreadsCollapsed={async () => undefined}
      onSetDirectoryThreadsCollapsed={async () => undefined}
    />;
  }
  const logRendererDiagnostic = vi.fn(async () => undefined);
  const bridge = window as Window & { pwragent?: DesktopApi };
  const previousApi = bridge.pwragent;
  let now = 10_000;
  const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => now);
  bridge.pwragent = { logRendererDiagnostic };
  const view = render(<Window />);
  try {
    await waitFor(() => expect(navigation.resources.get(belowId)?.loading).toBe(true));
    const summary = view.container.querySelector(
      `section.directory-row[data-directory-key="${targetKey}"] .directory-row__summary`,
    );
    expect(summary).not.toBeNull();
    view.rerender(<Window projectRevealRequest={{ key: targetKey, jump: true }} />);
    await waitFor(() => expect(navigation.resources.get(blockerId)?.loading).toBe(true));
    await waitFor(() => expect(navigation.resources.get(refreshId)?.state.page).toBeDefined());
    act(() => { void navigation.rebaseline(refreshId, { kind: "directory", key: targetKey }); });
    await waitFor(() => expect(navigation.resources.get(refreshId)?.loading).toBe(true));
    await flushFrame();
    // The jump waits until first pages that can affect landing have arrived.
    expect(summary).not.toHaveClass("is-revealed");
    now += delay;
    await act(async () => releaseBlocker());
    await flushFrame();
    // The lower first page still holds the whole lens open, but cannot move the target.
    expect(navigation.resources.get(belowId)?.state.page).toBeUndefined();
    expect(navigation.resources.get(refreshId)?.loading).toBe(true);
    expect(navigation.presentationReady).toBe(false);
    expect(summary).toHaveClass("is-revealed");
    return logRendererDiagnostic;
  } finally {
    view.unmount();
    nowSpy.mockRestore();
    bridge.pwragent = previousApi;
  }
}

it("lands on the target when its first page arrives even if a lower project is still loading", async () => {
  await checkJump(2, 0, 0, "unpinned");
});

it("waits only for first project pages that affect the jump", async () => {
  await fc.assert(fc.asyncProperty(
    fc.integer({ min: 2, max: 6 }).chain((count) =>
      fc.integer({ min: 0, max: count - 2 }).chain((target) =>
        fc.record({ count: fc.constant(count), target: fc.constant(target),
          blocker: fc.integer({ min: 0, max: target }),
          roots: fc.constantFrom("pinned" as const, "unpinned" as const) }))),
    async ({ count, target, blocker, roots }) => {
      await checkJump(count, target, blocker, roots);
    },
  ), { numRuns: 10 });
});

it("logs the relevant project pages as the cause of a delayed jump", async () => {
  const log = await checkJump(3, 1, 0, "pinned", 2_500);
  expect(log).toHaveBeenCalledWith(expect.objectContaining({
    level: "warn",
    message: "project index jump delayed",
    details: expect.objectContaining({ elapsedMs: 2_500, waitedForPages: true }),
  }));
});
