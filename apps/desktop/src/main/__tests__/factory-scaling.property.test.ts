import fc from "fast-check";
import { expect, it } from "vitest";
import type { FactoryCleanCandidate } from "../factory/factory-branch-evidence";
import { createFactoryScalingReceipt, factoryScalingStatus } from "../factory/factory-scaling-receipt";

it("a reported failure can be current only for a clean matching branch, head and base", () => {
  const hex = (digit: string) => digit.repeat(40);
  const revision = { headOid: hex("a"), baseOid: hex("b") };
  const branch = "factory/candidate";
  const baseRef = "refs/remotes/origin/main";
  const sample = fc.record({
    observed: fc.constantFrom("clean", "dirty", "unverified"),
    headAdvanced: fc.boolean(), baseAdvanced: fc.boolean(), differentBranch: fc.boolean(), differentBase: fc.boolean(),
    reportMissing: fc.boolean(), exitCode: fc.constantFrom(0, 1), measured: fc.nat(32), bound: fc.nat(32),
  });
  fc.assert(fc.property(sample, (input) => {
    const receipt = input.reportMissing ? undefined : createFactoryScalingReceipt({
      version: 1, source: "operator_attested", approvalId: "00000000-0000-4000-8000-000000000001",
      repository: "pwrdrvr/synthetic", projectKey: "directory:/project", issueId: "00000000-0000-4000-8000-000000000262",
      worktree: "/candidate", branch, baseRef, revision, previousReceiptId: null,
      report: { exitCode: input.exitCode, counterexamples: [], workloads: [{ name: "Probe", proof: "file:///probe.json", samples: [
        { sizes: { refs: 16 }, counters: { work: { measured: 0, bound: 0 } } },
        { sizes: { refs: 64 }, counters: { work: { measured: input.measured, bound: input.bound } } },
      ] }] },
    });
    const candidate: FactoryCleanCandidate = input.observed === "clean" ? {
      state: "clean", baseBranch: "main", headOid: input.headAdvanced ? hex("c") : revision.headOid, baseOid: input.baseAdvanced ? hex("d") : revision.baseOid,
    } : { state: input.observed };
    const actual = factoryScalingStatus(receipt, candidate, input.differentBranch ? "other" : branch, input.differentBase ? "refs/heads/main" : baseRef);
    const matching = input.observed === "clean" && !input.headAdvanced && !input.baseAdvanced && !input.differentBranch && !input.differentBase;
    const passing = input.exitCode === 0 && input.measured <= input.bound;
    expect(actual).toBe(input.reportMissing ? "missing" : !matching ? "stale" : passing ? "current" : "failed");
  }));
});
