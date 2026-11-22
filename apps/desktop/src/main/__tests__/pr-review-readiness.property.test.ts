import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  describePrReviewReadiness,
  derivePrReviewReadiness,
  desiredPrOffer,
  parsePrOfferId,
  planPrOffer,
  prGateReadiness,
  type PrReadinessPr,
  type PrReviewCoverage,
  type PrReviewReadiness,
} from "../pr-status/pr-review-readiness";

/*
 * The promises in docs/pr-review-readiness.md:
 *
 * - A merge is offered only for a head that a review covers and whose newest
 *   covering review has no open findings, with CI green on that head.
 * - A review is offered only when CI is green, no review covers the head,
 *   and the latest review has no open findings (commits pushed while it
 *   does are its fixes).
 * - Waiting states (CI running or failing, a conflict, a draft, a queue, a
 *   closed PR) never raise an offer.
 * - An offer id names its PR and, for a merge, its head; reading it back
 *   gives the same PR.
 */

const SHA = fc.stringMatching(/^[0-9a-f]{40}$/);
const PR_KEY = fc.constantFrom("github.com:pwrdrvr/PwrAgent#12", "gitlab.com:group/sub:x#3");

const pr: fc.Arbitrary<PrReadinessPr> = fc.record({
  headSha: fc.option(SHA, { nil: undefined }),
  state: fc.constantFrom("passing", "failing", "pending", "unknown"),
  checkState: fc.option(fc.constantFrom("passing", "failing", "pending", "unknown"), { nil: undefined }),
  checksStillRunning: fc.option(fc.boolean(), { nil: undefined }),
  checksAllSkipped: fc.option(fc.constant(true as const), { nil: undefined }),
  lifecycleState: fc.option(fc.constantFrom("open", "merged", "closed"), { nil: undefined }),
  reviewState: fc.option(fc.constantFrom("draft", "ready_for_review"), { nil: undefined }),
  mergeState: fc.option(fc.constantFrom("mergeable", "conflicting", "unknown"), { nil: undefined }),
  mergeQueue: fc.option(fc.record({
    kind: fc.constantFrom("merge_queue" as const, "merge_train" as const),
    state: fc.constantFrom("not_queued", "queued", "group_checks_running", "merging", "unmergeable", "removed", "merged_by_queue"),
  }), { nil: undefined }),
}) as fc.Arbitrary<PrReadinessPr>;

const reviews: fc.Arbitrary<PrReviewCoverage[]> = fc.array(fc.record({
  reviewId: fc.uuid(),
  createdAt: fc.integer({ min: 0, max: 1_000_000 }),
  coversHead: fc.boolean(),
  openFindings: fc.nat({ max: 3 }),
}), { maxLength: 6 });

const ciGreen = (value: PrReadinessPr): boolean =>
  !value.checksStillRunning
  && (value.checkState ?? value.state) === "passing"
  && !value.checksAllSkipped;

