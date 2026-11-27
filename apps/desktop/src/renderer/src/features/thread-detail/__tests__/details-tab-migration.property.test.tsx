import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import fc from "fast-check";
import { useState, type Dispatch, type SetStateAction } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import { ThreadContextPanel } from "../ThreadContextPanel";
import {
  CONTEXT_TAB_IDS,
  DETAILS_SEGMENT_IDS,
  contextTabIdForDetailsSegment,
  isContextTabId,
  resolveContextTabTarget,
  type ContextRailTabId,
  type ContextTabId,
  type DetailsSectionId,
  type DetailsSegmentId,
} from "../context-panels/context-tab";

afterEach(cleanup);

/**
 * The approved move table ("Composer Diet and Thread Details", section 05):
 * where each tab that Details took in now lives. Written out by hand so the
 * mapping is checked against the design, not against itself.
 */
const MERGED: Record<string, { segment: DetailsSegmentId; section?: DetailsSectionId }> = {
  info: { segment: "thread" },
  projects: { segment: "thread", section: "folders" },
  edits: { segment: "changes" },
  prs: { segment: "prs" },
  "pr-activity": { segment: "prs", section: "activity" },
  actions: { segment: "jobs", section: "commands" },
  subagents: { segment: "jobs", section: "subagents" },
  automations: { segment: "jobs", section: "scheduled" },
};

const SPINE_TABS: readonly ContextRailTabId[] = [
  "details", "todos", "research", "waiting", "pricing", "decisions", "providers", "connections",
];

// Every id a stored setting, deep link or reveal request can carry.
const EVERY_TAB_ID: readonly ContextTabId[] = [...CONTEXT_TAB_IDS, "connections"];

describe("old context tab ids", () => {
  it("each land on a spine tab, and the eight Details took in on their segment", () => {
    fc.assert(fc.property(fc.constantFrom(...EVERY_TAB_ID), (id) => {
      const target = resolveContextTabTarget(id);
      expect(SPINE_TABS).toContain(target.tab);
      // A segment exactly when Details is the tab.
      expect(target.segment !== undefined).toBe(target.tab === "details");
      const merged = MERGED[id];
      if (merged) {
        expect(target).toEqual({ tab: "details", ...merged });
      } else {
        expect(target).toEqual({ tab: id });
      }
    }), { numRuns: EVERY_TAB_ID.length * 4 });
  });

  it("store each segment under an id that resolves back to it and that older builds read", () => {
    fc.assert(fc.property(fc.constantFrom(...DETAILS_SEGMENT_IDS), (segment) => {
      const stored = contextTabIdForDetailsSegment(segment);
      // The persisted value keeps its shape: an id every build already knows.
      expect(isContextTabId(stored)).toBe(true);
      expect(resolveContextTabTarget(stored)).toMatchObject({ tab: "details", segment });
    }));
  });

  it("leave every spine tab reachable from some old id", () => {
    const reached = new Set(EVERY_TAB_ID.map((id) => resolveContextTabTarget(id).tab));
    expect([...reached].sort()).toEqual([...SPINE_TABS].sort());
  });
});

const thread: NavigationThreadSummary = {
  id: "thread-1",
  title: "Fix table header",
  titleSource: "explicit",
  source: "codex",
  linkedDirectories: [],
  inbox: { inInbox: false },
};

// Ids whose spine tab this fixture draws: To-dos, Research and Decisions need
// their own setup and are covered by the pure property above.
const DRAWN_IDS: readonly ContextTabId[] = [
  ...Object.keys(MERGED) as ContextTabId[],
  "waiting",
  "pricing",
  "providers",
];
const DRAWN_SPINE: readonly ContextRailTabId[] = ["details", "waiting", "pricing", "providers"];

type Model = { stored: ContextTabId; remembered: DetailsSegmentId };

function settle(model: Model): void {
  const segment = resolveContextTabTarget(model.stored).segment;
  if (segment) model.remembered = segment;
}

type Real = { setTab: { current?: Dispatch<SetStateAction<ContextTabId>> } };

function Harness(props: { initial: ContextTabId; real: Real }) {
  const [tab, setTab] = useState<ContextTabId>(props.initial);
  props.real.setTab.current = setTab;
  return (
    <ThreadContextPanel activeTab={tab} backends={[]} pinned thread={thread} onActiveTabChange={setTab} />
  );
}

