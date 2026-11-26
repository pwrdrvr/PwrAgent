import { expect, it, vi } from "vitest";
import type { AppServerThreadSummary } from "@pwragent/shared/contracts/normalized-app-server";
import type { ThreadSearchResponse } from "@pwragent/shared/contracts/thread-search";
import { searchFederatedContent } from "../federation/federated-content-search-service";
import { ThreadSearchStore } from "../storage/thread-search-store";
import { ProviderTranscriptThreadSearchAdapter } from "../thread-search/thread-search-provider-adapters";
import { ThreadSearchService } from "../thread-search/thread-search-service";
import { openInMemoryStateDb } from "./sqlite-test-utils";

function thread(id: string, title: string, updatedAt: number): AppServerThreadSummary {
  return { id, title, updatedAt, source: "codex", titleSource: "explicit", linkedDirectories: [] };
}

it.each([0, 2])("keeps the recent transcript candidates after %i exact projection matches", async (exactCount) => {
  const db = openInMemoryStateDb();
  try {
    const exact = Array.from({ length: exactCount }, (_, index) => thread(`exact-${index}`, "Orchard willow", 30 - index));
    const weak = Array.from({ length: 25 }, (_, index) => thread(`weak-${index}`, "Orchard", 70 - index));
    const recent = Array.from({ length: 50 }, (_, index) => thread(`recent-${index}`, "Project notes", 150 - index));
    const expectedReads = [...exact, ...recent].slice(0, 50).map(({ id }) => id);
    const target = expectedReads.at(-1);
    const read = vi.fn(async ({ threadId }: { threadId: string }) => ({
      backend: "codex" as const, threadId, fetchedAt: 1,
      replay: {
        entries: [],
        messages: [{ id: "message", role: "user" as const, text: threadId === target ? "Orchard willow" : "Different subject" }],
        pagination: { supportsPagination: false, hasPreviousPage: false },
      },
    }));
    const service = new ThreadSearchService(new ThreadSearchStore(db),
      async () => [...weak, ...exact, ...recent], new ProviderTranscriptThreadSearchAdapter(read));
    const result = await service.search({ query: "orchard willow", limit: 25 });
    expect(read.mock.calls.map(([{ threadId }]) => threadId)).toEqual(expectedReads);
    expect(result.results[0]?.threadId).toBe(target);
    expect(result.results[0]?.matchReasons).toContainEqual(expect.objectContaining({ kind: "provider_content_match" }));
  } finally {
    db.close();
  }
});

it("keeps legacy exact hits ahead of relaxed hits in every mixed-owner page", async () => {
  const db = openInMemoryStateDb();
  try {
    const threads = [
      thread("partial", "Orchard", 90),
      ...Array.from({ length: 8 }, (_, index) => thread(`other-${index}`, "Project notes", index)),
    ];
    const service = new ThreadSearchService(new ThreadSearchStore(db), async () => threads);
    const legacyResult: ThreadSearchResponse["results"][number] = {
      backend: "codex", source: "codex", threadId: "legacy-exact", identityKey: "codex:legacy-exact",
      title: "Orchard willow", updatedAt: 1, linkedDirectories: [], score: 0.000002,
      confidence: "medium", matchReasons: [{ kind: "summary_match" }], snippets: [],
    };
    for (const limit of [1, 2]) {
      const request = { query: "orchard willow", limit, contentMode: "metadata" as const };
      const local = await service.search(request);
      expect(local.results.map(({ threadId }) => threadId)).toEqual(["partial"]);
      const legacy = { ...local, results: [legacyResult] };
      const onProgress = vi.fn<(response: ThreadSearchResponse) => void>();
      const result = await searchFederatedContent({
        request, local: async () => local, onProgress,
        peers: [{
          instanceId: "old", label: "Old owner",
          backend: { searchThreadContent: async () => legacy, cancelThreadContentSearch: async () => {} },
        }],
      });
      const expected = ["legacy-exact", "partial"].slice(0, limit);
      expect(result.results.map(({ threadId }) => threadId)).toEqual(expected);
      expect(onProgress.mock.lastCall?.[0].results.map(({ threadId }) => threadId)).toEqual(expected);
    }
  } finally {
    db.close();
  }
});
