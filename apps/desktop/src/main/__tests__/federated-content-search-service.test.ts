import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppServerBackendKind, ThreadSearchRequest, ThreadSearchResponse } from "@pwragent/shared";
import { searchFederatedContent, type ContentSearchPeer } from "../federation/federated-content-search-service";
import { OwnerContentSearch } from "../thread-search/owner-content-search";
import { ProviderTranscriptThreadSearchAdapter } from "../thread-search/thread-search-provider-adapters";
import { ThreadSearchService } from "../thread-search/thread-search-service";
import { ThreadSearchStore } from "../thread-search/thread-search-store";
import { StateDb } from "../state/state-db";
import { openInMemoryStateDb, createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";

const databases: StateDb[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); vi.unstubAllEnvs(); });

function response(results: ThreadSearchResponse["results"] = []): ThreadSearchResponse {
  return { backend: "all", fetchedAt: 1, query: "DKIM", filters: {}, contentMode: "available",
    semanticMode: "disabled", results, searchedScopes: ["metadata", "provider_content"], unavailableScopes: [] };
}

function peer(instanceId: string, search = vi.fn(async () => response())): ContentSearchPeer {
  return { instanceId, label: instanceId, backend: { searchThreadContent: search,
    cancelThreadContentSearch: vi.fn(async () => {}) } };
}

