import { describe, expect, it } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import { createSubthreadTrays } from "../subthread-trays";

function thread(
  id: string,
  extra: Partial<NavigationThreadSummary> = {},
): NavigationThreadSummary {
  return {
    id,
    title: id,
    titleSource: "explicit",
    source: "codex",
    linkedDirectories: [],
    inbox: { inInbox: false },
    ...extra,
  } as NavigationThreadSummary;
}

function childrenByParentKey(
  entries: Array<[string, NavigationThreadSummary[]]>,
): Map<string, NavigationThreadSummary[]> {
  return new Map(entries);
}

describe("createSubthreadTrays", () => {
  it("flattens a subtree depth-first so a child follows its own parent", () => {
    const root = thread("root", { subthreadOrder: ["child-a", "child-b"] });
    const childA = thread("child-a", { subthreadOrder: ["grandchild"] });
    const grandchild = thread("grandchild");
    const childB = thread("child-b");
    const trays = createSubthreadTrays(childrenByParentKey([
      ["codex:root", [childB, childA]],
      ["codex:child-a", [grandchild]],
    ]), [root]);

    expect(trays.subtree("codex:root").map((row) => row.id)).toEqual([
      "child-a",
      "grandchild",
      "child-b",
    ]);
  });

  it("orders a tray by the owner's child order, not by creation time", () => {
    // Navigation rows never carry `subthreadOrder`: it is a detail
    // collection. The owner's child page arrives in the saved order, and a
    // tray that re-sorts it newest-first undoes every reorder.
    const root = thread("root");
    const older = thread("older", { createdAt: 1 });
    const newer = thread("newer", { createdAt: 2 });
    const unlisted = thread("unlisted", { createdAt: 3 });
    const grandchild = thread("grandchild", { createdAt: 4 });
    const trays = createSubthreadTrays(childrenByParentKey([
      ["codex:root", [older, newer, unlisted]],
      ["codex:newer", [grandchild]],
    ]), [root], new Map([["codex:root", ["codex:older", "codex:newer"]]]));

    expect(trays.subtree("codex:root").map((row) => row.id)).toEqual([
      "older",
      "newer",
      "grandchild",
      // A child no owner page listed yet follows the listed ones.
      "unlisted",
    ]);
    expect(trays.directChildKeys("codex:root")).toEqual(["codex:older", "codex:newer", "codex:unlisted"]);
  });

  it("prefers a parent's own subthreadOrder over the owner's page order", () => {
    // Set only by this window's optimistic absolute reorder, which is newer
    // than the page it replaces.
    const root = thread("root", { subthreadOrder: ["newer", "older"] });
    const older = thread("older", { createdAt: 1 });
    const newer = thread("newer", { createdAt: 2 });
    const trays = createSubthreadTrays(childrenByParentKey([
      ["codex:root", [older, newer]],
    ]), [root], new Map([["codex:root", ["codex:older", "codex:newer"]]]));

    expect(trays.subtree("codex:root").map((row) => row.id)).toEqual(["newer", "older"]);
  });

  it("reports each row's real depth so a flat tray still reads as a tree", () => {
    const root = thread("root");
    const child = thread("child");
    const grandchild = thread("grandchild");
    const greatGrandchild = thread("great-grandchild");
    const trays = createSubthreadTrays(childrenByParentKey([
      ["codex:root", [child]],
      ["codex:child", [grandchild]],
      ["codex:grandchild", [greatGrandchild]],
    ]), [root]);

    // The tray renders flat, so depth is the only thing separating a
    // grandchild from the sibling above it.
    expect(trays.depth("codex:child")).toBe(1);
    expect(trays.depth("codex:grandchild")).toBe(2);
    expect(trays.depth("codex:great-grandchild")).toBe(3);
    // A row no tray placed — the owner itself, or a thread outside this lens
    // — is as shallow as a rendered tray row can be.
    expect(trays.depth("codex:root")).toBe(1);
    expect(trays.depth("codex:absent")).toBe(1);
  });

  it("reports only direct children as reorderable", () => {
    const root = thread("root");
    const child = thread("child");
    const grandchild = thread("grandchild");
    const trays = createSubthreadTrays(childrenByParentKey([
      ["codex:root", [child]],
      ["codex:child", [grandchild]],
    ]), [root]);

    // `subthreadOrder` is stored per parent, so a reorder of this tray must
    // never come to name the grandchild as a child of `root`.
    expect(trays.directChildKeys("codex:root")).toEqual(["codex:child"]);
    expect(trays.directChildKeys("codex:child")).toEqual([]);
  });

  it("gives a row to the first owner that claims it", () => {
    const first = thread("first");
    const second = thread("second");
    const shared = thread("shared");
    const trays = createSubthreadTrays(childrenByParentKey([
      ["codex:first", [shared]],
      ["codex:second", [shared]],
    ]), [first, second]);

    expect(trays.subtree("codex:first").map((row) => row.id)).toEqual([
      "shared",
    ]);
    expect(trays.subtree("codex:second")).toEqual([]);
  });

  it.each([false, true])("reserves a promoted root and its descendants before walking trays (promoted first=%s)", (promotedFirst) => {
    const root = thread("root");
    const child = thread("child", { parentThreadId: root.id });
    const promoted = thread("promoted", { parentThreadId: child.id });
    const descendant = thread("descendant", { parentThreadId: promoted.id });
    const trays = createSubthreadTrays(childrenByParentKey([
      ["codex:root", [child]],
      ["codex:child", [promoted]],
      ["codex:promoted", [descendant]],
    ]), promotedFirst ? [promoted, root] : [root, promoted]);

    expect(trays.subtree("codex:root")).toEqual([child]);
    expect(trays.subtree("codex:promoted")).toEqual([descendant]);
    expect(trays.directChildKeys("codex:root")).toEqual(["codex:child"]);
    expect(trays.directChildKeys("codex:promoted")).toEqual(["codex:descendant"]);
    expect(trays.depth("codex:descendant")).toBe(1);
  });

  it("terminates on a parent-link cycle", () => {
    const left = thread("left");
    const right = thread("right");
    const trays = createSubthreadTrays(childrenByParentKey([
      ["codex:left", [right]],
      ["codex:right", [left]],
    ]), [left]);

    // Terminating at all is the assertion; the owner is already claimed, so
    // the child's link back to it places nothing and the walk stops.
    expect(trays.subtree("codex:left").map((row) => row.id)).toEqual(["right"]);
    expect(trays.directChildKeys("codex:left")).toEqual(["codex:right"]);
  });

  it("returns empty views for a row that owns no tray", () => {
    const trays = createSubthreadTrays(childrenByParentKey([]), []);

    expect(trays.subtree("codex:absent")).toEqual([]);
    expect(trays.directChildKeys("codex:absent")).toEqual([]);
    expect(trays.depth("codex:absent")).toBe(1);
  });
});
