import { describe, expect, it, vi } from "vitest";
import { ThreadListTextCache } from "../codex-app-server/thread-list-text-cache";

describe("provider thread listing text work", () => {
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
