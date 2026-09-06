import { describe, expect, it, vi } from "vitest";
import type { FederationProtocolEnvelope, NavigationSnapshot } from "@pwragent/shared";
import {
  FEDERATION_BACKEND_METHOD_CAPABILITIES,
  registerFederationBackendHandlers,
  type FederationBackendOperations,
} from "../federation/federation-backend-bridge";
import { FederationRouter } from "../federation/federation-router";
import {
  FEDERATION_COLLECTION_PAGE_BYTES,
  projectFederationArchivedThreads,
  projectFederationProjectPage,
  partitionFederationCollection,
} from "../federation/federation-collection-reads";
import {
  lookupFederationArchivedThreads,
  readFederationProjectSnapshot,
} from "../federation/federation-collection-client";

function snapshot(): NavigationSnapshot {
  return {
    backend: "all", fetchedAt: 100, unchanged: false,
    threads: [], inboxThreadKeys: [], directories: [],
    launchpadDefaults: { backend: "codex", executionMode: "default" },
  };
}

async function request(
  backend: FederationBackendOperations,
  method: string,
  params: unknown,
  deadlineAt?: number,
) {
  const replies: FederationProtocolEnvelope[] = [];
  const router = new FederationRouter({
    localInstanceId: "owner", methodCapabilities: FEDERATION_BACKEND_METHOD_CAPABILITIES,
  });
  router.registerConnection({
    peerId: "viewer", capabilities: ["thread_navigation"],
    sendEnvelope: (envelope) => replies.push(envelope),
  });
  registerFederationBackendHandlers({ router, backend });
  await router.routeEnvelope({
    sourcePeerId: "viewer",
    envelope: {
      kind: "request", id: "request", method, params, protocolVersion: 1,
      sourceInstanceId: "viewer", targetInstanceId: "owner", createdAt: 100,
      deadlineAt,
    },
  });
  return replies[0];
}

