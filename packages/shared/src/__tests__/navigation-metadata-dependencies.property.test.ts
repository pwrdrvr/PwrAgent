import fc from "fast-check";
import { expect, it } from "vitest";
import { NAVIGATION_METADATA_DEPENDENCY_MAX_BYTES, NAVIGATION_METADATA_DEPENDENCY_MAX_KEYS,
  readNavigationMetadataDependencies } from "../navigation-metadata-dependencies";

it("admits an entire proof exactly within its key and UTF-8 budgets, or withdraws it without truncation", () => {
  fc.assert(fc.property(fc.integer({ min: 0, max: 520 }), fc.integer({ min: 0, max: 70_000 }),
    fc.constantFrom("x", "é", "漢", "😀", "\ud800"), (keys, length, char) => {
      const proof = { version: 1 as const, threadKeys: Array.from({ length: keys }, (_, i) => String(i)), prKeys: [char.repeat(length)] };
      const admitted = keys + 1 <= NAVIGATION_METADATA_DEPENDENCY_MAX_KEYS
        && encodeURIComponent(JSON.stringify(proof)).replace(/%[0-9A-F]{2}/g, "x").length <= NAVIGATION_METADATA_DEPENDENCY_MAX_BYTES;
      const result = readNavigationMetadataDependencies(proof);
      expect(result === proof).toBe(admitted);
      expect(result === undefined).toBe(!admitted);
    }));
  const keys = { version: 1 as const, threadKeys: Array.from({ length: 512 }, (_, i) => String(i)), prKeys: [] as string[] };
  expect(readNavigationMetadataDependencies(keys) === keys).toBe(true);
  expect(readNavigationMetadataDependencies({ ...keys, prKeys: ["one"] }) === undefined).toBe(true);
  const empty = { version: 1 as const, threadKeys: [""], prKeys: [] as string[] };
  const full = { ...empty, threadKeys: ["x".repeat(64 * 1024 - JSON.stringify(empty).length)] };
  expect(readNavigationMetadataDependencies(full) === full).toBe(true);
  expect(readNavigationMetadataDependencies({ ...full, threadKeys: [full.threadKeys[0] + "x"] }) === undefined).toBe(true);
});

it("withdraws unknown versions and malformed key sets", () => {
  for (const proof of [undefined, {}, { version: 2, threadKeys: [], prKeys: [] }, { version: 1, threadKeys: [], prKeys: [null] }]) {
    expect(readNavigationMetadataDependencies(proof)).toBeUndefined();
  }
});
