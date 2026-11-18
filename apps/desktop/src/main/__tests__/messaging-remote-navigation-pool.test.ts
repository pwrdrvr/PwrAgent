import { expect, it, vi } from "vitest";
import type { NavigationQueryPage, NavigationQueryRequest } from "@pwragent/shared";
import { getDesktopNavigationQueryPool } from "../app-server/navigation-query-pool";
import { DesktopMessagingBackendBridge } from "../messaging/desktop-backend-bridge";

const target = { scope: "remote" as const, instanceId: "pwr_peer" };
const request: NavigationQueryRequest = {
  protocol: 2, consumer: "main-sidebar", inventory: "owner", federationTarget: target, query: { kind: "lens", lens: "recents" },
};
// As a window's read retains it: the owner's rows, and this viewer's facts once.
const windowPage = {
  protocol: 2, queryKey: "q", generation: "g", ownerEpoch: "e", countsRevision: "r", complete: true,
  coverage: { state: "complete" }, counts: { total: 1, active: 0, unread: 0, review: 0 },
  entries: [{ orderKey: "0", placement: { kind: "root" }, row: {
    id: "one", source: "codex", title: "One", titleSource: "explicit", linkedDirectories: [], inbox: { inInbox: false },
    ref: { backend: "codex", threadId: "one" },
  } }],
  remoteOwner: { instanceId: target.instanceId, instanceLabel: "Peer / default", peerStatus: "connected" },
} as unknown as NavigationQueryPage;

it("gives messaging filled rows when it shares a window's read of another owner's page", async () => {
  const pool = getDesktopNavigationQueryPool();
  let finishWindowRead!: (page: NavigationQueryPage) => void;
  const windowRead = pool.read({ consumerId: "window", request,
    load: () => new Promise<NavigationQueryPage>((resolve) => { finishWindowRead = resolve; }) });
  // The same query from messaging joins the window's physical read.
  const remoteNavigationQueryPage = vi.fn(async (): Promise<NavigationQueryPage> => { throw new Error("joined read expected"); });
  const bridge = new DesktopMessagingBackendBridge({} as never, { remoteNavigationQueryPage } as never);
  const messagingRead = bridge.getNavigationQueryPage(request);
  await vi.waitFor(() => expect(finishWindowRead).toBeTypeOf("function"));
  finishWindowRead(windowPage);
  try {
    const [held, page] = await Promise.all([windowRead, messagingRead]);
    expect(remoteNavigationQueryPage).not.toHaveBeenCalled();
    expect(held.entries[0]?.row.federation).toBeUndefined();
    expect(page.entries[0]?.row.ref.ownerInstanceId).toBe(target.instanceId);
    expect(page.entries[0]?.row.federation).toMatchObject({ instanceLabel: "Peer / default", peerStatus: "connected",
      ref: { backend: "codex", threadId: "one", target } });
  } finally { pool.release("window"); }
});
