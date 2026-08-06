import { describe, expect, it } from "vitest";
import type {
  NavigationThreadSummary,
  PrSummary,
  ThreadSearchResponse,
  ThreadSearchResult,
} from "@pwragent/shared";
import {
  mergeAgentMatches,
  mergePrNumberMatches,
  parsePrNumberQuery,
  threadsByPrNumber,
} from "../thread-match";

function pr(number: number, title?: string): PrSummary {
  return {
    provider: "github.com",
    number,
    org: "pwrdrvr",
    repo: "PwrAgent",
    state: "pending",
    url: `https://github.com/pwrdrvr/PwrAgent/pull/${number}`,
    ...(title ? { title } : {}),
  };
}

function thread(partial: Partial<NavigationThreadSummary>): NavigationThreadSummary {
  return {
    source: "codex",
    id: "t1",
    title: "Untitled",
    linkedDirectories: [],
    ...partial,
  } as NavigationThreadSummary;
}

function response(results: ThreadSearchResult[] = []): ThreadSearchResponse {
  return {
    backend: "all",
    fetchedAt: 0,
    query: "",
    filters: {},
    contentMode: "available",
    semanticMode: "disabled",
    results,
    searchedScopes: [],
    unavailableScopes: [],
  };
}

describe("parsePrNumberQuery", () => {
  it("parses bare and #-prefixed numbers, trimming whitespace", () => {
    expect(parsePrNumberQuery("779")).toBe(779);
    expect(parsePrNumberQuery("#779")).toBe(779);
    expect(parsePrNumberQuery("  #779  ")).toBe(779);
  });

  it("rejects anything that isn't a bare PR number", () => {
    expect(parsePrNumberQuery("fix 779")).toBeNull();
    expect(parsePrNumberQuery("messaging")).toBeNull();
    expect(parsePrNumberQuery("#0")).toBeNull();
    expect(parsePrNumberQuery("")).toBeNull();
    expect(parsePrNumberQuery("12345678")).toBeNull();
  });
});

describe("threadsByPrNumber", () => {
  it("finds threads whose persisted PRs include the number", () => {
    const a = thread({ id: "a", prs: [pr(779)] });
    const b = thread({ id: "b", prs: [pr(12)] });
    const c = thread({ id: "c" });
    expect(threadsByPrNumber([a, b, c], 779)).toEqual([a]);
  });
});

describe("mergePrNumberMatches", () => {
  it("prepends a PR match for a bare PR-number query", () => {
    const t = thread({ id: "a", prs: [pr(779, "Fix the thing")] });
    const merged = mergePrNumberMatches(response(), "#779", [t]);
    expect(merged.results).toHaveLength(1);
    expect(merged.results[0].threadId).toBe("a");
    expect(merged.results[0].matchReasons[0]?.kind).toBe("pr_number_match");
    expect(merged.results[0].confidence).toBe("high");
  });

  it("returns the response untouched for non-PR queries", () => {
    const t = thread({ id: "a", prs: [pr(779)] });
    const base = response();
    expect(mergePrNumberMatches(base, "hello", [t])).toBe(base);
  });

  it("does not duplicate a thread already present in the backend results", () => {
    const t = thread({ id: "a", source: "codex", prs: [pr(779)] });
    const existing: ThreadSearchResult = {
      backend: "codex",
      threadId: "a",
      identityKey: "codex:a",
      title: "Already here",
      linkedDirectories: [],
      source: "codex",
      score: 0,
      confidence: "medium",
      matchReasons: [{ kind: "summary_match" }],
      snippets: [],
    };
    const merged = mergePrNumberMatches(response([existing]), "779", [t]);
    expect(merged.results).toHaveLength(1);
    expect(merged.results[0]).toBe(existing);
  });
});

describe("mergeAgentMatches", () => {
  const agentThread = thread({
    id: "agent-1",
    title: "You are Jeeves",
    agent: {
      name: "Jeeves",
      instructions: "Help people decide what to do next.",
      instructionLineCount: 1,
      instructionsTooLong: false,
      updatedAt: 1_000,
    },
  });

  it("prepends Agent threads when the backend search has no metadata hit", () => {
    const merged = mergeAgentMatches(response(), "Agent", [agentThread]);

    expect(merged.results).toHaveLength(1);
    expect(merged.results[0]).toMatchObject({
      threadId: "agent-1",
      confidence: "high",
      matchReasons: [{ kind: "agent_match", value: "Jeeves" }],
    });
  });

  it("deduplicates backend hits and promotes the Agent reason", () => {
    const existing: ThreadSearchResult = {
      backend: "codex",
      threadId: "agent-1",
      identityKey: "codex:agent-1",
      title: "You are Jeeves",
      linkedDirectories: [],
      source: "codex",
      score: 0.5,
      confidence: "medium",
      matchReasons: [{ kind: "title_token_overlap" }],
      snippets: [],
    };
    const merged = mergeAgentMatches(response([existing]), "Jeeves", [agentThread]);

    expect(merged.results).toHaveLength(1);
    expect(merged.results[0]?.confidence).toBe("high");
    expect(merged.results[0]?.matchReasons.map((reason) => reason.kind)).toEqual([
      "agent_match",
      "title_token_overlap",
    ]);
  });
});
