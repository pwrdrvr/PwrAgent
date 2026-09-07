import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { NavigationQueryPage, NavigationRow, NavigationSelectedDetailResponse } from "@pwragent/shared";
import type { DesktopApi } from "../desktop-api";
import { useThreadNavigation } from "../useThreadNavigation";
import { Sidebar } from "../../features/navigation/Sidebar";

const counts = { total: 1000, active: 40, unread: 90, review: 50 };
const row = (id: string): NavigationRow => ({ id, source: "codex", title: id, titleSource: "fallback", ref: { backend: "codex", threadId: id },
  rowRevision: "r", linkedDirectories: [], inbox: { inInbox: true }, ordinaryChildCount: 0,
  nativeSubAgentGroupPresent: false, queueCount: 0, queueState: "unknown" });
function fixture() {
  const read = vi.fn<NonNullable<DesktopApi["getNavigationQueryPage"]>>(async (request): Promise<NavigationQueryPage> => {
    const offset = Number(request.cursor ?? 0);
    const entries = request.query.kind === "lens" ? Array.from({ length: 10 }, (_, i) => row(`thread-${offset + i}`))
      : request.query.kind === "exact" ? request.query.identities.map((ref) => row(ref.threadId)) : [];
    return { protocol: 2, queryKey: JSON.stringify(request.query), generation: "g", ownerEpoch: "owner", countsRevision: "r",
      coverage: { state: "complete" }, counts, entries: entries.map((row) => ({ row, placement: { kind: "root" }, orderKey: row.id })),
      directories: [], complete: request.query.kind !== "lens", nextCursor: request.query.kind === "lens" ? String(offset + 10) : undefined };
  });
  const detail = vi.fn<NonNullable<DesktopApi["getNavigationSelectedDetail"]>>(async (request) => ({
    protocol: 2, ref: request.ref, revision: "detail", readiness: "ready", identity: "present", thread: row(request.ref.threadId),
  }));
  const release = vi.fn(async () => undefined);
  const legacy = vi.fn(async () => { throw new Error("Legacy navigation must not run"); });
  return { read, detail, release, legacy, api: { getNavigationQueryPage: read, getNavigationSelectedDetail: detail,
    getNavigationSnapshot: legacy, releaseNavigationQuery: release, onAgentEvent: () => () => undefined,
  } satisfies DesktopApi };
}
beforeEach(() => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
});
afterEach(() => vi.restoreAllMocks());

it("loads one owner lens page and exact selection, preserving complete counts independently", async () => {
  const f = fixture();
  const { result, unmount } = renderHook(() => useThreadNavigation(f.api));
  await waitFor(() => expect(result.current.selectedThreadConfigurationReady).toBe(true));
  expect(f.legacy).not.toHaveBeenCalled();
  expect(result.current.pagedNavigation.resources.get("lens")?.state.page?.entries).toHaveLength(10);
  expect(result.current.pagedNavigation.resources.get("directory-index")?.state.page?.counts).toEqual(counts);
  expect(f.read.mock.calls.filter(([r]) => r.query.kind === "lens")).toHaveLength(1);
  await act(() => result.current.pagedNavigation.loadMore("lens"));
  expect(result.current.pagedNavigation.resources.get("lens")?.state.page?.entries).toHaveLength(20);
  unmount();
  expect(f.release).toHaveBeenCalled();
});

it("keeps an off-page selection and gates configuration while its exact owner read is pending", async () => {
  const f = fixture();
  let resolve!: (value: NavigationSelectedDetailResponse) => void;
  const pending = new Promise<NavigationSelectedDetailResponse>((done) => { resolve = done; });
  f.detail.mockImplementation(async (request) => request.ref.threadId === "off-page" ? pending : ({
    protocol: 2, ref: request.ref, revision: "detail", readiness: "ready", identity: "present", thread: row(request.ref.threadId),
  }));
  const { result, unmount } = renderHook(() => useThreadNavigation(f.api));
  await waitFor(() => expect(result.current.loaded).toBe(true));
  act(() => result.current.selectThread(row("off-page")));
  await waitFor(() => expect(result.current.selectedItemKey).toBe("codex:off-page"));
  expect(result.current.selectedThreadConfigurationReady).toBe(false);
  await act(async () => resolve({ protocol: 2, ref: { backend: "codex", threadId: "off-page" }, revision: "off-page",
    readiness: "ready", identity: "present", thread: row("off-page") }));
  await waitFor(() => expect(result.current.selectedThreadConfigurationReady).toBe(true));
  act(() => result.current.setBrowseMode("directories"));
  await waitFor(() => expect(result.current.pagedNavigation.resources.has("lens")).toBe(false));
  expect(result.current.selectedItemKey).toBe("codex:off-page");
  expect(result.current.selectedThread?.id).toBe("off-page");
  expect(f.legacy).not.toHaveBeenCalled();
  unmount();
});


it("renders admitted owner rows in the real Sidebar and requests more only after a click", async () => {
  const f = fixture();
  function Window() {
    const navigation = useThreadNavigation(f.api);
    return <Sidebar backends={[]} browseMode={navigation.browseMode} directories={navigation.directories}
      threads={navigation.threads} inboxThreads={navigation.inboxThreads} pagedNavigation={navigation.pagedNavigation}
      loading={navigation.loading} selectedItemKey={navigation.selectedItemKey}
      onBrowseModeChange={navigation.setBrowseMode} onSelectThread={navigation.selectThread}
      onCreateThread={async () => undefined} onOpenLaunchpad={async () => undefined} />;
  }
  const mounted = render(<Window />);
  await screen.findByRole("button", { name: "thread-0" });
  expect(screen.getAllByRole("button", { name: /^thread-\d+$/ })).toHaveLength(10);
  fireEvent.click(screen.getByRole("button", { name: "Load more threads" }));
  await screen.findByRole("button", { name: "thread-19" });
  expect(screen.getAllByRole("button", { name: /^thread-\d+$/ })).toHaveLength(20);
  expect(f.legacy).not.toHaveBeenCalled();
  mounted.unmount();
});
