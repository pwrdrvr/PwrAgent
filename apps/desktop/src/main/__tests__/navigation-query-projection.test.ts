import { describe, expect, it } from "vitest";
import type {
  NavigationQueryRequest,
  NavigationSnapshot,
  NavigationThreadSummary,
} from "@pwragent/shared";
import { projectNavigationQuery } from "../app-server/navigation-query-projection";

function thread(
  id: string,
  patch: Partial<NavigationThreadSummary> = {},
): NavigationThreadSummary {
  return {
    id,
    source: "codex",
    title: `Thread ${id}`,
    titleSource: "derived",
    createdAt: Number(id.replace(/\D/g, "")) || 1,
    updatedAt: Number(id.replace(/\D/g, "")) || 1,
    linkedDirectories: [{ id: "repo", kind: "local", label: "repo", path: "/repo" }],
    inbox: { inInbox: false },
    ...patch,
  };
}

function snapshot(threads: NavigationThreadSummary[]): NavigationSnapshot {
  return {
    backend: "all",
    fetchedAt: 1,
    unchanged: false,
    threads,
    inboxThreadKeys: threads
      .filter((candidate) => candidate.inbox.inInbox)
      .map((candidate) => `${candidate.source}:${candidate.id}`),
    directories: [{
      key: "directory:/repo",
      kind: "directory",
      label: "repo",
      path: "/repo",
      threadKeys: threads.map((candidate) => `${candidate.source}:${candidate.id}`),
      needsAttentionCount: threads.filter(
        (candidate) => candidate.threadStatus === "active" || candidate.inbox.inInbox,
      ).length,
    }],
    launchpadDefaults: {
      backend: "codex",
      executionMode: "default",
    },
  };
}

function request(
  query: NavigationQueryRequest["query"],
): NavigationQueryRequest {
  return {
    protocol: 2,
    consumer: "main-sidebar",
    query,
  };
}

describe("navigation query projection", () => {
  it("cold_navigation_fetches_only_visible_membership", () => {
    const source = snapshot([
      thread("1", { pinnedRank: "1" }),
      thread("2"),
      thread("3", { parentThreadId: "2" }),
    ]);

    const index = projectNavigationQuery({
      request: request({ kind: "directory-index" }),
      index: source,
    });
    expect(index.entries).toEqual([]);
    expect(index.directories).toEqual([
      expect.objectContaining({
        counts: { total: 3, active: 0, unread: 0, review: 0 },
        pinnedRootCount: 1,
        unpinnedRootCount: 1,
      }),
    ]);
    expect(JSON.stringify(index.directories)).not.toContain("threadKeys");

    const collapsed = projectNavigationQuery({
      request: request({
        kind: "directory",
        directoryKey: "directory:/repo",
      }),
      index: source,
    });
    expect(collapsed.entries.map((entry) => entry.row.id)).toEqual(["1", "2"]);

    const disclosed = projectNavigationQuery({
      request: request({
        kind: "directory",
        directoryKey: "directory:/repo",
        disclosedParentThreadKeys: ["codex:2"],
      }),
      index: source,
    });
    expect(disclosed.entries.map((entry) => entry.row.id)).toEqual(["1", "3", "2"]);
  });

  it("index_never_serializes_thread_detail_or_payload_fields", () => {
    const source = snapshot([
      thread("1", {
        agent: {
          name: "Agent",
          instructions: "PRIVATE INSTRUCTIONS",
          instructionLineCount: 1,
          instructionsTooLong: false,
          updatedAt: 1,
        },
        optimisticUserMessage: {
          text: "PRIVATE OPTIMISTIC TEXT",
          imageParts: [{ type: "image", url: "data:image/png;base64,PRIVATE_IMAGE" }],
        },
        queuedTurns: [{
          queueEntryId: "queued-1",
          origin: "manual",
          displayText: "PRIVATE QUEUED TEXT",
          createdAt: 1,
          position: 0,
        }],
        questionnaireActivityLog: [{
          id: "question-1",
          requestId: "request-1",
          threadId: "1",
          status: "submitted",
          questions: [],
          createdAt: 1,
          updatedAt: 1,
        }],
      }),
    ]);
    const page = projectNavigationQuery({
      request: request({ kind: "lens", lens: "recents" }),
      index: source,
    });
    const encoded = JSON.stringify(page);

    expect(page.entries[0]?.row).toEqual(expect.objectContaining({
      agent: expect.objectContaining({ name: "Agent" }),
      queueCount: 1,
      queueState: "ready",
    }));
    expect(encoded).not.toContain("PRIVATE INSTRUCTIONS");
    expect(encoded).not.toContain("PRIVATE OPTIMISTIC TEXT");
    expect(encoded).not.toContain("PRIVATE_IMAGE");
    expect(encoded).not.toContain("PRIVATE QUEUED TEXT");
    expect(encoded).not.toContain("questionnaireActivityLog");
    expect(encoded).not.toContain("queuedTurns");
  });

  it("child_parent_on_later_page_stays_grouped", () => {
    const source = snapshot([
      thread("1", { parentThreadId: "2", createdAt: 20, updatedAt: 20 }),
      thread("2", { createdAt: 10, updatedAt: 10 }),
    ]);
    const projected = projectNavigationQuery({
      request: request({ kind: "lens", lens: "recents" }),
      index: source,
    });

    expect(projected.entries[0]).toEqual(expect.objectContaining({
      placement: {
        kind: "child",
        parent: { backend: "codex", threadId: "2" },
      },
    }));
  });

  it("directory_counts_do_not_depend_on_loaded_pages", () => {
    const source = snapshot([
      thread("1", { threadStatus: "active", inbox: { inInbox: true } }),
      thread("2", { inbox: { inInbox: true } }),
      thread("3"),
    ]);
    const projected = projectNavigationQuery({
      request: request({ kind: "directory-index" }),
      index: source,
    });

    expect(projected.directories[0]?.counts).toEqual({
      total: 3,
      active: 1,
      unread: 2,
      review: 1,
    });
  });
});

