import { describe, expect, it } from "vitest";
import type { AppServerReadThreadResponse, ThreadSearchResult } from "@pwragent/shared";
import { ProviderTranscriptThreadSearchAdapter } from "../thread-search/thread-search-provider-adapters";

describe("ProviderTranscriptThreadSearchAdapter", () => {
  it("searches transcript messages through the injected provider reader", async () => {
    const adapter = new ProviderTranscriptThreadSearchAdapter(async () =>
      readThreadResponse("We discussed branch drift screenshots in this thread."),
    );

    const response = await adapter.searchContent({
      candidates: [candidate("thread-1")],
      limit: 5,
      query: "branch drift",
    });

    expect(response.results).toHaveLength(1);
    expect(response.results[0]).toMatchObject({
      threadId: "thread-1",
      matchReasons: [expect.objectContaining({ kind: "provider_content_match" })],
      snippets: [expect.objectContaining({ scope: "provider_content" })],
    });
  });

  it("reports provider read failures as unavailable scopes", async () => {
    const adapter = new ProviderTranscriptThreadSearchAdapter(async () => {
      throw new Error("provider offline");
    });

    const response = await adapter.searchContent({
      candidates: [candidate("thread-1")],
      limit: 5,
      query: "branch drift",
    });

    expect(response.results).toEqual([]);
    expect(response.unavailableScopes).toEqual([
      expect.objectContaining({
        backend: "codex",
        reason: "error",
        scope: "provider_content",
      }),
    ]);
  });
});

function candidate(threadId: string): ThreadSearchResult {
  return {
    backend: "codex",
    threadId,
    identityKey: `codex:${threadId}`,
    title: "Thread",
    linkedDirectories: [],
    source: "codex",
    score: 0,
    confidence: "low",
    matchReasons: [],
    snippets: [],
  };
}

function readThreadResponse(text: string): AppServerReadThreadResponse {
  return {
    backend: "codex",
    fetchedAt: 1_000,
    threadId: "thread-1",
    replay: {
      entries: [],
      messages: [
        {
          id: "message-1",
          role: "user",
          text,
        },
      ],
      pagination: {
        hasPreviousPage: false,
        supportsPagination: false,
      },
    },
  };
}
