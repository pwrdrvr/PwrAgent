import { describe, expect, it } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import { threadSummaryIdentityKey } from "../../../lib/federated-thread-events";
import type { NavigationPresentedThread } from "../../../lib/navigation-loaded-rows";
import { countArchiveGroup } from "../archive-group-counts";

function thread(
  id: string,
  extra: Partial<NavigationPresentedThread> = {},
): NavigationPresentedThread {
  return {
    id,
    source: "codex",
    title: id,
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  } as NavigationPresentedThread;
}

function count(parent: NavigationPresentedThread, threads: NavigationPresentedThread[]) {
  const byKey = new Map<string, NavigationThreadSummary>(
    threads.map((entry) => [threadSummaryIdentityKey(entry), entry]),
  );
  return countArchiveGroup(parent, threads, byKey);
}

describe("countArchiveGroup", () => {
  it("reports no children for a thread with none", () => {
    const parent = thread("parent");
    expect(count(parent, [parent])).toEqual({ childCount: 0, threadCount: 1, exact: true });
  });

  it("counts a collapsed parent from its reported child count", () => {
    const parent = thread("parent", { ordinaryChildCount: 6, subthreadsCollapsed: true });
    expect(count(parent, [parent])).toEqual({ childCount: 6, threadCount: 7, exact: false });
  });

  it("counts loaded children exactly, including nested ones", () => {
    const parent = thread("parent", { ordinaryChildCount: 2 });
    const childA = thread("child-a", { parentThreadId: "parent", ordinaryChildCount: 1 });
    const childB = thread("child-b", { parentThreadId: "parent" });
    const grandchild = thread("grandchild", { parentThreadId: "child-a" });
    expect(count(parent, [parent, childA, childB, grandchild])).toEqual({
      childCount: 2,
      threadCount: 4,
      exact: true,
    });
  });

  it("marks the total as a floor when a loaded child holds unloaded sub-threads", () => {
    const parent = thread("parent", { ordinaryChildCount: 1 });
    const child = thread("child", {
      parentThreadId: "parent",
      ordinaryChildCount: 3,
      subthreadsCollapsed: true,
    });
    expect(count(parent, [parent, child])).toEqual({ childCount: 1, threadCount: 5, exact: false });
  });

  it("adds a partly loaded tray's unloaded children to the total", () => {
    const parent = thread("parent", { ordinaryChildCount: 4 });
    const child = thread("child", { parentThreadId: "parent" });
    expect(count(parent, [parent, child])).toEqual({ childCount: 4, threadCount: 5, exact: false });
  });

  it("trusts loaded children when the reported count lags behind", () => {
    const parent = thread("parent", { ordinaryChildCount: 0 });
    const child = thread("child", { parentThreadId: "parent" });
    expect(count(parent, [parent, child])).toEqual({ childCount: 1, threadCount: 2, exact: true });
  });
});