it("keeps ten-root demand separate from disclosed child pages and pin disclosure", () => {
  const threads = [thread("parent", { pinnedRank: "1024", subthreadOrder: ["child-0", "child-19"] }),
    ...Array.from({ length: 12 }, (_, index) => thread(`root-${index}`)),
    ...Array.from({ length: 20 }, (_, index) => thread(`child-${index}`, { parentThreadId: "parent" })),
  ];
  const index = snapshot(threads);
  const roots = projectNavigationQuery({ index, request: request({ kind: "directory", directoryKey: "directory:/repo", roots: "all" }) });
  expect(roots.entries).toHaveLength(13);
  expect(roots.entries.every((entry) => entry.placement.kind === "root")).toBe(true);
  expect(roots.counts.total).toBe(33);
  const pinned = projectNavigationQuery({ index, request: request({ kind: "directory", directoryKey: "directory:/repo", roots: "pinned" }) });
  expect(pinned.entries.map((entry) => entry.row.id)).toEqual(["parent"]);
  expect(pinned.counts.total).toBe(33);
  const children = projectNavigationQuery({ index, request: request({ kind: "children", parent: { backend: "codex", threadId: "parent" } }) });
  expect(children.entries).toHaveLength(20);
  expect(children.entries.slice(0, 2).map((entry) => entry.row.id)).toEqual(["child-0", "child-19"]);
  expect(children.entries.every((entry) => entry.placement.kind === "child")).toBe(true);
  expect(children.counts.total).toBe(20);
});

it("returns exact off-page directory counts without directory membership arrays", () => {
  const index = snapshot([thread("t1", { pinnedRank: "a", threadStatus: "active" }), thread("t2", { inbox: { inInbox: true } })]);
  index.directories = [
    ...Array.from({ length: 150 }, (_, number) => ({ key: `directory:/earlier-${number}`, kind: "directory" as const,
      label: `Earlier ${number}`, path: `/earlier-${number}`, threadKeys: [], needsAttentionCount: 0 })),
    ...index.directories,
  ];
  const exact = projectNavigationQuery({ index, request: request({ kind: "directory-index", keys: ["directory:/repo"] }) });
  expect(exact.directories).toHaveLength(1);
  expect(exact.directories[0]).toMatchObject({ key: "directory:/repo", counts: { total: 2, active: 1, unread: 1, review: 1 }, pinnedRootCount: 1, unpinnedRootCount: 1 });
  expect(exact.entries).toEqual([]);
  expect(exact.directories[0]).not.toHaveProperty("threadKeys");
});