describe("PR review readiness", () => {
  it("offers a merge only for a covered, settled head with green CI", () => {
    fc.assert(fc.property(pr, reviews, (value, coverage) => {
      const result = derivePrReviewReadiness({ pr: value, reviews: coverage });
      if (result.readiness !== "ready_to_merge") return;
      expect(ciGreen(value)).toBe(true);
      expect(value.lifecycleState === "merged" || value.lifecycleState === "closed").toBe(false);
      expect(value.mergeState).not.toBe("conflicting");
      const covering = coverage.filter((review) => review.coversHead);
      expect(covering.length).toBeGreaterThan(0);
      const newest = Math.max(...covering.map((review) => review.createdAt));
      // Ties between equally new reviews: whichever decided must be settled.
      const decided = covering.find((review) => review.reviewId === result.reviewId)!;
      expect(decided.createdAt).toBe(newest);
      expect(decided.openFindings).toBe(0);
    }));
  });

  it("offers a review only when CI is green, nothing covers the head, and the latest review is settled", () => {
    fc.assert(fc.property(pr, reviews, (value, coverage) => {
      const result = derivePrReviewReadiness({ pr: value, reviews: coverage });
      const latestOpen = coverage.length > 0
        && coverage.filter((review) => review.createdAt === Math.max(...coverage.map((entry) => entry.createdAt)))
          .some((review) => review.openFindings > 0);
      // Ties at the latest time: which one counts as latest is unspecified.
      const latestTies = coverage.filter((review) => review.createdAt === Math.max(...coverage.map((entry) => entry.createdAt)));
      fc.pre(new Set(latestTies.map((review) => review.openFindings > 0)).size <= 1);
      expect(result.readiness === "needs_review").toBe(
        prGateReadiness(value) === undefined && !coverage.some((review) => review.coversHead) && !latestOpen,
      );
      if (result.readiness === "needs_review") expect(ciGreen(value)).toBe(true);
    }));
  });

  it("raises nothing in a waiting state, and withdraws a merge offer for any other head", () => {
    const waiting = fc.constantFrom<PrReviewReadiness>(
      "closed", "draft", "no_head", "queued", "conflicting", "ci_pending", "ci_failing", "ci_untested", "findings_open",
    );
    fc.assert(fc.property(PR_KEY, waiting, SHA, SHA, fc.constantFrom("review" as const, "merge" as const), (prKey, readiness, head, offeredHead, kind) => {
      expect(desiredPrOffer({ prKey, readiness, headSha: head })).toBeUndefined();
      const plan = planPrOffer({
        open: { cardId: "card", kind, offerId: "pr-offer:x", headSha: offeredHead },
        readiness,
        headSha: head,
      });
      expect(plan.raise).toBeUndefined();
      if (kind === "merge" && offeredHead !== head) expect(plan.retire?.cardId).toBe("card");
      if (readiness === "closed") expect(plan.retire?.cardId).toBe("card");
    }));
  });

  it("keeps an open offer that is already the desired one, and swaps any other", () => {
    fc.assert(fc.property(PR_KEY, SHA, fc.option(SHA, { nil: undefined }), fc.constantFrom<PrReviewReadiness>("needs_review", "ready_to_merge"), (prKey, head, content, readiness) => {
      const desired = desiredPrOffer({ prKey, readiness, headSha: head, ...(content ? { headContentId: content } : {}) })!;
      expect(planPrOffer({
        open: { cardId: "card", kind: desired.kind, offerId: desired.offerId, headSha: head },
        desired,
        readiness,
        headSha: head,
      })).toEqual({});
      expect(planPrOffer({
        open: { cardId: "card", kind: "review", offerId: "pr-offer:review:other:sha:0", headSha: head },
        desired,
        readiness,
        headSha: head,
      })).toEqual({ retire: { cardId: "card", reason: "superseded" }, raise: desired });
    }));
  });

  it("reads an offer id back to its PR and head", () => {
    fc.assert(fc.property(PR_KEY, SHA, fc.option(SHA, { nil: undefined }), fc.constantFrom<PrReviewReadiness>("needs_review", "ready_to_merge"), (prKey, head, content, readiness) => {
      const offer = desiredPrOffer({ prKey, readiness, headSha: head, ...(content ? { headContentId: content } : {}) })!;
      const parsed = parsePrOfferId(offer.offerId)!;
      expect(parsed.kind).toBe(offer.kind);
      expect(parsed.prKey).toBe(prKey);
      if (offer.kind === "merge") expect(parsed.headSha).toBe(head);
    }));
  });

  it("never tells the agent a merge is coming while the head is unreviewed or findings are open", () => {
    const readiness = fc.constantFrom<PrReviewReadiness>(
      "draft", "no_head", "queued", "conflicting", "ci_pending", "ci_failing", "ci_untested", "needs_review", "findings_open", "ready_to_merge",
    );
    fc.assert(fc.property(readiness, fc.boolean(), fc.nat({ max: 3 }), SHA, (value, reviewed, openFindings, head) => {
      const text = describePrReviewReadiness({ prNumber: 418, readiness: value, headSha: head, reviewed, openFindings });
      if (!reviewed || openFindings > 0) expect(text).not.toMatch(/PwrAgent offers the merge(;|\.| once)/);
      if (!reviewed && openFindings === 0) expect(text).toContain("Do not offer a merge");
    }));
  });
});
