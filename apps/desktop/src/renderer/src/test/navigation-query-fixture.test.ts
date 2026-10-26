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
    query: { kind: "star-map", projectKey: directory.key } }, { directories: [directory], threads: [thread] });

  expect(page.entries.map((entry) => entry.row.id)).toEqual([thread.id]);
  expect(page.counts.total).toBe(1);
  expect(page.directories).toEqual([]);
  expect(label).not.toHaveBeenCalled();
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