describe("federated content search", () => {
  it.each<AppServerBackendKind>(["codex", "claude", "acp:grok", "acp:gemini"])(
    "finds a remote %s transcript match with unrelated metadata", async (backend) => {
      const db = openInMemoryStateDb();
      databases.push(db);
      const read = vi.fn(async () => ({ backend, threadId: "audit", fetchedAt: 1,
        replay: { messages: [{ id: "message", role: "user" as const, text: "Check DKIM and DMARC" }],
          entries: [{ type: "message" as const, id: "message", role: "user" as const,
            text: "Check DKIM and DMARC", turn: { id: "turn-audit" } }],
          pagination: { supportsPagination: false, hasPreviousPage: false } } }));
      const service = new ThreadSearchService(new ThreadSearchStore(db), async () => [{
        id: "audit", source: backend, title: "Audit example.com against a tweet", titleSource: "explicit", linkedDirectories: [],
      }], new ProviderTranscriptThreadSearchAdapter(read));
      const owner = new OwnerContentSearch(async (request, signal) => await service.search(request, signal));
      const remote = peer("owner");
      remote.backend.searchThreadContent = async (request, options) => await owner.run(request,
        { ...options, requesterInstanceId: "viewer" });
      const result = await searchFederatedContent({ request: { query: "DKIM" },
        local: async () => response(), peers: [remote] });
      expect(result.results).toHaveLength(1);
      expect(result.results[0]).toMatchObject({ backend, threadId: "audit",
        matchReasons: [expect.objectContaining({ kind: "provider_content_match" })],
        snippets: [expect.objectContaining({ text: "Check DKIM and DMARC", turnId: "turn-audit" })],
        federation: { ref: { target: { scope: "remote", instanceId: "owner" } } } });
      expect(read).toHaveBeenCalledWith({ backend, threadId: "audit", limit: 80 });
    },
  );

  it("publishes a fast owner's results before a slow local search or another peer finishes", async () => {
    const local = Promise.withResolvers<ThreadSearchResponse>();
    const slow = Promise.withResolvers<ThreadSearchResponse>();
    const onProgress = vi.fn();
    const fast = response([{ backend: "acp:grok", source: "acp:grok", threadId: "audit", identityKey: "audit",
      title: "Audit example.com", linkedDirectories: [], score: 25, confidence: "medium",
      matchReasons: [{ kind: "provider_content_match" }], snippets: [{ scope: "provider_content", text: "DKIM" }] }]);
    const search = searchFederatedContent({ request: { query: "DKIM" }, local: async () => await local.promise,
      peers: [peer("fast", vi.fn(async () => fast)), peer("slow", vi.fn(async () => await slow.promise))], onProgress });
    await vi.waitFor(() => expect(onProgress).toHaveBeenCalled());
    expect(onProgress.mock.calls[0][0].results).toEqual([
      expect.objectContaining({ threadId: "audit", federation: expect.objectContaining({ instanceLabel: "fast" }) }),
    ]);
    expect(onProgress.mock.calls[0][0].remoteInstances).toEqual([
      { instanceId: "fast", instanceLabel: "fast", resultCount: 1 },
      { instanceId: "slow", instanceLabel: "slow", resultCount: 0, searching: true },
    ]);
    local.resolve(response());
    slow.resolve(response());
    expect((await search).remoteInstances?.every((instance) => !instance.searching)).toBe(true);
  });

  it("forwards the complete search request and preserves remote truncation and content errors", async () => {
    const request: ThreadSearchRequest = { query: "DKIM @example", contentMode: "required", limit: 1,
      filters: { backend: "acp:grok", includeArchived: true, models: ["grok"], projectKeys: ["example"],
        directoryPaths: ["/example"], dateRange: { from: 1, to: 100 } } };
    const search = vi.fn(async () => ({ ...response(), truncated: true,
      unavailableScopes: [{ scope: "provider_content" as const, reason: "error" as const, message: "Missing replay" }] }));
    const result = await searchFederatedContent({ request, local: async () => response(), peers: [peer("remote", search)] });
    expect(search).toHaveBeenCalledWith({ searchId: expect.any(String), request },
      expect.objectContaining({ deadlineAt: expect.any(Number) }));
    expect(result.truncated).toBe(true);
    expect(result.unavailableScopes).toContainEqual(expect.objectContaining({ message: "remote: Missing replay" }));
  });

  it("reports an old peer and a local failure while retaining healthy peer results", async () => {
    const old = peer("old", vi.fn(async () => { throw Object.assign(new Error("Unknown method"), { code: "method_not_found" }); }));
    const result = await searchFederatedContent({ request: { query: "DKIM" },
      local: async () => { throw new Error("Local unavailable"); }, peers: [old, peer("healthy")] });
    expect(result.remoteInstances).toEqual([
      expect.objectContaining({ instanceId: "old", failed: true, error: expect.stringContaining("Update PwrAgent") }),
      expect.objectContaining({ instanceId: "healthy", resultCount: 0 }),
    ]);
    expect(result.unavailableScopes).toHaveLength(2);
  });

  it("cancels owner work and stops publishing when the viewer cancels", async () => {
    const controller = new AbortController();
    const remote = peer("remote");
    remote.backend.searchThreadContent = async (_request, options) => await new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true });
    });
    const onProgress = vi.fn();
    const search = searchFederatedContent({ request: { query: "DKIM" }, signal: controller.signal,
      local: async () => response(), peers: [remote], onProgress });
    controller.abort(new Error("Stopped"));
    await expect(search).rejects.toThrow("Stopped");
    expect(remote.backend.cancelThreadContentSearch).toHaveBeenCalledWith({ searchId: expect.any(String) });
    expect(onProgress).not.toHaveBeenCalled();
  });

  it("records the existing metadata projection write cost of an owner search", async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const { dbPath, tempDir } = createTempStateDb("owner-content-search-");
    const db = StateDb.open(dbPath);
    try {
      const service = new ThreadSearchService(new ThreadSearchStore(db), async () => [
        { id: "audit", source: "acp:grok", title: "Audit example.com", titleSource: "explicit", linkedDirectories: [] },
      ], new ProviderTranscriptThreadSearchAdapter(async () => ({ backend: "acp:grok", threadId: "audit", fetchedAt: 1,
        replay: { messages: [], entries: [], pagination: { supportsPagination: false, hasPreviousPage: false } } })));
      const owner = new OwnerContentSearch(async (request, signal) => await service.search(request, signal));
      const { writes } = await measureSqliteWrites(async () => await owner.run(
        { searchId: "budget", request: { query: "DKIM" } }, { requesterInstanceId: "viewer" }));
      expect(writes.commits).toBeGreaterThan(0);
      expect(writes.walBytes).toBeGreaterThan(0);
      expectSqliteWriteBudget({ scenario: "owner-content-search", writes,
        note: "First owner query with one known thread: one batched metadata commit (~37 KB); 20 equivalent cold batches/day project ~0.74 MB/day per owner, unchanged repeats and idle add 0 MB/day. No transcript index." });
      const repeated = await measureSqliteWrites(async () => {
        for (let index = 0; index < 20; index += 1) {
          await owner.run({ searchId: `repeat-${index}`, request: { query: "DKIM" } }, { requesterInstanceId: "viewer" });
        }
      });
      expectSqliteWriteBudget({ scenario: "owner-content-search-unchanged", writes: repeated.writes,
        note: "20 repeated owner searches with unchanged metadata: zero commits and 0 MB/day at 20 searches/day; transcript reads add no search persistence." });
    } finally {
      db.close();
      removeTempStateDbDir(tempDir);
    }
  });
});
