import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { AppServerReviewTarget } from "@pwragent/shared/contracts/normalized-app-server";
import type { ReviewRunMode } from "@pwragent/shared/contracts/agent";
import type { ScheduledThreadReviewPayload } from "@pwragent/shared/contracts/scheduled-thread-actions";
import { federationReviewRoute } from "@pwragent/federation/federation-backend-methods";
import { keepsCapturedReview } from "../scheduled-actions/scheduled-thread-action-service";

const url = (number: number) => `https://github.com/fixture/project/pull/${number}`;
const target: fc.Arbitrary<AppServerReviewTarget> = fc.oneof(
  fc.integer({ min: 1, max: 4 }).map((number) => ({ type: "pullRequest" as const, url: url(number) })),
  fc.array(fc.integer({ min: 1, max: 4 }), { minLength: 2, maxLength: 3 })
    .map((numbers) => ({ type: "pullRequests" as const, pullRequests: numbers.map((number) => ({ url: url(number) })) })),
  fc.constant({ type: "uncommittedChanges" as const }),
  fc.constant({ type: "baseBranch" as const, branch: "main" }),
  fc.constant({ type: "commit" as const, sha: "a".repeat(40), title: null }),
  fc.constant({ type: "custom" as const, instructions: "look" }),
  fc.constant({ type: "branch" as const, branch: "feature" }),
  fc.constant({ type: "path" as const, path: "src" }),
);
const runMode = fc.option(
  fc.constantFrom<ReviewRunMode>("codex-sub-agent", "pwragent-sub-agent", "claude-code-review"),
  { nil: undefined },
);
const cwd = fc.option(fc.constantFrom("/a", "/b"), { nil: undefined });

describe("federationReviewRoute", () => {
  it("sends every target or mode an older owner lacks on the extended routes", () => {
    fc.assert(fc.property(target, runMode, (reviewTarget, mode) => {
      const route = federationReviewRoute({ target: reviewTarget, ...(mode ? { runMode: mode } : {}) });
      const extended = mode === "claude-code-review"
        || ["pullRequests", "branch", "path"].includes(reviewTarget.type);
      expect(route).toBe(extended ? "extended" : reviewTarget.type === "pullRequest" ? "pullRequest" : "review");
    }));
  });
});

describe("keepsCapturedReview", () => {
  const payload = (reviewTarget: AppServerReviewTarget, mode: ReviewRunMode | undefined, where: string | undefined) =>
    ({ target: reviewTarget, ...(mode ? { runMode: mode } : {}), ...(where ? { cwd: where } : {}) }) as ScheduledThreadReviewPayload;
  const urls = (reviewTarget: AppServerReviewTarget): string[] | undefined =>
    reviewTarget.type === "pullRequest" ? [reviewTarget.url]
      : reviewTarget.type === "pullRequests" ? reviewTarget.pullRequests.map((member) => member.url)
        : undefined;

  it("keeps captured commits only for the same pull requests, in order, in the same workspace", () => {
    fc.assert(fc.property(target, runMode, cwd, target, runMode, cwd, (
      currentTarget, currentMode, currentCwd, nextTarget, nextMode, nextCwd,
    ) => {
      const kept = keepsCapturedReview(
        payload(currentTarget, currentMode, currentCwd),
        payload(nextTarget, nextMode, nextCwd),
      );
      const captured = (mode: ReviewRunMode | undefined, reviewTarget: AppServerReviewTarget) =>
        mode !== "claude-code-review" && urls(reviewTarget) !== undefined;
      const expected = captured(currentMode, currentTarget) && captured(nextMode, nextTarget)
        && currentTarget.type === nextTarget.type
        && JSON.stringify(urls(currentTarget)) === JSON.stringify(urls(nextTarget))
        && (!nextCwd || nextCwd === currentCwd);
      expect(kept).toBe(expected);
    }), { numRuns: 500 });
  });
});
