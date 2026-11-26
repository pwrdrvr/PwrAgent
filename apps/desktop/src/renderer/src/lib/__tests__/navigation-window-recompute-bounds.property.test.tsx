import { act, renderHook, waitFor } from "@testing-library/react";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import type {
  NavigationDirectorySummary,
  NavigationQueryPage,
  NavigationQueryRequest,
  NavigationSelectedDetailResponse,
  NavigationThreadSummary,
} from "@pwragent/shared/contracts/navigation";
import type { DesktopApi } from "../desktop-api";
import {
  NavigationWindowQueries,
  prepareNavigationDemand,
} from "../navigation-window-queries";
import { useNavigationSelectedDetail } from "../useNavigationSelectedDetail";
import {
  indexLoadedDirectoryRows,
  indexLoadedThreadRows,
  type NavigationLoadedRows,
} from "../navigation-loaded-rows";
import { reconcileLoadedNavigationRows } from "../useThreadNavigation";

function directoryRequest(key: string): NavigationQueryRequest {
  return {
    protocol: 2,
    inventory: "owner",
    consumer: "main-sidebar",
    query: { kind: "directory", directoryKey: key, roots: "unpinned" },
    pageSize: 50,
  };
}

describe("navigation window and detail recompute bounds", () => {
  it("batches subscriber notifications in setPreparedDemand and setVisible(true)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 12 }), (resourceCount) => {
        const api: Pick<DesktopApi, "getNavigationQueryPage" | "releaseNavigationQuery"> = {
          getNavigationQueryPage: vi.fn(() => new Promise<NavigationQueryPage>(() => {})),
          releaseNavigationQuery: vi.fn(async () => undefined),
        };
        const controller = new NavigationWindowQueries(api, { view: 1, effect: 1 });
        let notifications = 0;
        const unsubscribe = controller.subscribe(() => {
          notifications += 1;
        });
        try {
          controller.setVisible(true);
          notifications = 0;

          const requests = new Map<string, NavigationQueryRequest>();
          for (let i = 0; i < resourceCount; i += 1) {
            requests.set(`directory:dir-${i}`, directoryRequest(`dir-${i}`));
          }
          controller.setPreparedDemand(prepareNavigationDemand(requests));
          // One batched publish for all N added resources, not N + 1.
          expect(notifications).toBe(1);

          controller.setVisible(false);
          notifications = 0;
          controller.setVisible(true);
          // One batched publish on visibility restore, not N + 1.
          expect(notifications).toBe(1);
        } finally {
          unsubscribe();
          controller.dispose();
        }
      }),
      { numRuns: 5, examples: [[1], [8]] },
    );
  });

  it("preserves unchanged NavigationDirectorySummary object identities in reconcileLoadedNavigationRows", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 10 }),
        fc.nat(),
        (dirCount, threadPick) => {
          const directories: NavigationDirectorySummary[] = Array.from({ length: dirCount }, (_, i) => ({
            key: `dir-${i}`,
            label: `Project ${i}`,
            path: `/repo/p${i}`,
            kind: "directory",
            counts: { total: 1, active: 0, review: 0 },
          } as unknown as NavigationDirectorySummary));
          const threads: NavigationThreadSummary[] = Array.from({ length: dirCount }, (_, i) => ({
            id: `t-${i}`,
            source: "codex",
            title: `Thread ${i}`,
            titleSource: "explicit",
            updatedAt: 1_000 + i,
            createdAt: 1_000 + i,
            linkedDirectories: [{ id: `d-${i}`, kind: "local", label: `Project ${i}`, path: `/repo/p${i}` }],
            inbox: { inInbox: false },
          } as unknown as NavigationThreadSummary));

          const previous: NavigationLoadedRows = {
            directoryRows: indexLoadedDirectoryRows(directories),
            threadRows: indexLoadedThreadRows(threads),
          };
          const changedIdx = threadPick % dirCount;
          const nextThreads = threads.map((t, i) =>
            i === changedIdx ? { ...t, title: `${t.title} updated` } : { ...t },
          );
          const nextDirs = directories.map((d) => ({ ...d }));
          const next: NavigationLoadedRows = {
            directoryRows: indexLoadedDirectoryRows(nextDirs),
            threadRows: indexLoadedThreadRows(nextThreads),
          };

          const reconciled = reconcileLoadedNavigationRows(previous, next);
          expect(reconciled).not.toBe(previous);
          for (const dir of directories) {
            expect(reconciled.directoryRows.get(dir.key)).toBe(previous.directoryRows.get(dir.key));
          }
          const changedKey = `codex:t-${changedIdx}`;
          expect(reconciled.threadRows.get(changedKey)).not.toBe(previous.threadRows.get(changedKey));
        },
      ),
      { numRuns: 5, examples: [[2, 0], [6, 3]] },
    );
  });

  it("does not emit collectionReadiness loading/ready commits when all collections are already cached", async () => {
    const ref = { backend: "codex" as const, threadId: "cached-detail" };
    const manifest = [{ name: "subAgents" as const, count: 1, revision: "rev-1" }];
    const baseDetail = (revision: string): NavigationSelectedDetailResponse => ({
      protocol: 2,
      ref,
      revision,
      readiness: "ready",
      identity: "present",
      collections: manifest,
      thread: {
        source: "codex",
        id: ref.threadId,
        title: "Cached detail",
        titleSource: "explicit",
        linkedDirectories: [],
        inbox: { inInbox: false },
        threadStatus: "idle",
      },
    });
    const read = vi
      .fn<NonNullable<DesktopApi["getNavigationSelectedDetail"]>>()
      .mockResolvedValueOnce(baseDetail("r1"))
      .mockResolvedValueOnce({
        protocol: 2,
        ref,
        revision: "rev-1",
        readiness: "ready",
        identity: "present",
        collectionPage: {
          name: "subAgents",
          revision: "rev-1",
          complete: true,
          values: {
            subAgents: [
              { monitorId: "m1", task: "Done", status: "success", createdAt: 1, updatedAt: 1 },
            ],
          },
        },
      })
      .mockResolvedValueOnce(baseDetail("r2"));
    const api: DesktopApi = {
      getNavigationSelectedDetail: read,
      releaseNavigationQuery: vi.fn(async () => undefined),
    };

    const observedReadiness: Array<string | undefined> = [];
    const { result, unmount } = renderHook(() => {
      const hook = useNavigationSelectedDetail({ desktopApi: api, ref });
      observedReadiness.push(hook.state?.collectionReadiness);
      return hook;
    });
    try {
      await waitFor(() => expect(result.current.state?.collectionReadiness).toBe("ready"));
      observedReadiness.length = 0;

      // Refresh with a new detail revision whose collection revision is unchanged.
      await act(async () => {
        await result.current.refresh();
      });
      await waitFor(() => expect(result.current.state?.detail?.revision).toBe("r2"));
      // Must never flash collectionReadiness back to "loading" when cached.
      expect(observedReadiness).not.toContain("loading");
      expect(read).toHaveBeenCalledTimes(3);
    } finally {
      unmount();
    }
  });
});
