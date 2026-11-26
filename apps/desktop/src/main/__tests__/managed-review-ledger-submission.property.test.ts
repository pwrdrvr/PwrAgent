import { resolve } from "node:path";
import type { AppServerReviewOutput } from "@pwragent/shared/contracts/normalized-app-server";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ManagedReviewCandidateLedger,
  type ManagedReviewCandidatePriority,
} from "../app-server/managed-review-candidate-ledger";

const priorityArb = fc.constantFrom<ManagedReviewCandidatePriority>(0, 1, 2, 3);

describe("managed review ledger submission", () => {
  it("submits only fully triaged keeps in priority and recording order, using their latest details", () => {
    fc.assert(fc.property(fc.array(fc.record({
      keep: fc.boolean(),
      priority: priorityArb,
      refine: fc.boolean(),
    }), { maxLength: 12 }), (choices) => {
      const ledger = new ManagedReviewCandidateLedger();
      const turn = { backend: "codex", threadId: "review", turnId: "turn" } as const;
      const workspace = resolve("/repo");
      ledger.armToolTurn(turn, turn.turnId, workspace);
      const expectedBuckets = [0, 1, 2, 3].map(() => [] as AppServerReviewOutput["findings"]);
      const submit = {
        use_ledger: true,
        overall_correctness: choices.some(({ keep }) => keep) ? "patch is incorrect" : "patch is correct",
        overall_explanation: "Finished triage.",
      };

      for (const [index, { keep, priority, refine }] of choices.entries()) {
        const recorded = ledger.record(turn, {
          file: "src/initial.ts",
          start_line: 1,
          end_line: 3,
          category: "correctness",
          summary: `Initial ${index}`,
          mechanism: "Initial body",
        });
        if (!recorded.ok) throw new Error(recorded.message);
        expect(ledger.submitOutput(turn, submit)).toMatchObject({ ok: false, code: "invalid_arguments" });
        expect(ledger.submittedOutput(turn)).toBeUndefined();
        const refined = {
          file: "src/refined.ts",
          end_line: 4,
          summary: `Refined ${index}`,
          mechanism: "Refined body",
        };
        expect(ledger.dispose(turn, {
          id: recorded.data.id,
          disposition: keep ? "keep" : "drop",
          reason: "Checked the caller.",
          priority,
          ...(refine ? refined : {}),
        }).ok).toBe(true);
        if (keep) {
          expectedBuckets[priority].push({
            title: refine ? refined.summary : `Initial ${index}`,
            body: refine ? refined.mechanism : "Initial body",
            category: "correctness",
            priority,
            confidence_score: 0,
            code_location: {
              absolute_file_path: resolve(workspace, refine ? refined.file : "src/initial.ts"),
              line_range: { start: 1, end: refine ? refined.end_line : 3 },
            },
          });
        }
      }
      expect(ledger.submitOutput(turn, submit).ok).toBe(true);
      expect(ledger.submittedOutput(turn)?.findings).toEqual(expectedBuckets.flat());
    }));
  });

  it.each([
    ["/workspace/repo", "src/a.ts", "/workspace/repo/src/a.ts"],
    ["D:\\workspace\\repo", "src/a.ts", "D:\\workspace\\repo\\src\\a.ts"],
    ["\\\\server\\share\\repo", "src/a.ts", "\\\\server\\share\\repo\\src\\a.ts"],
    ["D:\\workspace\\repo", "/src/a.ts", undefined],
    ["D:\\workspace\\repo", "C:src\\a.ts", undefined],
    [undefined, "src/a.ts", undefined],
  ] as const)("resolves a kept candidate against workspace %s and file %s", (workspace, file, expected) => {
    const ledger = new ManagedReviewCandidateLedger();
    const turn = { backend: "codex", threadId: "review", turnId: "turn" } as const;
    ledger.armToolTurn(turn, null, workspace);
    ledger.confirmToolTurn(turn);
    const recorded = ledger.record(turn, {
      file,
      start_line: 1,
      end_line: 1,
      category: "correctness",
      summary: "Fix input validation",
      mechanism: "An empty input reaches the parser.",
    });
    if (!recorded.ok) throw new Error(recorded.message);
    expect(ledger.dispose(turn, {
      id: recorded.data.id,
      disposition: "keep",
      priority: 2,
      reason: "Verified.",
    }).ok).toBe(true);
    const submitted = ledger.submitOutput(turn, {
      use_ledger: true,
      overall_correctness: "patch is incorrect",
      overall_explanation: "Verified one defect.",
    });
    if (expected === undefined) {
      expect(submitted).toMatchObject({
        ok: false,
        code: "invalid_arguments",
        message: expect.stringContaining(recorded.data.id),
      });
      expect(ledger.submittedOutput(turn)).toBeUndefined();
    } else {
      expect(submitted.ok).toBe(true);
      expect(ledger.submittedOutput(turn)?.findings[0]?.code_location.absolute_file_path).toBe(expected);
    }
  });
});
