import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { PrSummary } from "@pwragent/shared/contracts/navigation";
import { prSummariesEqual } from "../app-server/thread-pull-request-summaries";

/**
 * `prSummariesEqual` decides whether a poll's PR is republished. Its comment
 * promises that every field a client renders or main reads for behavior is
 * compared: one it skips moves without any window hearing about it, and its
 * status transition (a merge queue removal wakes a thread) never fires.
 *
 * The oracle is this table. It names EVERY `PrSummary` key, so TypeScript
 * fails here when a field is added without a decision. A key maps to two
 * different values the field can hold, or to the reason a change to it alone
 * is not news.
 */
type Variants = { [K in keyof Required<PrSummary>]: readonly [PrSummary[K], PrSummary[K]] | { notCompared: string } };

const VARIANTS: Variants = {
  provider: ["github.com", "github.example.com"],
  number: [743, 744],
  org: ["pwrdrvr", "acme"],
  repo: ["PwrAgent", "widgets"],
  sourceRepository: [undefined, { provider: "github.com", org: "fork", repo: "PwrAgent" }],
  title: ["Retain thread pull request history", "Retain thread history"],
  labels: [undefined, ["takeover:in-progress"]],
  baseRefName: ["main", "release"],
  baseSha: { notCompared: "the base tip moves on every merge to the base; nothing drawn reads it" },
  headRefName: ["feat/history", "feat/other"],
  linkedDirectoryPaths: [undefined, ["/work/PwrAgent"]],
  explicitlyAttached: [undefined, true],
  autoFixOff: [undefined, true],
  state: ["passing", "failing"],
  checkState: ["passing", "failing"],
  checksStillRunning: [undefined, true],
  checksAllSkipped: [undefined, true],
  lifecycleState: ["open", "merged"],
  reviewState: ["ready_for_review", "draft"],
  mergeState: ["mergeable", "conflicting"],
  mergeQueue: [undefined, { kind: "merge_queue", state: "removed", removedAt: 1_700_000_100_000 }],
  allowedMergeMethods: [undefined, ["squash"]],
  githubStack: [undefined, { number: 4402, position: 2, size: 2 }],
  headSha: ["9f2c41e", "1b7d03a"],
  failedCheckUrl: { notCompared: "it changes only with the checks or the head, which are compared" },
  commitShas: [undefined, ["9f2c41e"]],
  additions: [412, 530],
  deletions: [198, 4],
  changedFiles: [18, 21],
  commitCount: [7, 9],
  createdAt: [1_700_000_000_000, 1_700_000_999_000],
  mergedAt: [undefined, 1_800_000_000_000],
  closedAt: [undefined, 1_800_000_000_000],
  url: ["https://github.com/pwrdrvr/PwrAgent/pull/743", "https://github.com/pwrdrvr/PwrAgent/pull/744"],
};

const COMPARED = (Object.keys(VARIANTS) as (keyof PrSummary)[])
  .filter((key) => Array.isArray(VARIANTS[key]));

/** A PR built from one of each field's two values. */
const arbitraryPr = fc.record(Object.fromEntries(COMPARED.map((key) => {
  const [first, second] = VARIANTS[key] as readonly [unknown, unknown];
  return [key, fc.constantFrom(first, second)];
}))).map((fields) => Object.fromEntries(
  Object.entries(fields).filter(([, value]) => value !== undefined),
) as PrSummary);

function withOther(pr: PrSummary, key: keyof PrSummary): PrSummary {
  const [first, second] = VARIANTS[key] as readonly [unknown, unknown];
  const next = JSON.stringify(pr[key]) === JSON.stringify(first) ? second : first;
  const copy: Record<string, unknown> = { ...pr };
  if (next === undefined) delete copy[key];
  else copy[key] = next;
  return copy as PrSummary;
}

describe("prSummariesEqual (property)", () => {
  it("judges a PR equal to an identical copy", () => {
    fc.assert(fc.property(arbitraryPr, (pr) => {
      expect(prSummariesEqual([pr], [structuredClone(pr)])).toBe(true);
    }));
  });

  it("detects a change to any compared field alone", () => {
    fc.assert(fc.property(arbitraryPr, fc.constantFrom(...COMPARED), (pr, key) => {
      expect(prSummariesEqual([pr], [withOther(pr, key)])).toBe(false);
    }));
  });
});
