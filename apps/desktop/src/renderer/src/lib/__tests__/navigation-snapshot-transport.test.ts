import { describe, expect, it } from "vitest";
import type {
  NavigationSnapshot,
  NavigationSnapshotTransportFull,
  NavigationThreadSummary,
} from "@pwragent/shared";
import { buildThreadIdentityKey } from "@pwragent/shared";
import { applyNavigationSnapshotTransportResponse } from "../navigation-snapshot-transport";

function buildThread(id: string, title = id): NavigationThreadSummary {
  return {
    id,
    title,
    titleSource: "explicit",
    linkedDirectories: [],
    source: "codex",
    inbox: { inInbox: true, reason: "new-thread" },
  };
}

function buildFull(): NavigationSnapshotTransportFull {
  const threads = [buildThread("one"), buildThread("two")];
  const snapshot: NavigationSnapshot = {
    backend: "all",
    fetchedAt: 1,
    unchanged: false,
    threads,
    inboxThreadKeys: threads.map((thread) =>
      buildThreadIdentityKey(thread.source, thread.id),
    ),
    directories: [
      {
        key: "directory:one",
        kind: "directory",
        label: "One",
        path: "/one",
        threadKeys: [],
        needsAttentionCount: 0,
      },
    ],
    launchpadDefaults: {
      backend: "codex",
      executionMode: "default",
    },
    providerRefresh: { state: "checking" },
  };
  return { kind: "full", revision: "1", snapshot };
}

describe("applyNavigationSnapshotTransportResponse", () => {
  it("keeps the canonical baseline for an unchanged acknowledgement", () => {
    const full = buildFull();
    const initial = applyNavigationSnapshotTransportResponse(undefined, full);
    const unchanged = applyNavigationSnapshotTransportResponse(initial, {
      kind: "unchanged",
      revision: "1",
    });

    expect(unchanged?.snapshot.threads).toBe(full.snapshot.threads);
    expect(unchanged?.snapshot.directories).toBe(full.snapshot.directories);
    expect(unchanged?.snapshot.unchanged).toBe(true);
  });

  it("applies keyed updates, removals, and replacement order", () => {
    const initial = applyNavigationSnapshotTransportResponse(
      undefined,
      buildFull(),
    );
    const three = buildThread("three");
    const key = (thread: NavigationThreadSummary): string =>
      buildThreadIdentityKey(thread.source, thread.id);

    const updated = applyNavigationSnapshotTransportResponse(initial, {
      kind: "delta",
      baseRevision: "1",
      revision: "2",
      fetchedAt: 2,
      removedThreadKeys: [key(buildThread("two"))],
      upsertedThreads: [buildThread("one", "One updated"), three],
      threadKeys: [key(three), key(buildThread("one"))],
      removedDirectoryKeys: ["directory:one"],
      upsertedDirectories: [],
      directoryKeys: [],
      addedInboxThreadKeys: [key(three)],
      removedInboxThreadKeys: [
        key(buildThread("one")),
        key(buildThread("two")),
      ],
      providerRefresh: { state: "ready" },
    });

    expect(updated?.revision).toBe("2");
    expect(updated?.snapshot.threads.map((thread) => thread.title)).toEqual([
      "three",
      "One updated",
    ]);
    expect(updated?.snapshot.directories).toEqual([]);
    expect(updated?.snapshot.inboxThreadKeys).toEqual([key(three)]);
    expect(updated?.snapshot.fetchedAt).toBe(2);
    expect(updated?.snapshot.unchanged).toBe(false);
    expect(updated?.snapshot.providerRefresh).toEqual({ state: "ready" });
  });

  it("rejects a delta without the matching canonical baseline", () => {
    const initial = applyNavigationSnapshotTransportResponse(
      undefined,
      buildFull(),
    );
    const delta = {
      kind: "delta" as const,
      baseRevision: "stale",
      revision: "2",
      fetchedAt: 2,
      removedThreadKeys: [],
      upsertedThreads: [],
      removedDirectoryKeys: [],
      upsertedDirectories: [],
    };

    expect(applyNavigationSnapshotTransportResponse(initial, delta)).toBeUndefined();
    expect(applyNavigationSnapshotTransportResponse(undefined, delta)).toBeUndefined();
  });

  it("applies a shared sequence of changes from the requested revision", () => {
    const initial = applyNavigationSnapshotTransportResponse(
      undefined,
      buildFull(),
    );
    const one = buildThread("one");
    const key = buildThreadIdentityKey(one.source, one.id);
    const updated = applyNavigationSnapshotTransportResponse(initial, {
      kind: "changes",
      baseRevision: "1",
      revision: "3",
      changes: [
        {
          kind: "delta",
          baseRevision: "1",
          revision: "2",
          fetchedAt: 2,
          removedThreadKeys: [],
          upsertedThreads: [{ ...one, title: "Second" }],
          removedDirectoryKeys: [],
          upsertedDirectories: [],
        },
        {
          kind: "delta",
          baseRevision: "2",
          revision: "3",
          fetchedAt: 3,
          removedThreadKeys: [],
          upsertedThreads: [{ ...one, title: "Third" }],
          removedDirectoryKeys: [],
          upsertedDirectories: [],
          removedInboxThreadKeys: [key],
        },
      ],
    });

    expect(updated?.revision).toBe("3");
    expect(updated?.snapshot.threads[0]?.title).toBe("Third");
    expect(updated?.snapshot.inboxThreadKeys).not.toContain(key);
  });
});
