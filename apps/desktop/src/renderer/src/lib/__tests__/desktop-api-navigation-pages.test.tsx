import { afterEach, expect, it, vi } from "vitest";
import type { NavigationQueryPage, NavigationQueryRequest } from "@pwragent/shared/contracts/navigation";
import { getDesktopApi, type DesktopApi } from "../desktop-api";

const request: NavigationQueryRequest = { protocol: 2, consumer: "main-sidebar", query: { kind: "lens", lens: "inbox" } };
const page = {
  protocol: 2, queryKey: "q", generation: "g", ownerEpoch: "e", countsRevision: "r", complete: true,
  coverage: { state: "complete" }, counts: { total: 1, active: 0, unread: 0, review: 0 },
  entries: [{ orderKey: "0", placement: { kind: "root" },
    row: { id: "one", source: "codex", title: "One", ref: { backend: "codex", threadId: "one" } } }],
  remoteOwner: { instanceId: "peer", instanceLabel: "Peer / default", peerStatus: "connected" },
} as unknown as NavigationQueryPage;

function expose(api: Partial<DesktopApi>): void {
  (window as Window & { pwragent?: unknown }).pwragent = api;
}

afterEach(() => { delete (window as Window & { pwragent?: unknown }).pwragent; });

it("fills rows in on the API object the preload exposes, which is frozen", async () => {
  // Electron's contextBridge freezes what it exposes. A wrapper must not
  // need to redefine a member of that object or answer differently for one.
  const read = vi.fn(async () => page);
  const platform = "darwin";
  expose(Object.freeze({ getNavigationQueryPage: read, platform }) as Partial<DesktopApi>);
  const api = getDesktopApi()!;
  expect(api.platform).toBe(platform);
  const filled = await api.getNavigationQueryPage!(request);
  expect(read).toHaveBeenCalledExactlyOnceWith(request);
  expect(filled.entries[0]?.row.federation).toMatchObject({ instanceLabel: "Peer / default", peerStatus: "connected" });
  expect(filled.entries[0]?.row.ref.ownerInstanceId).toBe("peer");
  // `federation-desktop-api.ts` spreads this object: every member must be copied.
  const spread = { ...api };
  expect(spread.platform).toBe(platform);
  expect((await spread.getNavigationQueryPage!(request)).entries[0]?.row.federation?.instanceLabel).toBe("Peer / default");
  expect("getNavigationQueryPage" in api).toBe(true);
});

it("returns one object and one read per underlying API, and sees members replaced later", async () => {
  const underlying: Partial<DesktopApi> = { getNavigationQueryPage: vi.fn(async () => page) };
  expose(underlying);
  const api = getDesktopApi()!;
  expect(getDesktopApi()).toBe(api);
  expect(api.getNavigationQueryPage).toBe(api.getNavigationQueryPage);
  const later = vi.fn(async () => ({ ...page, remoteOwner: { ...page.remoteOwner!, instanceLabel: "Renamed" } }));
  underlying.getNavigationQueryPage = later;
  expect((await getDesktopApi()!.getNavigationQueryPage!(request)).entries[0]?.row.federation?.instanceLabel).toBe("Renamed");
  expect(later).toHaveBeenCalledOnce();
});

it("lets a spy on the view replace the underlying read", async () => {
  const underlying: Partial<DesktopApi> = { getNavigationQueryPage: vi.fn(async () => page) };
  expose(underlying);
  const api = getDesktopApi()!;
  const spy = vi.spyOn(api, "getNavigationQueryPage").mockImplementation(async () => ({ ...page, entries: [] }));
  expect((await getDesktopApi()!.getNavigationQueryPage!(request)).entries).toEqual([]);
  expect(spy).toHaveBeenCalledOnce();
});
