import { describe, expect, it } from "vitest";

import {
  DEFAULT_THREAD_SEARCH_LIMIT,
  MAX_THREAD_SEARCH_LIMIT,
  isThreadSearchContentMode,
  isThreadSearchSemanticMode,
  normalizeThreadSearchContentMode,
  normalizeThreadSearchLimit,
  normalizeThreadSearchSemanticMode,
} from "../thread-search";

describe("thread search contracts", () => {
  it("recognizes content and semantic modes", () => {
    expect(isThreadSearchContentMode("available")).toBe(true);
    expect(isThreadSearchContentMode("provider")).toBe(false);
    expect(isThreadSearchSemanticMode("required")).toBe(true);
    expect(isThreadSearchSemanticMode("remote")).toBe(false);
  });

  it("normalizes result limits to bounded whole numbers", () => {
    expect(normalizeThreadSearchLimit(undefined)).toBe(
      DEFAULT_THREAD_SEARCH_LIMIT,
    );
    expect(normalizeThreadSearchLimit(0)).toBe(1);
    expect(normalizeThreadSearchLimit(3.9)).toBe(3);
    expect(normalizeThreadSearchLimit(10_000)).toBe(MAX_THREAD_SEARCH_LIMIT);
  });

  it("defaults content search to available and semantic search to disabled", () => {
    expect(normalizeThreadSearchContentMode(undefined)).toBe("available");
    expect(normalizeThreadSearchContentMode("required")).toBe("required");
    expect(normalizeThreadSearchSemanticMode(undefined)).toBe("disabled");
    expect(normalizeThreadSearchSemanticMode("available")).toBe("available");
  });
});
