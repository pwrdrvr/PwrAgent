import fc from "fast-check";
import { expect, it, vi } from "vitest";
import type { NavigationQueryRequest, NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import { createNavigationQuerySnapshot, projectNavigationQuery, type NavigationQueryIndex } from "../navigation-query-projection";
import { NavigationQueryStore } from "../navigation-query-store";

function inventory(titles: readonly string[], observedAt: number): NavigationQueryIndex {
  return {
    observedAt,
    coverage: { state: "complete" },
    directories: [],
    threads: titles.map((title, i): NavigationThreadSummary => ({
      id: String(i), title, source: "codex", titleSource: "explicit", linkedDirectories: [],
      inbox: { inInbox: true }, updatedAt: i + 1,
    })),
  };
}

const request: NavigationQueryRequest = {
  protocol: 2, consumer: "main-sidebar", query: { kind: "lens", lens: "inbox" },
};

it("reuses certified unchanged rows across observations and detaches changed ones", () => {
  fc.assert(fc.property(
    fc.array(fc.string(), { minLength: 2, maxLength: 30 }),
    fc.array(fc.option(fc.nat(), { nil: null }), { minLength: 2, maxLength: 12 }),
    (initial, updates) => {
      let known = initial;
      let prior = createNavigationQuerySnapshot(inventory(known, 0));
      for (const [step, slot] of updates.entries()) {
        const changed = slot === null ? -1 : slot % known.length;
        known = known.map((title, i) => i === changed ? title + "!" : title);
        const input = inventory(known, step + 1);
        const onWork = vi.fn();
        const next = createNavigationQuerySnapshot(input, onWork, undefined, prior);

        // A new observation is authoritative, even if all membership is equal.
        expect(next.observedAt).toBe(step + 1);
        for (const [i, row] of next.threads.entries()) {
          if (i !== changed) expect(row).toBe(prior.threads[i]);
          else expect(row).not.toBe(prior.threads[i]);
        }
        if (changed < 0) expect(onWork).not.toHaveBeenCalled();
        expect(projectNavigationQuery({ index: next, request })).toEqual(projectNavigationQuery({ index: input, request }));
        input.threads[0]!.inbox.inInbox = false;
        expect(next.threads[0]!.inbox.inInbox).toBe(true);
        expect(Object.isFrozen(next.threads[0]!.inbox)).toBe(true);
        prior = next;
      }
    },
  ));
});

it("reuses the prepared inventory after an unchanged refresh advances its observation", () => {
  const first = createNavigationQuerySnapshot(inventory(["A", "B"], 1));
  const onWork = vi.fn();
  const refreshed = createNavigationQuerySnapshot(inventory(["A", "B"], 2), onWork, undefined, first);
  expect(refreshed.observedAt).toBe(2);
  expect(refreshed.threads).toBe(first.threads);
  expect(onWork).not.toHaveBeenCalled();
});

it("keeps provider ordering while reusing certified rows that moved", () => {
  fc.assert(fc.property(fc.array(fc.string(), { minLength: 2, maxLength: 30 }), fc.nat(), (titles, offset) => {
    const first = createNavigationQuerySnapshot(inventory(titles, 1));
    const input = inventory(titles, 2);
    const start = 1 + offset % (titles.length - 1);
    input.threads = [...input.threads.slice(start), ...input.threads.slice(0, start)];
    const reordered = createNavigationQuerySnapshot(input, undefined, undefined, first);
    expect(reordered.threads.map(({ id }) => id)).toEqual(input.threads.map(({ id }) => id));
    for (const row of reordered.threads) expect(row).toBe(first.threads[Number(row.id)]);
    expect(projectNavigationQuery({ index: reordered, request })).toEqual(projectNavigationQuery({ index: input, request }));
  }));
});

it("charges each included page row once during admission", async () => {
  const index = createNavigationQuerySnapshot(inventory(Array.from({ length: 85 }, (_, i) => "🌲" + i), 1));
  const stringify = vi.spyOn(JSON, "stringify");
  try {
    const store = new NavigationQueryStore();
    const page = await store.readPage({ loadIndex: async () => index, request, scopeKey: "owner" });
    expect(page.entries.length).toBeGreaterThan(20);
    const pagePasses = stringify.mock.calls.filter(([value]) => value !== null && typeof value === "object"
      && "countsRevision" in value && "entries" in value).length;
    expect(pagePasses).toBeLessThanOrEqual(2);
  } finally {
    stringify.mockRestore();
  }
});

it("reuses the admitted projection for a certified refresh and recomputes it after a row changes", async () => {
  const titles = Array.from({ length: 85 }, (_, i) => "Thread " + i);
  let current = createNavigationQuerySnapshot(inventory(titles, 1));
  const store = new NavigationQueryStore();
  const read = (completeBaselineRevision?: string) => store.readPage({
    loadIndex: async () => current, scopeKey: "owner", request: { ...request, pageSize: 20, completeBaselineRevision },
  });
  const first = await read();
  expect(first.nextCursor).toBeDefined();
  const serialize = vi.spyOn(JSON, "stringify");
  try {
    current = createNavigationQuerySnapshot(inventory(titles, 2), undefined, undefined, current);
    expect(await read(first.countsRevision)).toMatchObject({ unchanged: true });
    expect(serialize.mock.calls.filter(([value]) => value && typeof value === "object" && "row" in value)).toHaveLength(0);
  } finally {
    serialize.mockRestore();
  }

  titles[84] = titles[84]! + " changed";
  current = createNavigationQuerySnapshot(inventory(titles, 3), undefined, undefined, current);
  const changed = await read(first.countsRevision);
  expect(changed.countsRevision).not.toBe(first.countsRevision);
  expect(changed.entries[0]?.row.title).toBe(titles[84]);
});
