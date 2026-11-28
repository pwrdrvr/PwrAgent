import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { factoryEvidenceProblem } from "../openai-decisions/factory-pr-assessment";

describe("Factory evidence attribution after schema validation", () => {
  it("accepts only evidence for the selected revision, with both commits for an integration test", () => {
    fc.assert(fc.property(
      fc.constantFrom(40, 64),
      fc.boolean(), fc.boolean(),
      fc.array(fc.record({
        headChanged: fc.boolean(), base: fc.constantFrom("current", "other", "omitted"),
        integration: fc.boolean(), upperCase: fc.boolean(),
      }), { maxLength: 64 }),
      (length, missingHead, missingBase, observations) => {
        const headSha = (missingHead ? "0" : "a").repeat(length);
        const baseSha = (missingBase ? "0" : "b").repeat(length);
        const evidence = observations.map((row) => {
          const head = row.headChanged ? baseSha : headSha;
          return {
            headSha: row.upperCase ? head.toUpperCase() : head,
            kind: row.integration ? "integration" : "test",
            reference: "run/123", observation: "Passed",
            ...(row.base === "omitted" ? {} : { baseSha: row.base === "current" ? baseSha : headSha }),
          };
        });
        const eligible = !missingHead && !missingBase && observations.every((row) =>
          !row.headChanged && row.base !== "other" && (!row.integration || row.base === "current"));
        expect(factoryEvidenceProblem({ pullRequest: "pr/1", headSha, baseSha, evidence }) === undefined).toBe(eligible);
      },
    ));
  });

  it("inspects each evidence head once regardless of packet size", () => {
    const headSha = "f".repeat(40);
    const baseSha = "e".repeat(40);
    for (const n of [16, 32, 64]) {
      let visits = 0;
      const evidence = Array.from({ length: n }, () => ({
        kind: "integration", baseSha, reference: "run/123", observation: "Passed",
        get headSha() {
          visits += 1;
          return headSha;
        },
      }));
      expect(factoryEvidenceProblem({ pullRequest: "pr/1", headSha, baseSha, evidence })).toBeUndefined();
      expect(visits).toBe(n);
    }
  });
});
