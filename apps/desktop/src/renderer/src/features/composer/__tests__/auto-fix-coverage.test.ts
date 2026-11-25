import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { PrSummary } from "@pwragent/shared/contracts/navigation";
import { describeAutoFixCoverage } from "../auto-fix-coverage";

const pr = (org: string, number: number, patch: Partial<PrSummary> = {}): PrSummary => ({
  provider: "github.com", org, repo: "t3code", number, state: "passing", lifecycleState: "open",
  url: `https://github.com/${org}/t3code/pull/${number}`, ...patch,
});
const primaryGitRepository = "github.com/fork/t3code";
const fromFork = { sourceRepository: { provider: "github.com", org: "fork", repo: "t3code" } };

describe("describeAutoFixCoverage", () => {
  it("covers open PRs on the primary repository, an upstream PR opened from it included", () => {
    const coverage = describeAutoFixCoverage({
      primaryGitRepository,
      prs: [
        pr("fork", 3),
        pr("upstream", 7, fromFork),
        pr("upstream", 8, { ...fromFork, lifecycleState: "merged", state: "merged" }),
        pr("other", 1),
      ],
    }, undefined);
    expect(coverage.map((entry) => [entry.label, entry.state])).toEqual([
      ["fork/t3code#3", "on"], ["upstream/t3code#7", "on"],
    ]);
  });

  it("a hands-off match outranks the PR's own switch, and only the switch makes a PR off", () => {
    fc.assert(fc.property(
      fc.boolean(), fc.boolean(), fc.option(fc.constantFrom<string[]>(["takeover:yes"], ["bug"], []), { nil: undefined }),
      (switchedOff, labelRule, labels) => {
        const automation = { handsOff: [labelRule ? { repository: "upstream/t3code", label: "takeover:*" } : { repository: "elsewhere/t3code" }] };
        const [entry] = describeAutoFixCoverage({
          primaryGitRepository,
          prs: [pr("upstream", 7, { ...fromFork, ...(switchedOff ? { autoFixOff: true as const } : {}), ...(labels ? { labels } : {}) })],
        }, automation);
        const handsOff = labelRule && labels?.includes("takeover:yes") === true;
        expect(entry!.state).toBe(handsOff ? "hands-off" : switchedOff ? "off" : "on");
        expect(entry!.reason).toBe(handsOff ? "hands-off, labeled takeover:yes" : undefined);
      },
    ));
  });
});
