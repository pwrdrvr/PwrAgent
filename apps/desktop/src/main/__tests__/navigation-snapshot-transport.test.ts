import { describe, expect, it } from "vitest";
import type {
  NavigationSnapshot,
  NavigationThreadSummary,
} from "@pwragent/shared";
import { buildThreadIdentityKey } from "@pwragent/shared";
import { NavigationSnapshotTransport } from "../navigation-snapshot-transport";

function buildThread(index: number): NavigationThreadSummary {
  return {
    id: `thread-${index}`,
    title: `Thread ${index}`,
    titleSource: "explicit",
    linkedDirectories: [],
    source: "codex",
    inbox: { inInbox: true, reason: "new-thread" },
    createdAt: index,
    updatedAt: index,
  };
}

function buildSnapshot(
  threads: NavigationThreadSummary[],
  fetchedAt = 1,
): NavigationSnapshot {
  return {
    backend: "all",
    fetchedAt,
    unchanged: false,
    threads,
    inboxThreadKeys: threads.map((thread) =>
      buildThreadIdentityKey(thread.source, thread.id),
    ),
    directories: [],
    launchpadDefaults: {
      backend: "codex",
      executionMode: "default",
    },
  };
}

describe("NavigationSnapshotTransport", () => {
  it("reduces an unchanged 1,200-thread refresh to a revision acknowledgement", () => {
    const transport = new NavigationSnapshotTransport();
    const threads = Array.from({ length: 1_200 }, (_, index) =>
      buildThread(index),
    );
    const full = transport.encode({
      request: {},
      snapshot: buildSnapshot(threads),
    });

    expect(full.kind).toBe("full");
    if (full.kind !== "full") {
      throw new Error("Expected initial full snapshot");
    }

    const unchanged = transport.encode({
      baseRevision: full.revision,
      request: {},
      snapshot: buildSnapshot(threads, 2),
    });

    expect(unchanged).toEqual({
      kind: "unchanged",
      revision: full.revision,
    });
    expect(JSON.stringify(unchanged).length).toBeLessThan(
      JSON.stringify(full).length / 1_000,
    );
  });

  it("sends only changed thread rows until identities or order change", () => {
    const transport = new NavigationSnapshotTransport();
    const threads = Array.from({ length: 1_200 }, (_, index) =>
      buildThread(index),
    );
    const full = transport.encode({
      request: {},
      snapshot: buildSnapshot(threads),
    });
    if (full.kind !== "full") {
      throw new Error("Expected initial full snapshot");
    }
    const updatedThreads = threads.map((thread, index) =>
      index < 10
        ? { ...thread, title: `${thread.title} updated`, updatedAt: 2_000 + index }
        : thread,
    );

    const updated = transport.encode({
      baseRevision: full.revision,
      request: {},
      snapshot: buildSnapshot(updatedThreads, 2),
    });

    expect(updated.kind).toBe("delta");
    if (updated.kind !== "delta") {
      throw new Error("Expected delta snapshot");
    }
    expect(updated.upsertedThreads).toHaveLength(10);
    expect(updated.removedThreadKeys).toEqual([]);
    expect(updated.threadKeys).toBeUndefined();

    const remainingThreads = updatedThreads.slice(5);
    const removed = transport.encode({
      baseRevision: updated.revision,
      request: {},
      snapshot: buildSnapshot(remainingThreads, 3),
    });

    expect(removed.kind).toBe("delta");
    if (removed.kind !== "delta") {
      throw new Error("Expected delta snapshot");
    }
    expect(removed.removedThreadKeys).toEqual(
      updatedThreads.slice(0, 5).map((thread) =>
        buildThreadIdentityKey(thread.source, thread.id),
      ),
    );
    expect(removed.upsertedThreads).toEqual([]);
    expect(removed.threadKeys).toBeUndefined();
    expect(removed.removedInboxThreadKeys).toEqual(
      removed.removedThreadKeys,
    );
    expect(removed.inboxThreadKeys).toBeUndefined();
  });

  it("sends a full baseline for a stale revision", () => {
    const transport = new NavigationSnapshotTransport();
    const snapshot = buildSnapshot([buildThread(1)]);
    const first = transport.encode({
      request: {},
      snapshot,
    });
    if (first.kind !== "full") {
      throw new Error("Expected initial full snapshot");
    }

    expect(transport.encode({
      baseRevision: "stale",
      request: {},
      snapshot,
    }).kind).toBe("full");
    expect(transport.encode({
      baseRevision: first.revision,
      request: {},
      snapshot,
    }).kind).toBe("unchanged");
  });

  it("retains independent revisions for full and active-recent scopes", () => {
    const transport = new NavigationSnapshotTransport();
    const snapshot = buildSnapshot([buildThread(1)]);
    const full = transport.encode({
      request: {},
      snapshot,
    });
    const activeRecent = transport.encode({
      request: { refreshMode: "active-recent" },
      snapshot,
    });
    if (full.kind !== "full" || activeRecent.kind !== "full") {
      throw new Error("Expected independent full baselines");
    }

    expect(transport.encode({
      baseRevision: full.revision,
      request: { refreshMode: "full" },
      snapshot,
    })).toEqual({
      kind: "unchanged",
      revision: full.revision,
    });
    expect(transport.encode({
      baseRevision: activeRecent.revision,
      request: { refreshMode: "active-recent" },
      snapshot,
    })).toEqual({
      kind: "unchanged",
      revision: activeRecent.revision,
    });
  });

  it("evicts the least recently used shared scope", () => {
    const transport = new NavigationSnapshotTransport({ maxScopes: 2 });
    const snapshot = buildSnapshot([buildThread(1)]);
    const first = transport.encode({
      request: { filter: "first" },
      snapshot,
    });
    const second = transport.encode({
      request: { filter: "second" },
      snapshot,
    });
    if (first.kind !== "full" || second.kind !== "full") {
      throw new Error("Expected full baselines");
    }

    expect(transport.encode({
      baseRevision: first.revision,
      request: { filter: "first" },
      snapshot,
    }).kind).toBe("unchanged");
    transport.encode({
      request: { filter: "third" },
      snapshot,
    });

    expect(transport.encode({
      baseRevision: second.revision,
      request: { filter: "second" },
      snapshot,
    }).kind).toBe("full");
  });

  it("serves shared change history and expires old revisions", () => {
    const transport = new NavigationSnapshotTransport({
      maxChangesPerScope: 2,
    });
    const initial = buildSnapshot([buildThread(1)]);
    const full = transport.encode({ request: {}, snapshot: initial });
    if (full.kind !== "full") throw new Error("Expected full baseline");
    const secondSnapshot = buildSnapshot([
      { ...buildThread(1), title: "Second" },
    ], 2);
    const second = transport.encode({
      baseRevision: full.revision,
      request: {},
      snapshot: secondSnapshot,
    });
    if (second.kind !== "delta") throw new Error("Expected first change");
    const thirdSnapshot = buildSnapshot([
      { ...buildThread(1), title: "Third" },
    ], 3);
    const third = transport.encode({
      baseRevision: second.revision,
      request: {},
      snapshot: thirdSnapshot,
    });
    if (third.kind !== "delta") throw new Error("Expected second change");

    expect(transport.encode({
      baseRevision: full.revision,
      request: {},
      snapshot: thirdSnapshot,
    })).toMatchObject({
      kind: "changes",
      baseRevision: full.revision,
      revision: third.revision,
      changes: [
        { baseRevision: full.revision, revision: second.revision },
        { baseRevision: second.revision, revision: third.revision },
      ],
    });

    const fourthSnapshot = buildSnapshot([
      { ...buildThread(1), title: "Fourth" },
    ], 4);
    transport.encode({
      baseRevision: third.revision,
      request: {},
      snapshot: fourthSnapshot,
    });
    expect(transport.encode({
      baseRevision: full.revision,
      request: {},
      snapshot: fourthSnapshot,
    }).kind).toBe("full");
  });

  it("does not rewind shared history when an older snapshot finishes late", () => {
    const transport = new NavigationSnapshotTransport();
    const initial = buildSnapshot([buildThread(1)], 1);
    const full = transport.encode({ request: {}, snapshot: initial });
    if (full.kind !== "full") throw new Error("Expected full baseline");
    const currentSnapshot = buildSnapshot([
      { ...buildThread(1), title: "Current" },
    ], 3);
    const current = transport.encode({
      baseRevision: full.revision,
      request: {},
      snapshot: currentSnapshot,
    });
    if (current.kind !== "delta") throw new Error("Expected current change");

    const lateSnapshot = buildSnapshot([
      { ...buildThread(1), title: "Late stale result" },
    ], 2);
    expect(transport.encode({
      baseRevision: current.revision,
      request: {},
      snapshot: lateSnapshot,
    })).toEqual({
      kind: "unchanged",
      revision: current.revision,
    });
  });
});
