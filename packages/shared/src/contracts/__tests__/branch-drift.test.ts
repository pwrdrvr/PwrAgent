import { describe, expect, it } from "vitest";

import { isBranchDrifted } from "../branch-drift";

describe("isBranchDrifted", () => {
  it("returns false when both args are undefined", () => {
    expect(isBranchDrifted(undefined, undefined)).toBe(false);
  });

  it("returns false when expected is undefined", () => {
    expect(isBranchDrifted(undefined, "main")).toBe(false);
  });

  it("returns false when observed is undefined", () => {
    expect(isBranchDrifted("main", undefined)).toBe(false);
  });

  it("returns false when both are equal named branches", () => {
    expect(isBranchDrifted("main", "main")).toBe(false);
  });

  it("returns true when expected is HEAD and observed is a named branch", () => {
    expect(isBranchDrifted("HEAD", "fix/release-skill-squash-merge")).toBe(true);
  });

  it("returns true when observed is HEAD and expected is a named branch", () => {
    expect(isBranchDrifted("main", "HEAD")).toBe(true);
  });

  it("returns false when both are HEAD", () => {
    expect(isBranchDrifted("HEAD", "HEAD")).toBe(false);
  });

  it("returns true when both are different named branches", () => {
    expect(isBranchDrifted("main", "feature/x")).toBe(true);
  });

  it("treats empty strings as missing", () => {
    expect(isBranchDrifted("", "main")).toBe(false);
    expect(isBranchDrifted("main", "")).toBe(false);
  });
});
