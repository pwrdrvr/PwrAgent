import { describe, expect, it, vi } from "vitest";
import type { NavigationQueryRequest, NavigationThreadSummary } from "@pwragent/shared";
import { navigationQueryFixture } from "../../test/navigation-query-fixture";
import { readNavigationArchiveGroup } from "../navigation-archive-group";

function thread(id: string, parent?: string): NavigationThreadSummary {
  return { id, source: "codex", title: id, titleSource: "explicit", linkedDirectories: [], inbox: { inInbox: false },
    ...(parent ? { parentThreadId: parent, parentThreadBackend: "codex" } : {}) };
}

describe("owner-revalidated archive group planning", () => {
  it("pages every unloaded child and retains only identities and expected parent relationships", async () => {
    const root = thread("root");
    const threads = [root, ...Array.from({ length: 121 }, (_, index) => ({ ...thread(`child-${index}`, "root"), summary: "private provider text" }))];
    const getNavigationQueryPage = vi.fn(async (request: NavigationQueryRequest) => navigationQueryFixture(request, { threads }));
    const releaseNavigationQuery = vi.fn(async () => undefined);
    const members = await readNavigationArchiveGroup({ api: { getNavigationQueryPage, releaseNavigationQuery }, thread: root });
    expect(members).toHaveLength(122);
    expect(members.at(-1)?.id).toBe("root");
    expect(members[0]?.expectedParent).toEqual({ threadId: "root", backend: "codex", instanceId: undefined });
    expect(JSON.stringify(members)).not.toContain("private provider text");
    expect(JSON.stringify(members)).not.toContain("inbox");
    expect(getNavigationQueryPage.mock.calls.some(([request]) => request.cursor !== undefined)).toBe(true);
    expect(getNavigationQueryPage.mock.calls.every(([request]) => request.pageSize === 10 && request.deadlineAt)).toBe(true);
    expect(releaseNavigationQuery).toHaveBeenCalledTimes(1);
  });

  it("discovers a cross-owner child through viewer metadata but uses its owner's current parent", async () => {
    const root = thread("root");
    const remote = { ...thread("child", "root"), parentThreadInstanceId: "local-id",
      federation: { instanceLabel: "Peer", capabilities: ["turn_control" as const], ref: { backend: "codex" as const, threadId: "child",
        target: { scope: "remote" as const, instanceId: "peer" } } } };
    const getNavigationQueryPage = vi.fn(async (request: NavigationQueryRequest) => navigationQueryFixture(request, {
      threads: request.inventory === "viewer" ? [root, remote]
        : request.federationTarget?.scope === "remote" ? [{ ...remote, parentThreadId: "different-root" }] : [root],
    }));
    const members = await readNavigationArchiveGroup({ api: { getNavigationQueryPage,
      readFederationHealth: async () => ({ health: { instanceId: "local-id", enabled: true, role: "gateway", status: "connected", peers: [] } }) }, thread: root });
    expect(getNavigationQueryPage.mock.calls.some(([request]) => request.federationTarget?.scope === "remote")).toBe(true);
    expect(members.map((member) => member.id)).toEqual(["root"]);
  });

  it("fails discovery before returning an archive plan when a required owner is unavailable", async () => {
    const root = thread("root");
    const releaseNavigationQuery = vi.fn(async () => undefined);
    const getNavigationQueryPage = vi.fn(async (request: NavigationQueryRequest) => ({
      ...navigationQueryFixture(request, { threads: [root] }), coverage: { state: "degraded" as const },
    }));
    await expect(readNavigationArchiveGroup({ api: { getNavigationQueryPage, releaseNavigationQuery }, thread: root }))
      .rejects.toThrow("membership is incomplete");
    expect(releaseNavigationQuery).toHaveBeenCalledTimes(1);
  });

  it("keeps a viewer-owned child local when archiving from a remote native window", async () => {
    const root = { ...thread("root"), federation: { instanceLabel: "Peer", capabilities: ["turn_control" as const],
      ref: { backend: "codex" as const, threadId: "root", target: { scope: "remote" as const, instanceId: "peer" } } } };
    const child = { ...thread("child", "root"), parentThreadInstanceId: "peer" };
    const getNavigationQueryPage = vi.fn(async (request: NavigationQueryRequest) => navigationQueryFixture(request, {
      threads: request.inventory === "viewer" ? [root, child] : request.federationTarget?.scope === "remote" ? [root] : [child],
    }));
    const members = await readNavigationArchiveGroup({ thread: root, windowTarget: { scope: "remote", instanceId: "peer" },
      api: { getNavigationQueryPage, readFederationHealth: async () => ({ health: {
        instanceId: "local-id", enabled: true, role: "gateway", status: "connected", peers: [],
      } }) } });
    expect(members.map(({ id, federationTarget }) => [id, federationTarget])).toEqual([
      ["child", { scope: "local" }], ["root", { scope: "remote", instanceId: "peer" }],
    ]);
  });

  it("requires each owner's current control grant before producing a plan", async () => {
    const root = { ...thread("root"), federation: { instanceLabel: "Peer",
      ref: { backend: "codex" as const, threadId: "root", target: { scope: "remote" as const, instanceId: "peer" } } } };
    await expect(readNavigationArchiveGroup({ thread: root, api: {
      getNavigationQueryPage: async (request) => navigationQueryFixture(request, { threads: [root] }),
    } })).rejects.toThrow("has not granted thread control");
  });
});
