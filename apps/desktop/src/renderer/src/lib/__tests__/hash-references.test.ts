import { describe, expect, it } from "vitest";
import type { NavigationThreadSummary, PrSummary } from "@pwragent/shared";
import {
  buildHashReferenceOptions,
  collapseHashReferenceWhitespace,
  filterHashReferenceCandidates,
  findHashReferenceTrigger,
  formatHashReferenceThreadLabel,
  formatHashReferenceThreadTooltip,
  hashReferenceAnchorKey,
  HASH_ANCHOR_COLD_QUERY_LENGTH,
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

describe("hashReferenceAnchorKey", () => {
  it("stays put as the query grows to the right", () => {
    // The whole point: `#validate` retiring must keep the anchor retired
    // while the operator types the rest of the sentence after it. A key
    // that moved with the query would retire nothing.
    const key = hashReferenceAnchorKey("validate");
    expect(hashReferenceAnchorKey("validate acp sdk")).toBe(key);
    expect(hashReferenceAnchorKey("validate acp sdk asdg asd asdg")).toBe(key);
  });

  it("ignores case so retyping the same run does not re-arm a cold anchor", () => {
    expect(hashReferenceAnchorKey("VaLiDaTe acp")).toBe(
      hashReferenceAnchorKey("validate acp"),
    );
  });

  it("separates anchors that differ inside the leading run", () => {
    expect(hashReferenceAnchorKey("validate acp")).not.toBe(
      hashReferenceAnchorKey("validxte acp"),
    );
  });

  it("cannot key a query short enough to still be live", () => {
    // A caret parked immediately right of the `#` yields an empty query,
    // and retirement only ever fires at or past the threshold — so the
    // re-arm gesture can never land on an already-cold key.
    expect(hashReferenceAnchorKey("")).toBe("");
    expect("".length).toBeLessThan(HASH_ANCHOR_COLD_QUERY_LENGTH);
    expect(hashReferenceAnchorKey("short").length).toBeLessThan(
      HASH_ANCHOR_COLD_QUERY_LENGTH,
    );
  });
});

describe("hash reference thread formatting", () => {
  it("keeps ordinary titles and id fallbacks in labels and tooltips", () => {
    expect(
      formatHashReferenceThreadLabel(thread("id-1", "Bob's Best Thread 3000")),
    ).toBe("Bob's Best Thread 3000");
    expect(formatHashReferenceThreadLabel(thread("id-1", "   "))).toBe("id-1");
    expect(
      formatHashReferenceThreadTooltip(thread("id-1", "Bob's\nBest Thread")),
    ).toBe("Bob's Best Thread");
    expect(formatHashReferenceThreadTooltip(thread("id-1", ""))).toBe("id-1");
  });

  it("collapses a multi-line prompt title onto one truncated line", () => {
    const promptTitle = [
      "#Apparently we don't allow cross-provider parent/child relationships?",
      "We should… In this case we created a \"child\" thread that is stuck in",
      "the unpinned section because it is a parent but we refuse to render it.",
    ].join("\n");

    const label = formatHashReferenceThreadLabel(thread("id-1", promptTitle));

    expect(label).not.toContain("\n");
    expect(label.length).toBeLessThanOrEqual(73);
    expect(label.endsWith("…")).toBe(true);
    expect(label).toBe(
      "#Apparently we don't allow cross-provider parent/child relationships? We…",
    );
  });

  it("breaks mid-token only when no word boundary is near the limit", () => {
    const label = formatHashReferenceThreadLabel(thread("id-1", "x".repeat(200)));
    expect(label).toBe(`${"x".repeat(72)}…`);
  });
  it("recovers what the label's ellipsis hid without becoming a wall of text", () => {
    const long = `${"word ".repeat(200)}end`;
    const tooltip = formatHashReferenceThreadTooltip(thread("id-1", long));

    expect(tooltip.length).toBeLessThanOrEqual(301);
    expect(tooltip.endsWith("…")).toBe(true);
    // Strictly more context than the row shows, which is the whole point.
    expect(tooltip.length).toBeGreaterThan(
      formatHashReferenceThreadLabel(thread("id-1", long)).length,
    );
  });
});

describe("collapseHashReferenceWhitespace", () => {
  it("folds every run of whitespace into a single space", () => {
    expect(collapseHashReferenceWhitespace("  one\n\ntwo\tthree ")).toBe(
      "one two three",
    );
    expect(collapseHashReferenceWhitespace(undefined)).toBe("");
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

describe("buildHashReferenceOptions", () => {
  function remote(
    id: string,
    title: string,
    instanceId = "pwr_peer",
  ): NavigationThreadSummary {
    return thread(id, title, {
      federation: {
        instanceLabel: "Studio Mac",
        ref: {
          backend: "codex",
          threadId: id,
          target: { scope: "remote", instanceId },
        },
      },
    } as Partial<NavigationThreadSummary>);
  }

  it("lists local rows before peer rows", () => {
    const options = buildHashReferenceOptions({
      localThreads: [thread("t-1", "Parser rewrite")],
      query: "parser",
      remoteThreads: [remote("t-2", "Parser cleanup")],
    });
    expect(
      options.map((option) =>
        option.kind === "thread"
          ? [option.thread.id, option.remote]
          : [option.pullRequest.url, option.remote],
      ),
    ).toEqual([
      ["t-1", false],
      ["t-2", true],
    ]);
  });

  it("drops the thread being written in", () => {
    const options = buildHashReferenceOptions({
      currentThreadKey: "codex:t-1",
      localThreads: [thread("t-1", "Parser rewrite"), thread("t-2", "Parser fix")],
      query: "parser",
    });
    expect(options.map((option) => option.kind === "thread" && option.thread.id))
      .toEqual(["t-2"]);
  });

  it("drops a peer row the local snapshot already carries", () => {
    // A pinned peer thread appears in both populations; offering it twice
    // is the kind of duplicate an operator reads as two different threads.
    const options = buildHashReferenceOptions({
      localThreads: [remote("t-2", "Parser cleanup")],
      query: "parser",
      remoteThreads: [remote("t-2", "Parser cleanup")],
    });
    expect(options).toHaveLength(1);
    expect(options[0]!.remote).toBe(false);
  });

  it("drops a peer pull request a local thread already offers", () => {
    const shared = pullRequest(123);
    const options = buildHashReferenceOptions({
      localThreads: [thread("t-1", "Local", { prs: [shared] })],
      query: "123",
      remoteThreads: [remote("t-2", "Remote")],
    });
    const pullRequests = options.filter(
      (option) => option.kind === "pull-request",
    );
    expect(pullRequests).toHaveLength(1);
  });
});
