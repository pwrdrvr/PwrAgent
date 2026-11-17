import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { redactDisplayValue } from "../mcp-elicitation";

// A git object id: SHA-1 (40) or SHA-256 (64) lowercase hex.
const objectId = fc.oneof(
  fc.stringMatching(/^[0-9a-f]{40}$/),
  fc.stringMatching(/^[0-9a-f]{64}$/),
);

// Keys that name a commit. The operator must see this value to know what
// an approval such as "merge at expectedHeadSha" acts on.
const commitKey = fc.constantFrom(
  "sha",
  "headSha",
  "expectedHeadSha",
  "expected_head_sha",
  "commitSha",
  "baseOid",
  "oid",
  "commit",
  "headCommit",
  "rev",
  "revision",
);

// Keys that say nothing about commits. A 40-hex value here may be a classic
// GitHub personal access token, so it stays hidden.
const otherKey = fc.constantFrom("value", "labels", "body", "id", "data", "query");

describe("redactDisplayValue commit ids", () => {
  it("shows a git object id under a commit-naming key, top-level or nested", () => {
    fc.assert(fc.property(commitKey, objectId, (key, sha) => {
      expect(redactDisplayValue(sha, { key })).toBe(sha);
      expect(JSON.parse(redactDisplayValue({ [key]: sha }, { key: "arguments" }))).toEqual({ [key]: sha });
    }));
  });

  it("keeps a bare hex token hidden under any other key", () => {
    fc.assert(fc.property(otherKey, objectId, (key, sha) => {
      expect(redactDisplayValue(sha, { key })).toBe("[redacted]");
      expect(redactDisplayValue(sha)).toBe("[redacted]");
    }));
  });

  it("keeps non-hex tokens hidden even under a commit-naming key", () => {
    const token = fc.stringMatching(/^[A-Za-z0-9_-]{40}$/).filter((value) => !/^[0-9a-f]{40}$/.test(value));
    fc.assert(fc.property(commitKey, token, (key, value) => {
      expect(redactDisplayValue(value, { key })).toBe("[redacted]");
    }));
  });
});
