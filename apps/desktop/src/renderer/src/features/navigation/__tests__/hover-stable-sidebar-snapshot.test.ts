import { describe, expect, it } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import type { NavigationDirectoryView } from "../../../lib/navigation-loaded-rows";
import type { NavigationPresentationEntry } from "../navigation-presentation-order";
import {
  createHoverStableSidebarHydrator,
  hydrateHoverStableSidebarSnapshot,
  type HoverStableSidebarSnapshot,
} from "../hover-stable-sidebar-snapshot";

/**
 * The hydrate runs during render for as long as the pointer rests on a
 * sidebar row, and it rebuilds every thread, directory, and array on every
 * call. That costs nothing while nothing downstream memoizes — and it
 * silently defeats the row memoization the moment one exists, for exactly as
 * long as the pointer is on a row.
 *
 * These tests pin the identity contract directly rather than through a
 * rendered tree, because "same values, same object" is the property the memo
 * boundary consumes and it is cheaper to state here than to infer from a
 * render count.
 */

function thread(
  id: string,
  overrides: Partial<NavigationThreadSummary> = {},
): NavigationThreadSummary {
  return {
    id,
    title: `Thread ${id}`,
    source: "codex",
    createdAt: 100,
    updatedAt: 200,
    inbox: { inInbox: false },
    ...overrides,
  } as unknown as NavigationThreadSummary;
}

function directory(key: string): NavigationDirectoryView {
  return { key, label: key, path: `/repos/${key}` } as unknown as NavigationDirectoryView;
}

function snapshot(
  threads: NavigationThreadSummary[],
  directories: NavigationDirectoryView[] = [directory("repo")],
): HoverStableSidebarSnapshot {
  return {
    directories,
    order: new Map<string, readonly NavigationPresentationEntry[]>([
      ["lens", [{ key: "lens:1", placement: { kind: "root" } }]],
    ]),
    threads,
    visibleKeys: threads.map((entry) => `codex:${entry.id}`),
  };
}

/** A fresh snapshot carrying the same values — what a re-render produces. */
function respin(source: HoverStableSidebarSnapshot): HoverStableSidebarSnapshot {
  return {
    directories: source.directories.map((entry) => ({ ...entry })),
    order: new Map<string, readonly NavigationPresentationEntry[]>(
      [...source.order].map(([id, entries]) => [id, entries.map((entry) => ({ ...entry }))]),
    ),
    threads: source.threads.map((entry) => ({ ...entry })),
    visibleKeys: [...source.visibleKeys],
  };
}

describe("hydrateHoverStableSidebarSnapshot", () => {
  it("takes live fields from latest and structural fields from frozen", () => {
    const frozen = snapshot([thread("a", { createdAt: 1, pinnedRank: "7" })]);
    const latest = snapshot([
      thread("a", { createdAt: 999, pinnedRank: "42", title: "Renamed" }),
    ]);

    const merged = hydrateHoverStableSidebarSnapshot(frozen, latest);

    // Live content reaches the stationary row...
    expect(merged.threads[0]?.title).toBe("Renamed");
    // ...while the fields that would move it stay frozen.
    expect(merged.threads[0]?.createdAt).toBe(1);
    expect(merged.threads[0]?.pinnedRank).toBe("7");
  });

  it("allocates a fresh object on every call", () => {
    // The behaviour the hydrator below exists to wrap. Stated so the
    // preservation tests cannot pass vacuously.
    const frozen = snapshot([thread("a")]);
    const latest = snapshot([thread("a")]);

    const first = hydrateHoverStableSidebarSnapshot(frozen, latest);
    const second = hydrateHoverStableSidebarSnapshot(frozen, latest);

    expect(second).not.toBe(first);
    expect(second.threads[0]).not.toBe(first.threads[0]);
  });
});

describe("createHoverStableSidebarHydrator", () => {
  it("returns the previous objects when nothing changed", () => {
    const hydrate = createHoverStableSidebarHydrator();
    const frozen = snapshot([thread("a"), thread("b")]);
    const latest = snapshot([thread("a"), thread("b")]);

    const first = hydrate(frozen, latest);
    // Ten more renders with equal-but-fresh inputs, which is what the
    // Sidebar builds inline on every render while a row is hovered.
    let current = first;
    for (let round = 0; round < 10; round += 1) {
      current = hydrate(frozen, respin(latest));
    }

    expect(current).toBe(first);
    expect(current.threads).toBe(first.threads);
    expect(current.threads[0]).toBe(first.threads[0]);
    expect(current.threads[1]).toBe(first.threads[1]);
    expect(current.directories).toBe(first.directories);
    expect(current.visibleKeys).toBe(first.visibleKeys);
    expect(current.order).toBe(first.order);
  });

  it("gives a new object only to the row whose values changed", () => {
    const hydrate = createHoverStableSidebarHydrator();
    // Rows carried forward from the previous render, the way a navigation
    // snapshot carries them: the untouched entry is the same object, and the
    // changed one is a fresh spread of it.
    const rows = [thread("a"), thread("b")];
    const frozen = snapshot(rows);
    const first = hydrate(frozen, snapshot(rows));

    const second = hydrate(
      frozen,
      snapshot([rows[0]!, { ...rows[1]!, title: "Now thinking" }]),
    );

    expect(second).not.toBe(first);
    // The untouched row keeps its identity, so its memoized row still bails.
    expect(second.threads[0]).toBe(first.threads[0]);
    expect(second.threads[1]).not.toBe(first.threads[1]);
    expect(second.threads[1]?.title).toBe("Now thinking");
  });

  it("drops array identity when a row is admitted", () => {
    const hydrate = createHoverStableSidebarHydrator();
    const rows = [thread("a")];
    const frozen = snapshot(rows);
    const first = hydrate(frozen, snapshot(rows));

    const second = hydrate(frozen, snapshot([rows[0]!, thread("b")]));

    expect(second.threads).not.toBe(first.threads);
    expect(second.threads).toHaveLength(2);
    expect(second.threads[0]).toBe(first.threads[0]);
  });

  it("does not see through a nested field rebuilt upstream", () => {
    // The comparison is shallow, deliberately: it is the same test the memo
    // boundary downstream applies, and a deep walk of every thread on every
    // render would cost more than the renders it saves. The consequence is
    // worth stating — a producer that rebuilds `inbox` (or any nested object)
    // per render defeats this, and the fix belongs in that producer.
    const hydrate = createHoverStableSidebarHydrator();
    const frozen = snapshot([thread("a")]);
    const first = hydrate(frozen, snapshot([thread("a")]));

    const second = hydrate(frozen, snapshot([thread("a")]));

    expect(second.threads[0]).not.toBe(first.threads[0]);
    expect(second.threads[0]).toStrictEqual(first.threads[0]);
  });

  it("keeps each instance's history to itself", () => {
    // The Sidebar holds one hydrator per component instance. Sharing one
    // across instances would leak one window's rows into another's.
    const frozen = snapshot([thread("a")]);
    const first = createHoverStableSidebarHydrator()(frozen, snapshot([thread("a")]));
    const other = createHoverStableSidebarHydrator()(frozen, snapshot([thread("a")]));

    expect(other).not.toBe(first);
  });
});
