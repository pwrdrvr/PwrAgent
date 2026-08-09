import { describe, expect, it } from "vitest";

import { isBranchDrifted } from "../branch-drift";

const BRANCH_DRIFT_CASES: Array<[
  scenario: string,
  expected: string | undefined,
  observed: string | undefined,
  drifted: boolean,
]> = [
  ["missing expected branch", undefined, "main", false],
  ["missing observed branch", "main", undefined, false],
  ["equal named branches", "main", "main", false],
  [
    "HEAD expected and a named branch observed",
    "HEAD",
    "fix/release-skill-squash-merge",
    true,
  ],
  ["a named branch expected and HEAD observed", "main", "HEAD", true],
  ["HEAD on both sides", "HEAD", "HEAD", false],
  ["different named branches", "main", "feature/x", true],
  ["an empty expected branch", "", "main", false],
  ["an empty observed branch", "main", "", false],
];

describe("isBranchDrifted", () => {
  it.each(BRANCH_DRIFT_CASES)("handles %s", (_scenario, expected, observed, drifted) => {
    expect(isBranchDrifted(expected, observed)).toBe(drifted);
  });
});
