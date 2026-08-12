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
      clientId: 7,
      request: {},
      snapshot: buildSnapshot(threads),
    });

    expect(full.kind).toBe("full");
    if (full.kind !== "full") {
      throw new Error("Expected initial full snapshot");
    }

    const unchanged = transport.encode({
      baseRevision: full.revision,
      clientId: 7,
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
      clientId: 8,
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
      clientId: 8,
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
      clientId: 8,
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

  it("sends a full baseline for a stale revision or another renderer", () => {
    const transport = new NavigationSnapshotTransport();
    const snapshot = buildSnapshot([buildThread(1)]);
    const first = transport.encode({
      clientId: "renderer:9",
      request: {},
      snapshot,
    });
    if (first.kind !== "full") {
      throw new Error("Expected initial full snapshot");
    }

    expect(transport.encode({
      baseRevision: "stale",
      clientId: "renderer:9",
      request: {},
      snapshot,
    }).kind).toBe("full");
    expect(transport.encode({
      baseRevision: first.revision,
      clientId: "federation:viewer-10",
      request: {},
      snapshot,
    }).kind).toBe("full");
  });

  it("retains independent revisions for full and active-recent scopes", () => {
    const transport = new NavigationSnapshotTransport();
    const snapshot = buildSnapshot([buildThread(1)]);
    const full = transport.encode({
      clientId: 11,
      request: {},
      snapshot,
    });
    const activeRecent = transport.encode({
      clientId: 11,
      request: { refreshMode: "active-recent" },
      snapshot,
    });
    if (full.kind !== "full" || activeRecent.kind !== "full") {
      throw new Error("Expected independent full baselines");
    }

    expect(transport.encode({
      baseRevision: full.revision,
      clientId: 11,
      request: { refreshMode: "full" },
      snapshot,
    })).toEqual({
      kind: "unchanged",
      revision: full.revision,
    });
    expect(transport.encode({
      baseRevision: activeRecent.revision,
      clientId: 11,
      request: { refreshMode: "active-recent" },
      snapshot,
    })).toEqual({
      kind: "unchanged",
      revision: activeRecent.revision,
    });
  });

  it("evicts the least recently used scope when a client exceeds its cap", () => {
    const transport = new NavigationSnapshotTransport({
      maxScopesPerClient: 2,
    });
    const snapshot = buildSnapshot([buildThread(1)]);
    const first = transport.encode({
      clientId: "federation:viewer",
      request: { filter: "first" },
      snapshot,
    });
    const second = transport.encode({
      clientId: "federation:viewer",
      request: { filter: "second" },
      snapshot,
    });
    if (first.kind !== "full" || second.kind !== "full") {
      throw new Error("Expected full baselines");
    }

    expect(transport.encode({
      baseRevision: first.revision,
      clientId: "federation:viewer",
      request: { filter: "first" },
      snapshot,
    }).kind).toBe("unchanged");
    transport.encode({
      clientId: "federation:viewer",
      request: { filter: "third" },
      snapshot,
    });

    expect(transport.encode({
      baseRevision: second.revision,
      clientId: "federation:viewer",
      request: { filter: "second" },
      snapshot,
    }).kind).toBe("full");
  });

  it("evicts the least recently used client when the transport exceeds its cap", () => {
    const transport = new NavigationSnapshotTransport({ maxClients: 2 });
    const snapshot = buildSnapshot([buildThread(1)]);
    const first = transport.encode({
      clientId: "federation:first",
      request: {},
      snapshot,
    });
    const second = transport.encode({
      clientId: "federation:second",
      request: {},
      snapshot,
    });
    if (first.kind !== "full" || second.kind !== "full") {
      throw new Error("Expected full baselines");
    }

    expect(transport.encode({
      baseRevision: first.revision,
      clientId: "federation:first",
      request: {},
      snapshot,
    }).kind).toBe("unchanged");
    transport.encode({
      clientId: "federation:third",
      request: {},
      snapshot,
    });

    expect(transport.encode({
      baseRevision: second.revision,
      clientId: "federation:second",
      request: {},
      snapshot,
    }).kind).toBe("full");
  });
});
