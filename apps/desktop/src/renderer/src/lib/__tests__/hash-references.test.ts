import { describe, expect, it } from "vitest";
import type { NavigationThreadSummary, PrSummary } from "@pwragent/shared";
import {
  filterHashReferenceCandidates,
  findHashReferenceTrigger,
} from "../hash-references";

function pullRequest(
  number: number,
  repo = "PwrAgent",
): PrSummary {
  return {
    provider: "github.com",
    org: "pwrdrvr",
    repo,
    number,
    state: "unknown",
    url: `https://github.com/pwrdrvr/${repo}/pull/${number}`,
  };
}

function thread(
  id: string,
  title: string,
  options: Partial<NavigationThreadSummary> = {},
): NavigationThreadSummary {
  return {
    id,
    title,
    titleSource: "explicit",
    source: "codex",
    linkedDirectories: [],
    inbox: { unread: false },
    ...options,
  } as NavigationThreadSummary;
}

describe("findHashReferenceTrigger", () => {
  it("matches a channel-style query with spaces", () => {
    const draft = "Ask #Bob's Best Thread";
    expect(findHashReferenceTrigger(draft, draft.length)).toEqual({
      start: 4,
      end: draft.length,
      query: "Bob's Best Thread",
    });
  });

  it("does not treat an embedded hash or a previous line as the trigger", () => {
    expect(findHashReferenceTrigger("repo#123", 8)).toBeUndefined();
    expect(findHashReferenceTrigger("#first\nplain", 12)).toBeUndefined();
  });

  it("ends a numeric PR reference at the first whitespace", () => {
    const activeDraft = "Check PR #1349";
    expect(findHashReferenceTrigger(activeDraft, activeDraft.length)).toEqual({
      start: 9,
      end: activeDraft.length,
      query: "1349",
    });

    expect(findHashReferenceTrigger("Check PR #1349 ", 15)).toBeUndefined();
    const continuingDraft = "Check PR #1349 before merging";
    expect(
      findHashReferenceTrigger(continuingDraft, continuingDraft.length),
    ).toBeUndefined();
  });
});

describe("filterHashReferenceCandidates", () => {
  it("uses Cmd+K matching for names and orders recent empty-query threads", () => {
    const candidates = filterHashReferenceCandidates([
      thread("older", "Bob's Best Thread 3000", { updatedAt: 10 }),
      thread("newer", "Another thread", { updatedAt: 20 }),
    ], "Bob's Best");
    expect(candidates.threads.map((candidate) => candidate.id)).toEqual(["older"]);
    expect(candidates.pullRequests).toEqual([]);

    const recent = filterHashReferenceCandidates([
      thread("older", "Older", { updatedAt: 10 }),
      thread("newer", "Newer", { updatedAt: 20 }),
    ], "");
    expect(recent.threads.map((candidate) => candidate.id)).toEqual([
      "newer",
      "older",
    ]);
  });

  it("shows threads and one deduplicated PR choice for a numeric query", () => {
    const pr = pullRequest(123);
    const candidates = filterHashReferenceCandidates([
      thread("first", "Implement it", { prs: [pr] }),
      thread("second", "Review it", { prs: [pr] }),
      thread("other", "Other repository", { prs: [pullRequest(123, "PwrSnap")] }),
    ], "123");

    expect(candidates.threads.map((candidate) => candidate.id)).toEqual([
      "first",
      "second",
      "other",
    ]);
    expect(candidates.pullRequests.map((candidate) => candidate.url)).toEqual([
      "https://github.com/pwrdrvr/PwrAgent/pull/123",
      "https://github.com/pwrdrvr/PwrSnap/pull/123",
    ]);
  });
});
