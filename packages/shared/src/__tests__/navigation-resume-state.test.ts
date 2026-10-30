import { describe, expect, it } from "vitest";
import { normalizeNavigationResumeState } from "../navigation-resume-state";

const state = {
  version: 1,
  selection: { backend: "codex", threadId: "thread", ownerInstanceId: "peer" },
  expandedByKey: { project: true, closed: false },
  unpinnedExpandedByKey: { project: false },
  loadedRowsByQuery: { inbox: 210 },
};

describe("navigation resume metadata", () => {
  it("retains owner identities, explicit collapses and pagination demand", () => {
    expect(normalizeNavigationResumeState(state)).toEqual(state);
    expect(normalizeNavigationResumeState({ ...state, selection: null })?.selection).toBeNull();
  });

  it.each([undefined, null, {}, { ...state, version: 2 }, { ...state, selection: {} },
    { ...state, selection: { backend: "unknown", threadId: "thread" } },
    { ...state, selection: { backend: "codex", threadId: "" } }])("ignores malformed or unsupported state %j", (value) => {
    expect(normalizeNavigationResumeState(value)).toBeUndefined();
  });

  it("drops invalid scalar entries and extra data", () => {
    expect(normalizeNavigationResumeState({ ...state, transcript: "never retained",
      expandedByKey: { project: true, bogus: "false" },
      loadedRowsByQuery: { valid: 110, negative: -1, fraction: 2.5, infinite: Infinity, oversized: 1_000_000 },
    })).toEqual({ ...state, expandedByKey: { project: true }, loadedRowsByQuery: { valid: 110 } });
  });

  it("bounds the bootstrap payload", () => {
    expect(normalizeNavigationResumeState({ ...state, selection: { backend: "codex", threadId: "x".repeat(20_000) } })).toBeUndefined();
  });
});
