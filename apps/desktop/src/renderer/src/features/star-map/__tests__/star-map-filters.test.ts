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

  it("isolates on a single include, keeping pins alongside", () => {
    // A pin outranks the attention chips: the sidebar's Pins section and the
    // map are meant to agree about what the operator curated.
    expect(ids({ attention: "include" })).toEqual([
      "pinned",
      "unread",
      "unread-agent",
    ]);
  });

  it("unions includes WITHIN a facet", () => {
    expect(ids({ attention: "include", pr: "include" })).toEqual([
      "pinned",
      "pr",
      "unread",
      "unread-agent",
    ]);
  });

  it("intersects includes ACROSS facets", () => {
    // "unread AND agent-driven" — not "unread or agent-driven", which is
    // what a flat union would give and is never what the operator means.
    expect(ids({ attention: "include", agent: "include" })).toEqual([
      "pinned",
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
    expect(ids({ attention: "include", agent: "exclude" })).toEqual([
      "pinned",
      "unread",
    ]);
  });

  it("supports include and exclude in the same facet", () => {
    expect(ids({ attention: "include", pr: "exclude" })).toEqual([
      "pinned",
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

  it("lets an explicit pinned exclude hide a pin the chips would keep", () => {
    // The override has exactly one counterweight: asking to see everything
    // EXCEPT pins. Without it the chip would be a control that cannot act.
    expect(ids({ attention: "include", pinned: "exclude" })).toEqual([
      "unread",
      "unread-agent",
    ]);
  });

  it("orders pins first, in pin order, ahead of recent activity", () => {
    const second = thread("pin-b", {
      pinnedRank: "a1",
      updatedAt: 0,
    } as Partial<NavigationThreadSummary>);
    const busy = thread("busy", {
      updatedAt: 9_999,
    } as Partial<NavigationThreadSummary>);

    // Pins take the slots nearest the star and hold their own order, so a
    // curated thread does not wander as unrelated activity arrives.
    expect(
      selectFilteredThreads({
        selection: {},
        threads: [busy, second, pinned],
      }).map((entry) => entry.id),
    ).toEqual(["pinned", "pin-b", "busy"]);
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
    expect(counts.attention).toBe(2);
    expect(counts.pinned).toBe(1);
    expect(counts.agent).toBe(2);
    expect(counts.pr).toBe(1);
  });

  it("counts against the other facets' current selection", () => {
    // With agents excluded, the attention chip speaks for one card, not two.
    const counts = countFilterMatches({
      selection: { agent: "exclude" },
      threads: all,
    });
    expect(counts.attention).toBe(1);
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

describe("selectFilteredThreads summons", () => {
  it("keeps a summoned thread the chips would have hidden", () => {
    // The operator asked for this one by name in the ⌘K palette. The
    // camera is about to fly to its card, so the lens has to draw one.
    expect(
      selectFilteredThreads({
        selection: { attention: "include" },
        threads: [unread, withPr],
        summonedKeys: new Set(["codex:pr"]),
      }).map((entry) => entry.id),
    ).toEqual(["pr", "unread"]);
  });

  it("outranks an explicit exclude on the same thread", () => {
    // "Hide open PRs" is a standing chip; "take me to this thread" is an
    // instruction about one card, issued later.
    expect(
      selectFilteredThreads({
        selection: { pr: "exclude" },
        threads: [unread, withPr],
        summonedKeys: new Set(["codex:pr"]),
      }).map((entry) => entry.id),
    ).toEqual(["pr", "unread"]);
  });

  it("seats a summoned thread ahead of pins, so no cap can fold it away", () => {
    // Every lens caps its cards and renders the first N; a summoned card
    // that lands past the cap is a flight to empty sky.
    expect(
      selectFilteredThreads({
        selection: {},
        threads: [pinned, unread, withPr],
        summonedKeys: new Set(["codex:pr"]),
      }).map((entry) => entry.id),
    ).toEqual(["pr", "pinned", "unread"]);
  });

  it("still refuses an archived thread", () => {
    // The map never draws one, so summoning it would place a card the
    // operator cannot act on.
    const archived = thread("archived", {
      archivedAt: 10,
    } as Partial<NavigationThreadSummary>);
    expect(
      selectFilteredThreads({
        selection: {},
        threads: [archived],
        summonedKeys: new Set(["codex:archived"]),
      }),
    ).toEqual([]);
  });
});
