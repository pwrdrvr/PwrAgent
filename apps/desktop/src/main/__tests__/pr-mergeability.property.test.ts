import fc from "fast-check";
import { expect, it } from "vitest";
import type { PrSummary } from "@pwragent/shared/contracts/navigation";
import { prSummariesEqual, stabilizePolledPrMergeState } from "../app-server/thread-pull-request-summaries";
import { computePrStatusTransition } from "../pr-status/pr-transitions";

const pr = {
  provider: "github.com",
  org: "fixture",
  repo: "stack",
  number: 1,
  url: "https://github.com/fixture/stack/pull/1",
  lifecycleState: "open",
  state: "passing",
  checkState: "passing",
  headRefName: "topic",
  headSha: "a".repeat(40),
  baseRefName: "main",
  baseSha: "b".repeat(40),
} satisfies PrSummary;

it("inserting pending GitHub calculations between the same tips leaves the definitive status changes intact", () => {
  const knownMergeState = fc.constantFrom("mergeable", "conflicting");
  const polls = fc.array(fc.record({ mergeState: knownMergeState, pendingReads: fc.nat(4) }), { minLength: 1, maxLength: 12 });
  fc.assert(fc.property(knownMergeState, polls, (initial, observations) => {
    const expected = [];
    let lastKnown = initial;
    for (const { mergeState } of observations) {
      if (mergeState !== lastKnown) expected.push({ from: lastKnown, to: mergeState });
      lastKnown = mergeState;
    }

    const actual = [];
    let previous: PrSummary = { ...pr, mergeState: initial };
    for (const { mergeState, pendingReads } of observations) {
      for (const state of [...Array.from({ length: pendingReads }, () => "unknown" as const), mergeState]) {
        const next = stabilizePolledPrMergeState(previous, { ...pr, mergeState: state });
        if (!prSummariesEqual([previous], [next])) {
          actual.push(computePrStatusTransition(previous, next)?.changed.mergeState);
        }
        previous = next;
      }
    }
    expect(actual).toEqual(expected);
    expect(previous.mergeState).toBe(lastKnown);
  }));
});

const pending = { ...pr, mergeState: "unknown" } satisfies PrSummary;
const conflicting = { ...pr, mergeState: "conflicting" } satisfies PrSummary;

it.each<[string, PrSummary | undefined, PrSummary]>([
  ["first observation", undefined, pending],
  ["no previous result", pending, pending],
  ["legacy head", { ...conflicting, headSha: undefined }, pending],
  ["missing base tip", conflicting, { ...pending, baseSha: undefined }],
  ["new head tip", conflicting, { ...pending, headSha: "c".repeat(40) }],
  ["new base tip", conflicting, { ...pending, baseSha: "c".repeat(40) }],
  ["head ref changed", conflicting, { ...pending, headRefName: "new-topic" }],
  ["base retargeted", conflicting, { ...pending, baseRefName: "release" }],
  ["closed", conflicting, { ...pending, lifecycleState: "closed" }],
  ["merged", conflicting, { ...pending, lifecycleState: "merged" }],
  ["reopened", { ...conflicting, lifecycleState: "closed" }, pending],
  ["GitLab merge status", { ...conflicting, provider: "gitlab.com", url: "https://gitlab.com/fixture/stack/-/merge_requests/1" },
    { ...pending, provider: "gitlab.com", url: "https://gitlab.com/fixture/stack/-/merge_requests/1" }],
])("keeps the observed unknown result for %s", (_reason, previous, next) => {
  expect(stabilizePolledPrMergeState(previous, next)).toBe(next);
});
