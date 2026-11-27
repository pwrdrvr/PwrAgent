import engine from "fast-check";
import { expect } from "vitest";
import { record } from "./scaling-audit-results";

// Keep the corpus's generators, shrinker and assertion options. Only the
// seed and run count belong to the comparison rather than the ordinary suite.
export function matchedModel(family: string, seed: number) {
  return {
    ...engine,
    assert(property, options = {}) {
      const result = engine.check(property, {
        ...options,
        seed,
        numRuns: Number(process.env.AUDIT_CASES),
      });
      const finish = (details) => {
        record({
          family, assertion: expect.getState().currentTestName, seed: details.seed,
          runs: details.numRuns, failed: details.failed, path: details.counterexamplePath,
        });
        if (details.failed || details.interrupted) {
          throw new Error(engine.defaultReportMessage(details), { cause: details.errorInstance });
        }
      };
      return result instanceof Promise ? result.then(finish) : finish(result);
    },
  };
}
