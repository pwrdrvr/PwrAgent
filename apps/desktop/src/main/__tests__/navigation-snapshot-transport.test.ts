import { describe, expect, it } from "vitest";
import type {
  NavigationSnapshot,
  NavigationThreadSummary,
} from "@pwragent/shared";
import {
  applyNavigationSnapshotTransportResponse,
  buildThreadIdentityKey,
} from "@pwragent/shared";
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

  it("keeps colliding local and remote identities distinct across a delta", () => {
    const transport = new NavigationSnapshotTransport();
    const local = {
      ...buildThread(1),
      title: "Local collision",
    };
    const full = transport.encode({
      request: {},
      snapshot: buildSnapshot([local]),
    });
    if (full.kind !== "full") {
      throw new Error("Expected initial full snapshot");
    }
    const remote = {
      ...buildThread(1),
      title: "Remote collision",
      federation: {
        ref: {
          backend: "codex" as const,
          target: {
            scope: "remote" as const,
            instanceId: "remote-owner",
          },
          threadId: local.id,
        },
        instanceLabel: "Remote owner",
      },
    };
    const delta = transport.encode({
      baseRevision: full.revision,
      request: {},
      snapshot: buildSnapshot([local, remote], 2),
    });
    if (delta.kind !== "delta") {
      throw new Error("Expected collision delta");
    }

    expect(delta.upsertedThreads).toEqual([remote]);
    const baseline = applyNavigationSnapshotTransportResponse(undefined, full);
    const applied = applyNavigationSnapshotTransportResponse(baseline, delta);
    expect(applied?.snapshot.threads.map((thread) => ({
      instanceId: thread.federation?.ref.target.scope === "remote"
        ? thread.federation.ref.target.instanceId
        : undefined,
      title: thread.title,
    }))).toEqual([
      { instanceId: undefined, title: "Local collision" },
      { instanceId: "remote-owner", title: "Remote collision" },
    ]);
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

  it("filters one canonical history for sparse and full consumers", () => {
    const transport = new NavigationSnapshotTransport();
    const threads = Array.from({ length: 1_200 }, (_, index) =>
      buildThread(index),
    );
    const sparseSelection = {
      kind: "threads" as const,
      threadKeys: ["codex:thread-3", "codex:thread-9"],
    };
    const sparse = transport.encode({
      request: {},
      scopeKey: "federation-navigation",
      selection: sparseSelection,
      snapshot: buildSnapshot(threads),
    });
    if (sparse.kind !== "full") throw new Error("Expected sparse baseline");
    expect(sparse.snapshot.threads.map((thread) => thread.id)).toEqual([
      "thread-3",
      "thread-9",
    ]);

    const updatedThreads = threads.map((thread) =>
      thread.id === "thread-3" || thread.id === "thread-700"
        ? { ...thread, title: `${thread.title} updated` }
        : thread
    );
    const sparseDelta = transport.encode({
      baseRevision: sparse.revision,
      request: { filter: "ignored-owner-scope" },
      scopeKey: "federation-navigation",
      selection: sparseSelection,
      snapshot: buildSnapshot(updatedThreads, 2),
    });
    if (sparseDelta.kind !== "delta") {
      throw new Error("Expected sparse delta");
    }
    expect(sparseDelta.upsertedThreads.map((thread) => thread.id)).toEqual([
      "thread-3",
    ]);

    const full = transport.encode({
      request: { refreshMode: "active-recent" },
      scopeKey: "federation-navigation",
      selection: { kind: "all" },
      snapshot: buildSnapshot(updatedThreads, 3),
    });
    if (full.kind !== "full") throw new Error("Expected full baseline");
    expect(full.revision).toBe(sparseDelta.revision);
    expect(full.snapshot.threads).toHaveLength(1_200);
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
