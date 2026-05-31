import { describe, expect, it } from "vitest";
import { isCanonicalProfileName, normalizeProfileName } from "../profile-names";

describe("profile names", () => {
  it.each([
    ["work", "work"],
    ["work-", "work-"],
    ["work_", "work_"],
    ["Work", "work"],
    ["My Work Profile", "my-work-profile"],
    ["Hunt's Ops/Profile", "hunt-s-ops-profile"],
    ["Café Déjà Vu", "cafe-deja-vu"],
    [" personal__2026 ", "personal__2026"],
    ["con", "con-profile"],
    ["...", ""],
    ["a".repeat(40), "a".repeat(32)],
  ])("normalizes %j to %j", (input, expected) => {
    expect(normalizeProfileName(input)).toBe(expected);
  });

  it.each([
    ["work", true],
    ["personal-2026", true],
    ["my_profile", true],
    ["work-", true],
    ["work_", true],
    ["a".repeat(32), true],
    ["a".repeat(33), false],
    ["Work", false],
    ["has space", false],
    ["con", false],
    ["", false],
  ])("checks canonical profile id %j -> %s", (input, expected) => {
    expect(isCanonicalProfileName(input)).toBe(expected);
  });
});
