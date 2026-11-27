import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import fc from "fast-check";
import { useState, type Dispatch, type SetStateAction } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import { ThreadContextPanel } from "../ThreadContextPanel";
import {
  DETAILS_SEGMENT_IDS,
  contextTabIdForDetailsSegment,
  resolveContextTabTarget,
  type ContextRailTabId,
  type ContextTabId,
  type DetailsSegmentId,
} from "../context-panels/context-tab";

// The pure old-id → (tab, segment) mapping is checked against the design's
// move table in context-panels/__tests__/context-tab.property.test.ts. This
// file drives the real rail through it.

afterEach(cleanup);

const thread: NavigationThreadSummary = {
  id: "thread-1",
  title: "Fix table header",
  titleSource: "explicit",
  source: "codex",
  linkedDirectories: [],
  inbox: { inInbox: false },
};

// Ids whose spine tab this fixture draws: the eight Details took in, plus
// three that stay on the spine. To-dos, Research and Decisions need their own
// setup and are covered by the pure property.
const DRAWN_IDS: readonly ContextTabId[] = [
  "info",
  "projects",
  "edits",
  "prs",
  "pr-activity",
  "actions",
  "subagents",
  "automations",
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

function runCommands(initial: ContextTabId, commands: Iterable<fc.Command<Model, Real>>): Model {
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
  return model;
}

describe("the Details tab on the rail", () => {
  // The model test's counterexample when Details forgot its segment.
  it("reopens Details on the segment it last showed after another tab", () => {
    const model = runCommands("info", [
      new ClickSegment("jobs"),
      new Reveal("waiting"),
      new ClickSpine("details"),
    ]);
    expect(model.stored).toBe("actions");
  });

  it("opens each old id's spine tab and segment on first render", () => {
    // Every drawn id, rendered once: the enumeration the generated runs below
    // cannot afford under the rendering budget.
    for (const id of DRAWN_IDS) {
      runCommands(id, []);
    }
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
        runCommands(initial, commands);
      },
    ), { numRuns: 5 });
  });
});
