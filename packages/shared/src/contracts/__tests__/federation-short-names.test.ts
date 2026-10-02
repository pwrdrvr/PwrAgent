import { describe, expect, it } from "vitest";
import {
  federationShortLabelFor,
  isFederationInstanceShortName,
  mergeFederationInstanceShortNames,
  normalizeFederationShortName,
  type FederationInstanceShortName,
} from "../federation-short-names";
import { formatFederationPeerDisplayLabelParts } from "../federation";

function entry(overrides: Partial<FederationInstanceShortName> = {}): FederationInstanceShortName {
  return {
    instanceId: "inst_a",
    shortLabel: "M5 Max",
    basis: "Studio-MBP-M5-Max",
    source: "auto",
    updatedAt: 100,
    ...overrides,
  };
}

describe("normalizeFederationShortName", () => {
  it("collapses whitespace and trims", () => {
    expect(normalizeFederationShortName("  M5\t Max ")).toBe("M5 Max");
  });

  it("allows exactly twelve code points and no more", () => {
    expect(normalizeFederationShortName("abcdefghijkl")).toBe("abcdefghijkl");
    expect(normalizeFederationShortName("abcdefghijklm")).toBeUndefined();
    // Counted in code points, so an astral glyph is one character.
    expect(normalizeFederationShortName("🍎 M5 Max")).toBe("🍎 M5 Max");
  });

  it("rejects empty, non-string, and control or format characters", () => {
    expect(normalizeFederationShortName("   ")).toBeUndefined();
    expect(normalizeFederationShortName(42)).toBeUndefined();
    expect(normalizeFederationShortName("M5\u0007Max")).toBeUndefined();
    expect(normalizeFederationShortName("M5​Max")).toBeUndefined();
  });
});

describe("isFederationInstanceShortName", () => {
  it("accepts a well-formed entry and rejects an unnormalized name", () => {
    expect(isFederationInstanceShortName(entry())).toBe(true);
    expect(isFederationInstanceShortName(entry({ shortLabel: " M5 Max" }))).toBe(false);
    expect(isFederationInstanceShortName(entry({ shortLabel: "a much too long name" }))).toBe(false);
    expect(isFederationInstanceShortName(entry({ basis: "" }))).toBe(false);
    expect(isFederationInstanceShortName({ ...entry(), source: "other" })).toBe(false);
  });
});

describe("federationShortLabelFor", () => {
  it("draws the short name only for the label it was made for", () => {
    expect(federationShortLabelFor(entry(), "Studio-MBP-M5-Max")).toBe("M5 Max");
    // The machine was renamed: its full label shows until it is named again.
    expect(federationShortLabelFor(entry(), "Studio-M5-Max")).toBeUndefined();
    expect(federationShortLabelFor(entry({ removed: true }), "Studio-MBP-M5-Max")).toBeUndefined();
    expect(federationShortLabelFor(undefined, "Studio-MBP-M5-Max")).toBeUndefined();
    expect(federationShortLabelFor(entry({ shortLabel: "MBP", basis: "MBP" }), "MBP")).toBeUndefined();
  });
});

describe("mergeFederationInstanceShortNames", () => {
  it("is last-writer-wins and reports no change for a replayed snapshot", () => {
    const current = [entry()];
    const newer = entry({ shortLabel: "Studio M5", updatedAt: 200 });
    const merged = mergeFederationInstanceShortNames(current, [newer]);
    expect(merged.changed).toBe(true);
    expect(merged.entries).toEqual([newer]);

    const replay = mergeFederationInstanceShortNames(merged.entries, [entry()]);
    expect(replay.changed).toBe(false);
    expect(replay.entries).toEqual([newer]);
  });

  it("breaks a same-instant tie removal first, then override first", () => {
    const auto = entry();
    const override = entry({ source: "override", shortLabel: "Studio" });
    const removed = entry({ removed: true });
    expect(mergeFederationInstanceShortNames([auto], [override]).entries).toEqual([override]);
    expect(mergeFederationInstanceShortNames([override], [auto]).changed).toBe(false);
    expect(mergeFederationInstanceShortNames([override], [removed]).entries).toEqual([removed]);
  });

  it("drops malformed incoming entries", () => {
    const merged = mergeFederationInstanceShortNames([], [
      { instanceId: "x" } as FederationInstanceShortName,
    ]);
    expect(merged).toEqual({ entries: [], changed: false });
  });
});

describe("formatFederationPeerDisplayLabelParts with a short name", () => {
  it("passes the short name through and still decides the profile on full labels", () => {
    const peers = [
      { label: "Studio-MBP-M5-Max", profileName: "default", shortLabel: "M5 Max" },
      { label: "Studio-MBP-M5-Max", profileName: "dev", shortLabel: "M5 Max" },
      { label: "Mac-Mini-M4", profileName: "default", shortLabel: "M4 Mini" },
    ];
    expect(formatFederationPeerDisplayLabelParts(peers[1], peers)).toEqual({
      label: "Studio-MBP-M5-Max",
      profileName: "dev",
      shortLabel: "M5 Max",
    });
    expect(formatFederationPeerDisplayLabelParts(peers[2], peers)).toEqual({
      label: "Mac-Mini-M4",
      shortLabel: "M4 Mini",
    });
  });
});
