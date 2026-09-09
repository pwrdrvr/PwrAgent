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
    ]));

    trays.addTrayOwner(root);

    expect(trays.subtree("codex:root").map((row) => row.id)).toEqual([
      "child-a",
      "grandchild",
      "child-b",
    ]);
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
    ]));

    trays.addTrayOwner(root);

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
    ]));

    trays.addTrayOwner(root);

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
    ]));

    trays.addTrayOwner(first);
    trays.addTrayOwner(second);

    expect(trays.subtree("codex:first").map((row) => row.id)).toEqual([
      "shared",
    ]);
    expect(trays.subtree("codex:second")).toEqual([]);
  });

  it("terminates on a parent-link cycle", () => {
    const left = thread("left");
    const right = thread("right");
    const trays = createSubthreadTrays(childrenByParentKey([
      ["codex:left", [right]],
      ["codex:right", [left]],
    ]));

    trays.addTrayOwner(left);

    expect(trays.subtree("codex:left").map((row) => row.id)).toEqual(["right"]);
    expect(trays.isPlaced("codex:left")).toBe(true);
    expect(trays.isPlaced("codex:right")).toBe(true);
  });

  it("returns empty views for a row that owns no tray", () => {
    const trays = createSubthreadTrays(childrenByParentKey([]));

    expect(trays.subtree("codex:absent")).toEqual([]);
    expect(trays.directChildKeys("codex:absent")).toEqual([]);
    expect(trays.isPlaced("codex:absent")).toBe(false);
  });
});
