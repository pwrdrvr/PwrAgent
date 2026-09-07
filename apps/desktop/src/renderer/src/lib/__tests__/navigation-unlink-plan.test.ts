import { describe, expect, it, vi } from "vitest";
import type { NavigationSnapshot, NavigationThreadSummary } from "@pwragent/shared";
import { navigationOwnerApiFixture } from "../../test/navigation-owner-api-fixture";
import { readNavigationUnlinkPlan } from "../navigation-unlink-plan";

const thread = (id: string): NavigationThreadSummary => ({ id, title: id, titleSource: "explicit", source: "codex", linkedDirectories: [], inbox: { inInbox: false } });
const population = (threads: NavigationThreadSummary[]): NavigationSnapshot => ({ backend: "all", fetchedAt: 1,
  unchanged: false, threads, directories: [], inboxThreadKeys: [], launchpadDefaults: { backend: "codex", executionMode: "default" } });

describe("bounded unlink planning", () => {
  it("uses an unloaded parent's canonical sibling order and keeps only a relative pin anchor", async () => {
    const parent = { ...thread("parent"), pinnedRank: "102400", subthreadOrder: ["a", ...Array.from({ length: 100 }, (_, i) => `unloaded-${i}`), "b"] };
    const a = { ...thread("a"), parentThreadId: "parent" };
    const b = { ...thread("b"), parentThreadId: "parent" };
    const releaseNavigationQuery = vi.fn(async () => undefined);
    const api = navigationOwnerApiFixture({ readPopulation: async () => population([parent, a, b]), releaseNavigationQuery });
    const getNavigationQueryPage = vi.fn(api.getNavigationQueryPage!);
    const plan = await readNavigationUnlinkPlan({ api: { ...api, getNavigationQueryPage }, threads: [b, a] });
    expect(plan.map((member) => member.thread.id)).toEqual(["a", "b"]);
    expect(plan.map((member) => member.pinBefore)).toEqual(["codex:parent", "codex:parent"]);
    expect(plan[0]?.expectedParent).toEqual({ backend: "codex", threadId: "parent", instanceId: undefined });
    expect(getNavigationQueryPage).toHaveBeenCalledTimes(1);
    expect(getNavigationQueryPage.mock.calls[0]?.[0]).toMatchObject({ pageSize: 1, inventory: "viewer",
      federationTarget: { scope: "local" }, query: { kind: "exact", identities: [{ backend: "codex", threadId: "parent" }] } });
    expect(releaseNavigationQuery).toHaveBeenCalledTimes(1);
  });

  it("does not mistake an owner's pin for a viewer-owned pin", async () => {
    const target = { scope: "remote" as const, instanceId: "peer" };
    const parent = { ...thread("parent"), federation: { ref: { target, backend: "codex" as const, threadId: "parent" }, instanceLabel: "Peer" } };
    const child = { ...thread("child"), parentThreadId: "parent", parentThreadInstanceId: "peer" };
    const api = navigationOwnerApiFixture({ readPopulation: async () => population([parent, child]) });
    const originalDetail = api.getNavigationSelectedDetail!;
    api.getNavigationSelectedDetail = async (request) => {
      const detail = await originalDetail(request);
      return request.ref.threadId === "parent" ? { ...detail, thread: { ...detail.thread!, pinnedRank: "999999" } } : detail;
    };
    const [member] = await readNavigationUnlinkPlan({ api, threads: [child] });
    expect(member?.pinBefore).toBeUndefined();
    expect(member?.target).toEqual({ scope: "local" });
    expect(member?.expectedParent.instanceId).toBe("peer");
  });

  it("releases query demand when parent pin coverage is incomplete", async () => {
    const api = navigationOwnerApiFixture({ readPopulation: async () => population([
      thread("parent"), { ...thread("child"), parentThreadId: "parent" },
    ]) });
    const originalPage = api.getNavigationQueryPage!;
    api.getNavigationQueryPage = async (request) => ({ ...await originalPage(request), coverage: { state: "degraded" } });
    api.releaseNavigationQuery = vi.fn(async () => undefined);
    await expect(readNavigationUnlinkPlan({ api, threads: [thread("child")] })).rejects.toThrow("pin placement is not ready");
    expect(api.releaseNavigationQuery).toHaveBeenCalledTimes(1);
  });
});
