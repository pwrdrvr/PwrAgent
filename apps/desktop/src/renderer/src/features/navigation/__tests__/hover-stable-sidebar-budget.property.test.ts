import fc from "fast-check";
import { expect, it } from "vitest";
import { createHoverStableSidebarHydrator, hydrateHoverStableSidebarSnapshot, type HoverStableSidebarSnapshot } from "../hover-stable-sidebar-snapshot";

it("visible membership follows the freeze/reveal oracle with linear array reads as the list doubles", () => {
  fc.assert(fc.property(fc.integer({ min: 16, max: 128 }), fc.boolean(), (size, removeMissingThreads) => {
    for (const count of [size, size * 2]) {
      let reads = 0;
      const track = (keys: string[]) => new Proxy(keys, { get(array, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key)) reads += 1;
        return Reflect.get(array, key, receiver);
      } });
      const before = Array.from({ length: count }, (_, i) => String(i));
      const after = [...before.slice(count / 2), "new"];
      const frozen: HoverStableSidebarSnapshot = { directories: [], threads: [], order: new Map(), visibleKeys: track(before) };
      const latest: HoverStableSidebarSnapshot = { ...frozen, visibleKeys: track(after) };
      const hydrated = hydrateHoverStableSidebarSnapshot(frozen, latest, { removeMissingThreads });
      const expected = [...before.filter((key) => !removeMissingThreads || after.includes(key)),
        ...after.filter((key) => !before.includes(key))];
      expect(hydrated.visibleKeys).toEqual(expected);
      expect(reads).toBeLessThanOrEqual(4 * (before.length + after.length));
    }
  }));
});

it("unchanged immutable inputs reuse hydration without reading rows or rebuilding indexes", () => {
  fc.assert(fc.property(fc.integer({ min: 16, max: 128 }), (count) => {
    let reads = 0;
    const visibleKeys = new Proxy(Array.from({ length: count }, (_, i) => String(i)), { get(array, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) reads += 1;
      return Reflect.get(array, key, receiver);
    } });
    const snapshot: HoverStableSidebarSnapshot = { directories: [], threads: [], order: new Map(), visibleKeys };
    const hydrate = createHoverStableSidebarHydrator();
    const first = hydrate(snapshot, snapshot);
    reads = 0;
    expect(hydrate(snapshot, { ...snapshot })).toBe(first);
    expect(reads).toBe(0);
  }));
});