describe("bounded Federation collection reads", () => {
  it("binds navigation cursors to the authenticated requester", async () => {
    const getNavigationQueryPage = vi.fn(async () => ({
      protocol: 2 as const,
      queryKey: "query",
      generation: "generation",
      ownerEpoch: "epoch",
      countsRevision: "counts",
      coverage: { state: "complete" as const },
      counts: { total: 0, active: 0, unread: 0, review: 0 },
      entries: [],
      complete: true,
    }));
    const backend = {
      getNavigationQueryPage,
    } as unknown as FederationBackendOperations;
    const deadlineAt = Date.now() + 5_000;
    const query = {
      protocol: 2 as const,
      consumer: "main-sidebar" as const,
      query: { kind: "lens" as const, lens: "inbox" as const },
    };
    const reply = await request(
      backend,
      "backend.getNavigationQueryPage",
      query,
      deadlineAt,
    );

    expect(reply).toMatchObject({ kind: "response", result: { complete: true } });
    expect(getNavigationQueryPage).toHaveBeenCalledWith(query, {
      deadlineAt,
      requesterInstanceId: "viewer",
    });
  });

  it("passes the original relay deadline to owner collection operations", async () => {
    const getProjectPage = vi.fn(async () => ({ ...snapshot(), directories: [] }));
    const lookupArchivedThreads = vi.fn(async () => ({ threads: [] }));
    const backend = { getProjectPage, lookupArchivedThreads } as unknown as FederationBackendOperations;
    const deadlineAt = Date.now() + 5000;
    await request(backend, "backend.getProjectPage", {}, deadlineAt);
    await request(backend, "backend.lookupArchivedThreads", {
      backend: "codex", threadIds: ["thread"],
    }, deadlineAt);
    expect(getProjectPage).toHaveBeenCalledWith({}, { deadlineAt });
    expect(lookupArchivedThreads).toHaveBeenCalledWith({
      backend: "codex", threadIds: ["thread"],
    }, { deadlineAt });
  });

  it("partitions merge notifications without dropping entries or tombstones", () => {
    const entries = Array.from({ length: 10_000 }, (_, index) => ({
      key: `key-${index}`, dx: index % 2 ? null : index, label: "日".repeat(100),
    }));
    const pages = partitionFederationCollection(entries);
    expect(pages.flat()).toEqual(entries);
    for (const page of pages) {
      expect(page.length).toBeLessThanOrEqual(100);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(FEDERATION_COLLECTION_PAGE_BYTES - 4096);
    }
    expect(partitionFederationCollection([])).toEqual([]);
    expect(() => partitionFederationCollection(["x".repeat(FEDERATION_COLLECTION_PAGE_BYTES)])).toThrow("exceeds");
  });
  it("project RPC excludes thread rows and directory memberships before transport", async () => {
    const huge = "private transcript".repeat(100_000);
    const value = {
      ...snapshot(),
      threads: [{ id: "not-requested", turns: huge }],
      directories: [{ key: "project", kind: "directory", label: "Project", threadKeys: [huge], needsAttentionCount: 0 }],
    };
    const backend = { getNavigationSnapshot: vi.fn(async () => value) } as unknown as FederationBackendOperations;
    const reply = await request(backend, "backend.getProjectPage", { projectKey: "project" });
    expect(reply).toMatchObject({ kind: "response", result: { directories: [{ key: "project", threadKeys: [] }] } });
    expect(JSON.stringify(reply)).not.toContain("private transcript");
    expect(Buffer.byteLength(JSON.stringify(reply))).toBeLessThan(2000);
  });

  it("pages projects with stable keys and explicit row and UTF-8 byte bounds", () => {
    const value = snapshot();
    value.directories = Array.from({ length: 250 }, (_, index) => ({
      key: `project-${String(index).padStart(3, "0")}`, kind: "directory", label: "日本語".repeat(1000),
      threadKeys: [], needsAttentionCount: 0,
    }));
    const keys: string[] = [];
    let afterKey: string | undefined;
    do {
      const page = projectFederationProjectPage(value, { afterKey });
      expect(page.directories.length).toBeLessThanOrEqual(100);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(FEDERATION_COLLECTION_PAGE_BYTES);
      keys.push(...page.directories.map((directory) => directory.key));
      afterKey = page.nextAfterKey;
    } while (afterKey);
    expect(keys).toEqual(value.directories.map((directory) => directory.key));
  });

  it("fails explicitly when one project cannot fit rather than looping or omitting it", () => {
    const value = snapshot();
    value.directories = [{ key: "large", kind: "directory", label: "x".repeat(FEDERATION_COLLECTION_PAGE_BYTES), threadKeys: [], needsAttentionCount: 0 }];
    expect(() => projectFederationProjectPage(value, {})).toThrow("One project exceeds");
  });

  it("archive RPC sends only selected exact IDs from a large owner collection", async () => {
    const threads = Array.from({ length: 10_000 }, (_, index) => ({
      id: `thread-${index}`, source: "codex" as const, title: "Title", titleSource: "native" as const,
      linkedDirectories: [], turns: [{ text: "private turns must not cross this boundary" }],
    }));
    const backend = { listThreads: vi.fn(async () => ({ threads })) } as unknown as FederationBackendOperations;
    const reply = await request(backend, "backend.lookupArchivedThreads", { backend: "codex", threadIds: ["thread-9999"] });
    expect(reply).toMatchObject({ kind: "response", result: { threads: [{ id: "thread-9999" }] } });
    expect(JSON.stringify(reply)).not.toContain("private turns");
    expect(Buffer.byteLength(JSON.stringify(reply))).toBeLessThan(1000);
  });

  it("rejects overlarge ID selections before walking the owner collection", async () => {
    const listThreads = vi.fn();
    const reply = await request({ listThreads } as unknown as FederationBackendOperations,
      "backend.lookupArchivedThreads", { backend: "codex", threadIds: Array.from({ length: 101 }, (_, i) => String(i)) });
    expect(reply).toMatchObject({ kind: "error" });
    expect(listThreads).not.toHaveBeenCalled();
    expect(projectFederationArchivedThreads([], { backend: "codex", threadIds: [] })).toEqual({ threads: [] });
  });

  it("project consumers page metadata only and share an absolute deadline", async () => {
    const getProjectPage = vi.fn()
      .mockResolvedValueOnce({ ...snapshot(), nextAfterKey: "a" })
      .mockResolvedValueOnce(snapshot());
    const getNavigationSnapshot = vi.fn();
    await readFederationProjectSnapshot({ getProjectPage, getNavigationSnapshot } as unknown as FederationBackendOperations);
    expect(getNavigationSnapshot).not.toHaveBeenCalled();
    expect(getProjectPage.mock.calls[1]![0]).toEqual({ projectKey: undefined, afterKey: "a" });
    expect(getProjectPage.mock.calls[1]![1]).toEqual(getProjectPage.mock.calls[0]![1]);
  });

  it("batches exact archive proofs without downloading the legacy archive", async () => {
    const lookupArchivedThreads = vi.fn(async () => ({ threads: [] }));
    const listThreads = vi.fn();
    await lookupFederationArchivedThreads({ lookupArchivedThreads, listThreads } as unknown as FederationBackendOperations,
      "codex", Array.from({ length: 201 }, (_, index) => `thread-${index}`));
    expect(lookupArchivedThreads.mock.calls.map((call) => (call as unknown as [{ threadIds: string[] }])[0].threadIds.length)).toEqual([100, 100, 1]);
    expect(listThreads).not.toHaveBeenCalled();
  });

  it("does not widen timeout or authorization failures into full collection reads", async () => {
    for (const code of ["deadline_exceeded", "capability_denied"]) {
      const error = Object.assign(new Error(code), { code });
      const legacy = vi.fn();
      const backend = {
        getProjectPage: vi.fn().mockRejectedValue(error), lookupArchivedThreads: vi.fn().mockRejectedValue(error),
        getNavigationSnapshot: legacy, listThreads: legacy,
      } as unknown as FederationBackendOperations;
      await expect(readFederationProjectSnapshot(backend)).rejects.toThrow(code);
      await expect(lookupFederationArchivedThreads(backend, "codex", ["one"])).rejects.toThrow(code);
      expect(legacy).not.toHaveBeenCalled();
    }
  });
});
