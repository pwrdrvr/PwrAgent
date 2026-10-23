import { describe, expect, it, vi } from "vitest";
import type { ThreadSearchResponse } from "@pwragent/shared";
import { OwnerContentSearch } from "../thread-search/owner-content-search";
import { ProviderTranscriptThreadSearchAdapter } from "../thread-search/thread-search-provider-adapters";

describe("owner content search", () => {
  it("binds cancellation to the authenticated requester and stops subsequent transcript reads", async () => {
    const read = Promise.withResolvers<never>();
    const reader = vi.fn(async () => await read.promise);
    const adapter = new ProviderTranscriptThreadSearchAdapter(reader);
    const owner = new OwnerContentSearch(async (_request, signal) => {
      await adapter.searchContent({ query: "DKIM", limit: 25, signal,
        candidates: ["one", "two"].map((threadId) => ({ backend: "acp:grok", source: "acp:grok", threadId,
          identityKey: threadId, title: "Audit", linkedDirectories: [], score: 0,
          confidence: "low", matchReasons: [], snippets: [] })) });
      throw new Error("Should have cancelled");
    });
    const running = owner.run({ searchId: "search", request: { query: "DKIM" } }, { requesterInstanceId: "viewer" });
    owner.cancel("search", { requesterInstanceId: "another-viewer" });
    expect(reader).toHaveBeenCalledOnce();
    owner.cancel("search", { requesterInstanceId: "viewer" });
    await expect(running).rejects.toThrow("Content search cancelled");
    read.reject(new Error("Read finished"));
    expect(reader).toHaveBeenCalledOnce();
  });

  it("releases timed-out owner searches even when the provider read never settles", async () => {
    vi.useFakeTimers();
    try {
      const search = vi.fn(async (): Promise<ThreadSearchResponse> => await new Promise(() => {}));
      const owner = new OwnerContentSearch(search);
      const request = { searchId: "search", request: { query: "DKIM" } };
      const options = { requesterInstanceId: "viewer", deadlineAt: Date.now() + 50 };
      const result = expect(owner.run(request, options)).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(50);
      await result;
      search.mockRejectedValueOnce(new Error("Next search"));
      await expect(owner.run(request, { requesterInstanceId: "viewer" })).rejects.toThrow("Next search");
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects unauthenticated, invalid, and duplicate search ids", async () => {
    const result = Promise.withResolvers<ThreadSearchResponse>();
    const owner = new OwnerContentSearch(async () => await result.promise);
    const request = { searchId: "search", request: {} };
    await expect(owner.run(request)).rejects.toThrow("authenticated requester");
    await expect(owner.run({ ...request, searchId: "" }, { requesterInstanceId: "viewer" })).rejects.toThrow("Invalid content search id");
    const running = owner.run(request, { requesterInstanceId: "viewer" });
    await expect(owner.run(request, { requesterInstanceId: "viewer" })).rejects.toThrow("already running");
    result.reject(new Error("Finished"));
    await expect(running).rejects.toThrow("Finished");
  });
});
