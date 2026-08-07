import { describe, expect, it } from "vitest";
import type { NavigationThreadSummary, PrSummary } from "../index";
import {
  threadHasExactPrNumberMatch,
  threadMatchesQuery,
} from "../thread-jump-match";

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

  it("matches every attached PR and identifies an exact PR query", () => {
    const stacked = thread({
      prs: [pr(44), pr(45), pr(46), pr(48), pr(49)],
    });

    expect(threadMatchesQuery(stacked, "49")).toBe(true);
    expect(threadMatchesQuery(stacked, "#49")).toBe(true);
    expect(threadHasExactPrNumberMatch(stacked, "49")).toBe(true);
    expect(threadHasExactPrNumberMatch(stacked, "#49")).toBe(true);
    expect(threadHasExactPrNumberMatch(stacked, "4")).toBe(false);
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
