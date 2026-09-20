import { describe, expect, it, vi } from "vitest";
import { ThreadListTextCache } from "../codex-app-server/thread-list-text-cache";

describe("provider thread listing text work", () => {
  it.each([100, 1_000, 2_000])("normalizes %i long previews once even when raw inputs exceed the byte budget", (count) => {
    const cache = new ThreadListTextCache();
    const normalize = vi.fn(() => ({ title: "Title", titleSource: "derived" as const }));
    // At 1,000 rows the two retained input fields previously cost > 8 MiB.
    for (let refresh = 0; refresh < 4; refresh++) {
      for (let id = 0; id < count; id++) {
        const preview = `${id}: ${"contrived preview ".repeat(150)}`;
        cache.read(String(id), [undefined, preview, preview], normalize);
      }
    }
    expect(normalize).toHaveBeenCalledTimes(count);
  });

  it("caches an oversized preview and detects same-length edits at its end", () => {
    const cache = new ThreadListTextCache();
    const normalize = vi.fn(() => ({ title: "Title", titleSource: "derived" as const }));
    const prefix = "x".repeat(5 * 1024 * 1024);
    for (const suffix of ["a", "a", "b", "b"]) {
      cache.read("large", [undefined, prefix + suffix, prefix + suffix], normalize);
    }
    expect(normalize).toHaveBeenCalledTimes(2);
  });

  it.each([4_096, 4_097, 8_192])("measures the entry-capacity cliff at %i distinct rows", (count) => {
    const cache = new ThreadListTextCache();
    const normalize = vi.fn(() => ({ title: "T", titleSource: "explicit" as const }));
    for (let refresh = 0; refresh < 4; refresh++) {
      for (let id = 0; id < count; id++) cache.read(String(id), ["T", undefined, undefined], normalize);
    }
    // Compact keys do not solve LRU scan thrashing beyond the entry budget.
    expect(normalize).toHaveBeenCalledTimes(count <= 4_096 ? count : count * 4);
  });

  it("distinguishes long input fields, undefined, empty strings, and lone surrogates", () => {
    const cache = new ThreadListTextCache();
    const normalize = vi.fn(() => ({ title: "T", titleSource: "explicit" as const }));
    const a = "a".repeat(300);
    const b = "b".repeat(300);
    const variants = [
      [a, b, undefined], [b, a, undefined], [b, a, ""],
      [b, a, a + "\ud800"], [b, a, a + "\ud801"], [b, a, a + "\ufffd"],
    ] as const;
    for (const inputs of variants) {
      cache.read("id", inputs, normalize);
      cache.read("id", inputs, normalize);
    }
    expect(normalize).toHaveBeenCalledTimes(variants.length);
  });

  it("counts compact keys against the byte budget and does not retain oversized results", () => {
    // A one-character id and title plus a SHA-256 hex key retain 132 bytes.
    const cache = new ThreadListTextCache(10, 264);
    const normalize = vi.fn(() => ({ title: "T", titleSource: "explicit" as const }));
    const inputs = ["x".repeat(10_000), undefined, undefined] as const;
    for (const id of ["a", "b", "a", "b"]) cache.read(id, inputs, normalize);
    expect(normalize).toHaveBeenCalledTimes(2);
    cache.read("c", inputs, normalize);
    cache.read("a", inputs, normalize);
    expect(normalize).toHaveBeenCalledTimes(4);
    const oversized = vi.fn(() => ({ title: "T".repeat(200), titleSource: "explicit" as const }));
    cache.read("a", ["changed", undefined, undefined], oversized);
    cache.read("a", ["changed", undefined, undefined], oversized);
    expect(oversized).toHaveBeenCalledTimes(2);
    // The rejected replacement must not leave the former result behind.
    cache.read("a", inputs, normalize);
    expect(normalize).toHaveBeenCalledTimes(5);
  });

  it.each([10, 100, 1_000])("normalizes %i rows once across unchanged refreshes, then only changed text", (count) => {
    const cache = new ThreadListTextCache();
    const normalize = vi.fn(() => ({ title: "Title", titleSource: "explicit" as const }));
    for (let refresh = 0; refresh < 8; refresh++) {
      for (let id = 0; id < count; id++) cache.read(String(id), ["Title", "preview", "summary"], normalize);
    }
    expect(normalize).toHaveBeenCalledTimes(count);
    // No timestamp heuristic: any text input change must be observed.
    cache.read("0", ["Renamed", "preview", "summary"], normalize);
    cache.read("0", ["Renamed", "changed preview", "summary"], normalize);
    cache.read("0", ["Renamed", "changed preview", "changed summary"], normalize);
    expect(normalize).toHaveBeenCalledTimes(count + 3);
  });

  it("isolates provider clients and callers' mutations", () => {
    const first = new ThreadListTextCache();
    const second = new ThreadListTextCache();
    const normalize = vi.fn(() => ({ title: "Title", titleSource: "explicit" as const }));
    first.read("same-id", ["Title", undefined, undefined], normalize).title = "mutated";
    expect(first.read("same-id", ["Title", undefined, undefined], normalize).title).toBe("Title");
    second.read("same-id", ["Title", undefined, undefined], normalize);
    expect(normalize).toHaveBeenCalledTimes(2);
    first.clear();
    first.read("same-id", ["Title", undefined, undefined], normalize);
    expect(normalize).toHaveBeenCalledTimes(3);
  });

  it("bounds retained entries and bytes without retaining oversized inputs", () => {
    const normalize = vi.fn(() => ({ title: "T", titleSource: "explicit" as const }));
    const cache = new ThreadListTextCache(2, 24);
    cache.read("a", ["a", undefined, undefined], normalize);
    cache.read("b", ["b", undefined, undefined], normalize);
    cache.read("a", ["a", undefined, undefined], normalize);
    cache.read("c", ["c", undefined, undefined], normalize);
    cache.read("b", ["b", undefined, undefined], normalize);
    expect(normalize).toHaveBeenCalledTimes(4);
    cache.read("large", ["x".repeat(30), undefined, undefined], normalize);
    cache.read("large", ["x".repeat(30), undefined, undefined], normalize);
    cache.read("b", ["b", undefined, undefined], normalize);
    expect(normalize).toHaveBeenCalledTimes(6);
    cache.read("bytes", ["12345", undefined, undefined], normalize);
    cache.read("b", ["b", undefined, undefined], normalize);
    expect(normalize).toHaveBeenCalledTimes(8);
  });
});
