import { describe, expect, it } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import {
  countFilterMatches,
  cycleFilterState,
  selectFilteredThreads,
  threadPassesFilters,
  type StarMapFilterSelection,
} from "../star-map-filters";

function thread(
  id: string,
  overrides: Partial<NavigationThreadSummary> = {},
): NavigationThreadSummary {
  return {
    id,
    title: `Thread ${id}`,
    titleSource: "generated",
    linkedDirectories: [],
    source: "codex",
    inbox: { inInbox: false },
    updatedAt: 0,
    ...overrides,
  } as unknown as NavigationThreadSummary;
}

const unread = thread("unread", {
  inbox: { inInbox: true, reason: "updated-since-seen" },
} as Partial<NavigationThreadSummary>);
const withPr = thread("pr", {
  prs: [{ org: "o", repo: "r", number: 1, state: "open" }],
} as unknown as Partial<NavigationThreadSummary>);
const pinned = thread("pinned", {
  pinnedRank: "a0",
} as Partial<NavigationThreadSummary>);
const agent = thread("agent", {
  agent: {
    name: "Reviewer",
    instructionLineCount: 1,
    instructionsTooLong: false,
    updatedAt: 1,
  },
} as unknown as Partial<NavigationThreadSummary>);
const unreadAgent = thread("unread-agent", {
  inbox: { inInbox: true, reason: "updated-since-seen" },
  agent: {
    name: "Reviewer",
    instructionLineCount: 1,
    instructionsTooLong: false,
    updatedAt: 1,
  },
} as unknown as Partial<NavigationThreadSummary>);
const plain = thread("plain");

const all = [unread, withPr, pinned, agent, unreadAgent, plain];

function ids(selection: StarMapFilterSelection): string[] {
  return selectFilteredThreads({ selection, threads: all })
    .map((entry) => entry.id)
    .sort();
}

describe("cycleFilterState", () => {
  it("cycles neutral -> include -> exclude -> neutral", () => {
    expect(cycleFilterState(undefined)).toBe("include");
    expect(cycleFilterState("neutral")).toBe("include");
    expect(cycleFilterState("include")).toBe("exclude");
    expect(cycleFilterState("exclude")).toBe("neutral");
  });
});

describe("selectFilteredThreads", () => {
  it("shows everything when nothing is selected", () => {
    // The old model started all-on and had an all-off state that showed an
    // empty map; neutral has no such dead end.
    expect(ids({})).toEqual(all.map((entry) => entry.id).sort());
  });

  it("isolates on a single include", () => {
    expect(ids({ unread: "include" })).toEqual(["unread", "unread-agent"]);
  });

  it("unions includes WITHIN a facet", () => {
    expect(ids({ unread: "include", pr: "include" })).toEqual([
      "pr",
      "unread",
      "unread-agent",
    ]);
  });

  it("intersects includes ACROSS facets", () => {
    // "unread AND agent-driven" — not "unread or agent-driven", which is
    // what a flat union would give and is never what the operator means.
    expect(ids({ unread: "include", agent: "include" })).toEqual([
      "unread-agent",
    ]);
  });

  it("subtracts an exclude", () => {
    expect(ids({ agent: "exclude" })).toEqual([
      "pinned",
      "plain",
      "pr",
      "unread",
    ]);
  });

  it("lets an exclude override an include in another facet", () => {
    expect(ids({ unread: "include", agent: "exclude" })).toEqual(["unread"]);
  });

  it("supports include and exclude in the same facet", () => {
    expect(ids({ unread: "include", pr: "exclude" })).toEqual([
      "unread",
      "unread-agent",
    ]);
  });

  it("filters pinned threads in and out", () => {
    expect(ids({ pinned: "include" })).toEqual(["pinned"]);
    expect(ids({ pinned: "exclude" })).toEqual([
      "agent",
      "plain",
      "pr",
      "unread",
      "unread-agent",
    ]);
  });

  it("never shows archived threads", () => {
    const archived = thread("archived", {
      archivedAt: 1,
      pinnedRank: "a1",
    } as Partial<NavigationThreadSummary>);
    expect(
      selectFilteredThreads({
        selection: { pinned: "include" },
        threads: [pinned, archived],
      }).map((entry) => entry.id),
    ).toEqual(["pinned"]);
  });

  it("orders by recent activity", () => {
    const older = thread("older", { updatedAt: 1 });
    const newer = thread("newer", { updatedAt: 9 });
    expect(
      selectFilteredThreads({ selection: {}, threads: [older, newer] }).map(
        (entry) => entry.id,
      ),
    ).toEqual(["newer", "older"]);
  });
});

describe("threadPassesFilters", () => {
  it("treats an unknown key as neutral", () => {
    expect(
      threadPassesFilters({
        selection: { nonsense: "include" } as unknown as StarMapFilterSelection,
        thread: plain,
      }),
    ).toBe(true);
  });
});

describe("countFilterMatches", () => {
  it("counts what each chip is about", () => {
    const counts = countFilterMatches({ selection: {}, threads: all });
    expect(counts.unread).toBe(2);
    expect(counts.pinned).toBe(1);
    expect(counts.agent).toBe(2);
    expect(counts.pr).toBe(1);
  });

  it("counts against the other facets' current selection", () => {
    // With agents excluded, the unread chip speaks for one card, not two.
    const counts = countFilterMatches({
      selection: { agent: "exclude" },
      threads: all,
    });
    expect(counts.unread).toBe(1);
  });

  it("does not let a chip's own state suppress its count", () => {
    // Otherwise an excluded chip would read 0 and give no way to judge
    // what turning it back on would bring.
    const counts = countFilterMatches({
      selection: { pinned: "exclude" },
      threads: all,
    });
    expect(counts.pinned).toBe(1);
  });
});
