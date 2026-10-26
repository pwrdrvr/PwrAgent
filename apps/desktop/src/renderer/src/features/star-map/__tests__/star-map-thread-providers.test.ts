import { describe, expect, it } from "vitest";
import type { NavigationCounts } from "@pwragent/shared";
import { starMapThreadProviders } from "../star-map-thread-providers";

function counts(backends?: NavigationCounts["backends"]): NavigationCounts {
  return { total: 1, active: 0, unread: 0, review: 0, ...(backends ? { backends } : {}) };
}

describe("starMapThreadProviders", () => {
  it("joins every instance's providers", () => {
    expect(starMapThreadProviders({
      instanceCounts: [counts(["codex"]), counts(["claude"])],
      threads: [],
    })).toEqual(["claude", "codex"]);
  });

  it("keeps one provider when every instance uses it", () => {
    expect(starMapThreadProviders({
      instanceCounts: [counts(["codex"]), counts(["codex"])],
      threads: [{ source: "codex" }],
    })).toEqual(["codex"]);
  });

  it("adds the providers of loaded cards from instances that have not answered", () => {
    expect(starMapThreadProviders({
      instanceCounts: [counts(["codex"]), undefined],
      threads: [{ source: "acp:gemini" }],
    })).toEqual(["acp:gemini", "codex"]);
  });

  it("is unknown when an instance answers without a provider list", () => {
    // An owner that predates the list cannot say which providers it has.
    expect(starMapThreadProviders({
      instanceCounts: [counts(["codex"]), counts()],
      threads: [],
    })).toBeUndefined();
  });
});
