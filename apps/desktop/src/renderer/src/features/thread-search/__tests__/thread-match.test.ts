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
  threadMatchesQuery,
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

describe("threadMatchesQuery", () => {
  const t = thread({
    id: "7f2f4bd1-8e7b-4d3b-92e5-0e9ef15c9c84",
    title: "Messaging bug",
    gitBranch: "fix/messaging",
    prs: [pr(779)],
    linkedDirectories: [{ id: "d", label: "PwrAgent", path: "/x", kind: "local" }],
  });

  it("matches id, title, branch, PR number (with or without #), and directory", () => {
    expect(threadMatchesQuery(t, "7f2f4bd1-8e7b")).toBe(true);
    expect(threadMatchesQuery(t, "messaging")).toBe(true);
    expect(threadMatchesQuery(t, "fix/")).toBe(true);
    expect(threadMatchesQuery(t, "779")).toBe(true);
    expect(threadMatchesQuery(t, "#779")).toBe(true);
    expect(threadMatchesQuery(t, "pwragent")).toBe(true);
  });

  it("matches common thread id shapes", () => {
    expect(
      threadMatchesQuery(
        thread({ id: "bd3381bd-d3a2-458c-9a9b-69819930354f" }),
        "bd3381bd",
      ),
    ).toBe(true);
    expect(
      threadMatchesQuery(
        thread({ id: "session_e31f5e66-7410-4235-aa19-3bbb63ee8c3d" }),
        "session_e31f5e66",
      ),
    ).toBe(true);
    expect(
      threadMatchesQuery(
        thread({ id: "session_e31f5e66-7410-4235-aa19-3bbb63ee8c3d" }),
        "e31f5e66",
      ),
    ).toBe(true);
    expect(
      threadMatchesQuery(
        thread({ id: "019f23aa-7673-7950-b077-107f5bf4777c" }),
        "019f23aa",
      ),
    ).toBe(true);
  });

  it("does not match short accidental thread id fragments", () => {
    const idOnly = thread({
      id: "bd3381bd-d3a2-458c-9a9b-69819930354f",
      title: "Echo",
      gitBranch: undefined,
      prs: [],
      linkedDirectories: [],
    });
    const sessionIdOnly = thread({
      id: "session_e31f5e66-7410-4235-aa19-3bbb63ee8c3d",
      title: "Echo",
      gitBranch: undefined,
      prs: [],
      linkedDirectories: [],
    });

    expect(threadMatchesQuery(idOnly, "b")).toBe(false);
    expect(threadMatchesQuery(idOnly, "1")).toBe(false);
    expect(threadMatchesQuery(sessionIdOnly, "session_")).toBe(false);
  });

  it("returns false for non-matches and empty queries", () => {
    expect(threadMatchesQuery(t, "zzz")).toBe(false);
    expect(threadMatchesQuery(t, "   ")).toBe(false);
  });

  it("matches Agent role, persona name, and instructions only for Agent threads", () => {
    const agentThread = thread({
      title: "Housekeeping",
      agent: {
        name: "Jeeves",
        instructions: "Help people decide what to do next.",
        instructionLineCount: 1,
        instructionsTooLong: false,
        updatedAt: 1_000,
      },
    });

    expect(threadMatchesQuery(agentThread, "Agent")).toBe(true);
    expect(threadMatchesQuery(agentThread, "jeeves")).toBe(true);
    expect(threadMatchesQuery(agentThread, "decide next")).toBe(true);
    expect(threadMatchesQuery(thread({ title: "Housekeeping" }), "Agent")).toBe(
      false,
    );
  });
});
