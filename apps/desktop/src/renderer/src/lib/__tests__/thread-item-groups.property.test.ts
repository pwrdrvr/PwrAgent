import { expect, it } from "vitest";
import fc from "fast-check";
import budgets from "./fixtures/thread-item-group-budgets.json";
import { shareThreadItemGroups } from "../thread-item-groups";

type Item = { owner: string; id: number };
const keyOf = (item: Item) => item.owner;
const same = (left: Item, right: Item) => left === right;

it("matches a filter oracle after generated insert, remove, reorder and empty projections", () => {
  fc.assert(fc.property(fc.array(fc.array(fc.record({ owner: fc.constantFrom("local:same", "peer:same", "other"), id: fc.nat(20) }),
    { maxLength: 24, size: "max" }), { minLength: 2, maxLength: 12, size: "max" }), (snapshots) => {
    let previous: ReadonlyMap<string, Item[]> = new Map();
    const objects = new Map<string, Item>();
    for (const snapshot of snapshots) {
      const items = snapshot.map((item) => {
        const key = `${item.owner}:${item.id}`;
        if (!objects.has(key)) objects.set(key, item);
        return objects.get(key)!;
      });
      const before = [...previous].map(([key, list]) => [key, [...list]] as const);
      const next = shareThreadItemGroups(previous, items, keyOf, same);
      const keys = [...new Set(items.map(keyOf))];
      expect([...next.keys()]).toEqual(keys);
      for (const key of keys) {
        const oracle = items.filter((item) => item.owner === key);
        expect(next.get(key)).toEqual(oracle);
        const old = previous.get(key);
        if (old?.length === oracle.length && old.every((item, i) => item === oracle[i])) expect(next.get(key)).toBe(old);
      }
      expect([...previous]).toEqual(before);
      previous = next;
    }
  }));
});

it.each([20, 40])("allocates one changed group across %i retained groups, and none for an equal projection", (n) => {
  const items = Array.from({ length: n }, (_, id) => ({ owner: `owner-${id}`, id }));
  let groups = shareThreadItemGroups(new Map(), items, keyOf, same);
  let arrays = 0, keyReads = 0, comparisons = 0;
  const readKey = (item: Item) => { keyReads++; return keyOf(item); };
  const compare = (left: Item, right: Item) => { comparisons++; return same(left, right); };
  for (let step = 0; step < 20; step++) {
    const next = shareThreadItemGroups(groups, [...items, { owner: "offscreen", id: step }], readKey, compare);
    for (const [key, value] of next) if (value !== groups.get(key)) arrays++;
    expect(shareThreadItemGroups(next, [...items, ...next.get("offscreen")!], readKey, compare)).toBe(next);
    groups = next;
  }
  const budget = budgets[String(n) as keyof typeof budgets];
  expect(arrays).toBe(budget.changedArrays);
  expect(keyReads).toBeLessThanOrEqual(budget.keyReads);
  expect(comparisons).toBeLessThanOrEqual(budget.comparisons);
});
