import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildPullRequestStatusKey, type PrSummary } from "@pwragent/shared/contracts/navigation";
import {
  buildStackPrRelevanceScope,
  stackIndexEventInvalidates,
} from "../app-server/navigation-query-source";

const slug = fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,11}$/);
const provider = fc.constantFrom("github.com", "gitlab.com", "github", "gitlab", "git.example.com");

function canonicalHost(value: string): string {
  return value === "github" || value === "gitlab" ? `${value}.com` : value;
}

describe("stackIndexEventInvalidates PR key relevance", () => {
  it("ignores unrelated-repository PR status updates and invalidates on matching or malformed PR events (1,000-case sweep opt-in)", () => {
    // Opt-in 1,000-case sweep for background sidebar stack Git reuse across
    // PR status bursts; CI keeps 100 runs to stay under the property budget.
    const numRuns = process.env.PWRAGENT_STACK_GIT_REUSE_SWEEP === "1" ? 1_000 : 100;
    fc.assert(
      fc.property(
        provider,
        slug,
        slug,
        fc.integer({ min: 1, max: 500 }),
        provider,
        slug,
        slug,
        fc.integer({ min: 1, max: 500 }),
        (stackProvider, stackOrg, stackRepo, stackNum, eventProvider, eventOrg, eventRepo, eventNum) => {
          const attachedPr: PrSummary = {
            provider: stackProvider,
            org: stackOrg,
            repo: stackRepo,
            number: stackNum,
            state: "passing",
            lifecycleState: "open",
            url: `https://${canonicalHost(stackProvider)}/${stackOrg}/${stackRepo}/pull/${stackNum}`,
          };
          const scope = buildStackPrRelevanceScope({
            prs: [attachedPr],
            repositories: [`${canonicalHost(stackProvider)}:${stackOrg}/${stackRepo}`],
          });

          const eventPr: PrSummary = {
            provider: eventProvider,
            org: eventOrg,
            repo: eventRepo,
            number: eventNum,
            state: "failing",
            lifecycleState: "open",
            url: `https://${canonicalHost(eventProvider)}/${eventOrg}/${eventRepo}/pull/${eventNum}`,
          };
          const eventPrKey = buildPullRequestStatusKey(eventPr);
          const sameRepo =
            canonicalHost(stackProvider) === canonicalHost(eventProvider)
            && stackOrg === eventOrg
            && stackRepo === eventRepo;

          expect(
            stackIndexEventInvalidates(
              { method: "pullRequest/status/updated", params: { prKey: eventPrKey, pr: eventPr } },
              scope,
            ),
          ).toBe(sameRepo);

          // Missing or malformed PR key must conservatively invalidate.
          expect(stackIndexEventInvalidates({ method: "pullRequest/status/updated" }, scope)).toBe(true);
          expect(stackIndexEventInvalidates({ method: "pullRequest/status/updated", params: { prKey: "malformed" } }, scope)).toBe(true);
          // Unknown scope must conservatively invalidate.
          expect(
            stackIndexEventInvalidates(
              { method: "pullRequest/status/updated", params: { prKey: eventPrKey, pr: eventPr } },
              undefined,
            ),
          ).toBe(true);
          // Viewer-only events never invalidate native stack projections.
          expect(stackIndexEventInvalidates({ method: "navigation/remoteThreadPins/changed" }, scope)).toBe(false);
          expect(stackIndexEventInvalidates({ method: "federation/peerStatus/changed" }, scope)).toBe(false);
        },
      ),
      { numRuns },
    );
  });

  it("preserves host ports when normalizing catalog repository strings", () => {
    const scope = buildStackPrRelevanceScope({
      repositories: ["ghe.internal:8443:platform/service"],
    });
    expect(
      stackIndexEventInvalidates(
        { method: "pullRequest/status/updated", params: { prKey: "ghe.internal:8443/platform/service#42" } },
        scope,
      ),
    ).toBe(true);
    expect(
      stackIndexEventInvalidates(
        { method: "pullRequest/status/updated", params: { prKey: "ghe.internal:8443/platform/other#42" } },
        scope,
      ),
    ).toBe(false);
    expect(
      stackIndexEventInvalidates(
        { method: "pullRequest/status/updated", params: { prKey: "ghe.internal/platform/service#42" } },
        scope,
      ),
    ).toBe(false);
  });
});
