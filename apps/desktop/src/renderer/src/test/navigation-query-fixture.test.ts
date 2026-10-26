import { expect, it, vi } from "vitest";
import type { NavigationQueryRequest, NavigationThreadSummary } from "@pwragent/shared";
import { navigationQueryFixture } from "./navigation-query-fixture";

function population() {
  const label = vi.fn(() => "Repo");
  const directory = { key: "directory:/repo", kind: "directory" as const, path: "/repo", get label() { return label(); } };
  const thread: NavigationThreadSummary = {
    id: "thread", source: "codex", title: "Thread", titleSource: "explicit",
    inbox: { inInbox: false },
    linkedDirectories: [{ id: "/repo", kind: "local", path: "/repo", label: "Repo" }],
  };
  return { directory, thread, label };
}

it("does not build unused directory descriptors for project card pages", () => {
  const { directory, thread, label } = population();
  const page = navigationQueryFixture({ protocol: 2, consumer: "star-map", pageSize: 10,
    query: { kind: "star-map", projectKey: directory.key, filters: {} } }, { directories: [directory], threads: [thread] });

  expect(page.entries.map((entry) => entry.row.id)).toEqual([thread.id]);
  expect(page.counts.total).toBe(1);
  expect(page.directories).toEqual([]);
  expect(label).not.toHaveBeenCalled();
});

it("indexes child counts once instead of scanning the population for each returned row", () => {
  const { thread } = population();
  let parentReads = 0;
  const children = Array.from({ length: 100 }, (_, index) => ({
    ...thread, id: `child-${index}`,
    get parentThreadId() { parentReads += 1; return thread.id; },
  }));
  const threads = [thread, ...children];
  const page = navigationQueryFixture({ protocol: 2, consumer: "main-sidebar", pageSize: 10,
    query: { kind: "lens", lens: "recents" } }, { threads });

  expect(page.entries[0]!.row.ordinaryChildCount).toBe(100);
  expect(page.entries.slice(1).every((entry) => entry.row.ordinaryChildCount === 0)).toBe(true);
  // Parent resolution plus row serialization is linear in the input and page.
  expect(parentReads).toBeLessThanOrEqual(3 * threads.length + 5 * page.entries.length);
});

it.each<NavigationQueryRequest["query"]>([{ kind: "directory-index" }, { kind: "star-map-geometry" }])(
  "keeps directory descriptors in $kind pages", (query) => {
    const { directory, thread, label } = population();
    const page = navigationQueryFixture({ protocol: 2, consumer: "star-map", pageSize: 10, query },
      { directories: [directory], threads: [thread] });

    expect(page.entries).toEqual([]);
    expect(page.directories).toEqual([expect.objectContaining({ key: directory.key, label: "Repo", counts: { total: 1, active: 0, activeRemote: 0, unread: 0, review: 0 } })]);
    expect(label).toHaveBeenCalledTimes(1);
  },
);
