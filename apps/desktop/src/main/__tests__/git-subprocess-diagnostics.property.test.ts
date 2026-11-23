import fc from "fast-check";
import { expect, it } from "vitest";
import { GitSubprocessDiagnostics, prGitSubprocessCaller } from "../diagnostics/git-subprocess-diagnostics";

const callers = ["pr-scheduled-prefetch", "pr-live-branch-lookup", "pr-stored-attachment-validation"] as const;

it("counts every attributed start by caller when all directory rows are occupied", () => {
  fc.assert(fc.property(
    fc.array(fc.constantFrom(...callers, undefined), { minLength: 8, maxLength: 50 }),
    (overflowCallers) => {
      let now = 0;
      const diagnostics = new GitSubprocessDiagnostics(() => now, () => now);
      for (let row = 0; row < 32; row++) diagnostics.startGit(`/fixture/retained-${row}`, ["status"])(false);
      const finish = overflowCallers.map((caller, index) => prGitSubprocessCaller.run(caller, () =>
        diagnostics.startGit(`/fixture/overflow-${index}`, ["symbolic-ref", "refs/remotes/fixture/HEAD"], "pr-discovery"),
      ));
      now = 2_000;
      finish.forEach((complete) => complete(false));

      const [starts, completions] = diagnostics.snapshot().buckets;
      expect(starts.rows).toHaveLength(32);
      expect(starts.overflow.started).toBe(overflowCallers.length);
      expect(starts.startsByCaller).toEqual(Object.fromEntries(callers.map((caller) =>
        [caller, overflowCallers.filter((candidate) => candidate === caller).length],
      )));
      expect(Object.values(completions.startsByCaller)).toEqual([0, 0, 0]);
      expect(completions.totals.succeeded).toBe(overflowCallers.length);
      expect(completions.rows.map((row) => row.caller)).toEqual(overflowCallers.slice(0, 32));
    },
  ));
});

it("keeps caller rows distinct for the same command and checkout", () => {
  const diagnostics = new GitSubprocessDiagnostics(() => 0);
  for (const caller of callers) {
    prGitSubprocessCaller.run(caller, () => diagnostics.startGit(
      "/fixture/secret-checkout", ["symbolic-ref", "refs/remotes/secret-remote/HEAD"], "pr-discovery",
    )(false));
  }
  const snapshot = diagnostics.snapshot();
  expect(snapshot.buckets[0].rows.map(({ caller, started }) => [caller, started]))
    .toEqual(callers.map((caller) => [caller, 1]));
  expect(JSON.stringify(snapshot)).not.toMatch(/secret-checkout|secret-remote/);
});