function spineTab(tab: ContextRailTabId): HTMLElement {
  const spine = screen.getByRole("tablist", { name: "Context panels" });
  const name = {
    details: /^Details/,
    waiting: /^Waiting for/,
    pricing: /^Pricing/,
    providers: /^AI provider info/,
  }[tab as "details" | "waiting" | "pricing" | "providers"];
  return within(spine).getByRole("tab", { name });
}

const SEGMENT_NAMES: Record<DetailsSegmentId, RegExp> = {
  thread: /^Thread/,
  changes: /^Changes/,
  prs: /^PRs/,
  jobs: /^Jobs/,
};

function check(model: Model): void {
  const target = resolveContextTabTarget(model.stored);
  for (const tab of DRAWN_SPINE) {
    expect(spineTab(tab)).toHaveAttribute("aria-selected", String(tab === target.tab));
  }
  const segments = screen.queryByRole("tablist", { name: "Details" });
  if (target.tab !== "details") {
    expect(segments).toBeNull();
    return;
  }
  expect(segments).not.toBeNull();
  for (const segment of DETAILS_SEGMENT_IDS) {
    expect(within(segments!).getByRole("tab", { name: SEGMENT_NAMES[segment] }))
      .toHaveAttribute("aria-selected", String(segment === target.segment));
  }
}

class Reveal implements fc.Command<Model, Real> {
  constructor(readonly id: ContextTabId) {}
  check(): boolean { return true; }
  run(model: Model, real: Real): void {
    act(() => real.setTab.current?.(this.id));
    model.stored = this.id;
    settle(model);
    check(model);
  }
  toString(): string { return `reveal(${this.id})`; }
}

class ClickSpine implements fc.Command<Model, Real> {
  constructor(readonly tab: ContextRailTabId) {}
  check(): boolean { return true; }
  run(model: Model): void {
    fireEvent.click(spineTab(this.tab));
    // Details reopens on the segment it last showed.
    model.stored = this.tab === "details" ? contextTabIdForDetailsSegment(model.remembered) : this.tab as ContextTabId;
    settle(model);
    check(model);
  }
  toString(): string { return `spine(${this.tab})`; }
}

class ClickSegment implements fc.Command<Model, Real> {
  constructor(readonly segment: DetailsSegmentId) {}
  check(model: Readonly<Model>): boolean {
    return resolveContextTabTarget(model.stored).tab === "details";
  }
  run(model: Model): void {
    const segments = screen.getByRole("tablist", { name: "Details" });
    fireEvent.click(within(segments).getByRole("tab", { name: SEGMENT_NAMES[this.segment] }));
    model.stored = contextTabIdForDetailsSegment(this.segment);
    settle(model);
    check(model);
  }
  toString(): string { return `segment(${this.segment})`; }
}

describe("the Details tab on the rail", () => {
  // The model test's counterexample when Details forgot its segment.
  it("reopens Details on the segment it last showed after another tab", () => {
    const real: Real = { setTab: {} };
    render(<Harness initial="info" real={real} />);
    const model: Model = { stored: "info", remembered: "thread" };
    const commands: fc.Command<Model, Real>[] = [
      new ClickSegment("jobs"),
      new Reveal("waiting"),
      new ClickSpine("details"),
    ];
    for (const command of commands) {
      command.run(model, real);
    }
    expect(model.stored).toBe("actions");
  });

  it("shows the spine tab and segment each stored id names, through reveals and clicks", () => {
    fc.assert(fc.property(
      fc.constantFrom(...DRAWN_IDS),
      fc.commands([
        fc.constantFrom(...DRAWN_IDS).map((id) => new Reveal(id)),
        fc.constantFrom(...DRAWN_SPINE).map((tab) => new ClickSpine(tab)),
        fc.constantFrom(...DETAILS_SEGMENT_IDS).map((segment) => new ClickSegment(segment)),
      ], { maxCommands: 8 }),
      (initial, commands) => {
        const real: Real = { setTab: {} };
        const view = render(<Harness initial={initial} real={real} />);
        const model: Model = { stored: initial, remembered: "thread" };
        settle(model);
        try {
          check(model);
          fc.modelRun(() => ({ model, real }), commands);
        } finally {
          view.unmount();
        }
      },
    ), { numRuns: 12 });
  });
});
