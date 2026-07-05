import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AppServerReadThreadResponse,
  AppServerThreadSummary,
} from "@pwragent/shared";
import { StateDb } from "../state/state-db";
import { ProviderTranscriptThreadSearchAdapter } from "../thread-search/thread-search-provider-adapters";
import { ThreadSearchService } from "../thread-search/thread-search-service";
import { ThreadSearchStore } from "../thread-search/thread-search-store";

let stateDb: StateDb;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(
    path.join(os.tmpdir(), "pwragent-thread-search-service-"),
  );
  stateDb = StateDb.open(path.join(tempDir, "state.db"));
});

afterEach(() => {
  stateDb.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("ThreadSearchService", () => {
  it("hydrates projections from thread summaries and searches them", async () => {
    const service = buildService([
      threadSummary({ id: "thread-1", title: "Branch drift dialog" }),
      threadSummary({
        id: "thread-2",
        title: "Release notes",
        summary: "Prepared beta release notes",
      }),
    ]);

    const response = await service.search({ query: "branch drift" });

    expect(response.results.map((result) => result.threadId)).toEqual([
      "thread-1",
    ]);
    expect(response.searchedScopes).toEqual(["metadata", "projection"]);
    expect(response.unavailableScopes).toEqual([
      expect.objectContaining({
        scope: "provider_content",
        reason: "unsupported",
      }),
    ]);
  });

  it("applies project filters after projection search", async () => {
    const service = buildService([
      threadSummary({ id: "pwragent", projectKey: "PwrAgent" }),
      threadSummary({ id: "docs", projectKey: "Docs" }),
    ]);

    const response = await service.search({
      filters: { projectKeys: ["Docs"] },
      query: "branch",
    });

    expect(response.results.map((result) => result.threadId)).toEqual(["docs"]);
  });

  it("does not drop filtered matches behind unfiltered limit results", async () => {
    const service = buildService([
      threadSummary({
        id: "pwragent",
        projectKey: "PwrAgent",
        title: "Branch drift in PwrAgent",
        updatedAt: 3_000,
      }),
      threadSummary({
        id: "docs",
        projectKey: "Docs",
        title: "Branch drift in docs",
        updatedAt: 1_000,
      }),
    ]);

    const response = await service.search({
      filters: { projectKeys: ["Docs"] },
      limit: 1,
      query: "branch drift",
    });

    expect(response.results.map((result) => result.threadId)).toEqual(["docs"]);
  });

  it("prunes stale active projection rows after refreshing provider threads", async () => {
    const store = new ThreadSearchStore(stateDb);
    store.upsertThread(
      threadSummary({ id: "stale", title: "Stale branch drift" }),
    );
    const service = new ThreadSearchService(store, async () => [
      threadSummary({ id: "active", title: "Active branch drift" }),
    ]);

    const response = await service.search({ query: "branch drift" });

    expect(response.results.map((result) => result.threadId)).toEqual([
      "active",
    ]);
    expect(
      store
        .search({ query: "branch drift", limit: 10 })
        .map((result) => result.threadId),
    ).toEqual(["active"]);
  });

  it("hydrates active and archived threads when archived results are included", async () => {
    const listThreads = vi.fn(
      async (request: {
        archived?: boolean;
      }): Promise<AppServerThreadSummary[]> =>
        request.archived
          ? [
              threadSummary({
                id: "archived",
                archivedAt: 2_000,
                title: "Archived branch drift notes",
                updatedAt: 2_000,
              }),
            ]
          : [
              threadSummary({
                id: "active",
                title: "Active branch drift notes",
                updatedAt: 3_000,
              }),
            ],
    );
    const service = new ThreadSearchService(
      new ThreadSearchStore(stateDb),
      listThreads,
    );

    const response = await service.search({
      filters: { includeArchived: true },
      query: "branch drift",
    });

    expect(response.results.map((result) => result.threadId)).toEqual([
      "active",
      "archived",
    ]);
    expect(listThreads).toHaveBeenCalledWith({
      archived: false,
      backend: undefined,
    });
    expect(listThreads).toHaveBeenCalledWith({
      archived: true,
      backend: undefined,
    });
  });

  it("reports semantic search as disabled when requested", async () => {
    const service = buildService([threadSummary({ id: "thread-1" })]);

    const response = await service.search({ semanticMode: "required" });

    expect(response.unavailableScopes).toContainEqual(
      expect.objectContaining({ scope: "semantic", reason: "disabled" }),
    );
  });

  it("uses provider transcripts for bounded recent candidates", async () => {
    const service = buildService(
      [
        threadSummary({
          id: "thread-1",
          title: "Release notes",
          summary: "Prepared beta release notes",
        }),
      ],
      "We talked about local vector models for thread search.",
    );

    const response = await service.search({ query: "vector models" });

    expect(response.results.map((result) => result.threadId)).toEqual([
      "thread-1",
    ]);
    expect(response.results[0]?.matchReasons).toContainEqual(
      expect.objectContaining({ kind: "provider_content_match" }),
    );
    expect(response.unavailableScopes).not.toContainEqual(
      expect.objectContaining({
        scope: "provider_content",
        reason: "unsupported",
      }),
    );
  });
});

function buildService(
  threads: AppServerThreadSummary[],
  transcriptText?: string,
): ThreadSearchService {
  return new ThreadSearchService(
    new ThreadSearchStore(stateDb),
    async () => threads,
    transcriptText
      ? new ProviderTranscriptThreadSearchAdapter(async () =>
          readThreadResponse(transcriptText),
        )
      : undefined,
  );
}

function threadSummary(
  overrides: Partial<AppServerThreadSummary>,
): AppServerThreadSummary {
  return {
    id: "thread",
    title: "Thread",
    titleSource: "derived",
    summary: "Asked about branch drift dialog screenshots",
    projectKey: "PwrAgent",
    createdAt: 1_000,
    updatedAt: 1_000,
    linkedDirectories: [
      {
        id: "dir-1",
        label: "PwrAgent",
        path: "/repo/PwrAgent",
        kind: "local",
      },
    ],
    source: "codex",
    gitBranch: "feat/branch-drift",
    model: "gpt-5.5",
    ...overrides,
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
