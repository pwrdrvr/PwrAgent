import { resolve } from "node:path";
import fc from "fast-check";
import type { AppServerBackendKind, AppServerReviewOutput } from "@pwragent/shared/contracts/normalized-app-server";
import { describe, expect, it } from "vitest";
import {
  buildReviewOutputFromCandidateLedger,
  MANAGED_REVIEW_CANDIDATE_CATEGORIES,
  MANAGED_REVIEW_CANDIDATE_MAX_FIELD_LENGTH,
  MANAGED_REVIEW_CANDIDATE_MAX_PER_TURN,
  MANAGED_REVIEW_OUTPUT_MAX_FINDINGS,
  ManagedReviewCandidateLedger,
  type ManagedReviewCandidate,
  type ManagedReviewCandidateCategory,
  type ManagedReviewCandidatePriority,
  type ManagedReviewCandidateTurnKey,
} from "../app-server/managed-review-candidate-ledger";
import {
  formatReviewOutputText,
  parseReviewOutputText,
} from "../../shared/review-output";

const BACKENDS: readonly AppServerBackendKind[] = ["codex", "acp:antigravity", "acp:grok"];
const ABSOLUTE_FINDING_PATH = resolve("/repo/a.ts");

const turnKeyArb: fc.Arbitrary<ManagedReviewCandidateTurnKey> = fc.record({
  backend: fc.constantFrom(...BACKENDS),
  threadId: fc.constantFrom("thread-a", "thread-b"),
  turnId: fc.constantFrom("turn-1", "turn-2"),
});

const categoryArb = fc.constantFrom<ManagedReviewCandidateCategory>(
  ...MANAGED_REVIEW_CANDIDATE_CATEGORIES,
);

const priorityArb = fc.constantFrom<ManagedReviewCandidatePriority>(0, 1, 2, 3);

const nonEmptyTextArb = fc
  .string({ minLength: 1, maxLength: 40 })
  .map((value) => `x${value.trim()}`);

type ModelCandidate = {
  id: string;
  file: string;
  startLine: number;
  endLine: number;
  category: ManagedReviewCandidateCategory;
  summary: string;
  mechanism: string;
  disposition: "pending" | "keep" | "drop";
  priority?: ManagedReviewCandidatePriority;
  dispositionReason?: string;
};

type LedgerStep =
  | {
      kind: "record";
      turn: ManagedReviewCandidateTurnKey;
      file: string;
      startLine: number;
      lineSpan: number;
      category: ManagedReviewCandidateCategory;
      summary: string;
      mechanism: string;
    }
  | {
      kind: "dispose";
      turn: ManagedReviewCandidateTurnKey;
      candidateIndex: number;
      disposition: "keep" | "drop";
      priority?: ManagedReviewCandidatePriority;
      category?: ManagedReviewCandidateCategory;
      reason: string;
    }
  | {
      kind: "submitOutput";
      turn: ManagedReviewCandidateTurnKey;
      invalidField: "title" | "path" | "verdict" | undefined;
      hasFinding: boolean;
      priority: ManagedReviewCandidatePriority;
      body: string;
      explanation: string;
      confidenceScore?: number;
    }
  | { kind: "list"; turn: ManagedReviewCandidateTurnKey }
  | { kind: "clearTurn"; turn: ManagedReviewCandidateTurnKey }
  | { kind: "clearThread"; backend: AppServerBackendKind; threadId: string };

const stepArb: fc.Arbitrary<LedgerStep> = fc.oneof(
  fc.record({
    kind: fc.constant("record" as const),
    turn: turnKeyArb,
    file: nonEmptyTextArb,
    startLine: fc.integer({ min: 1, max: 500 }),
    lineSpan: fc.integer({ min: 0, max: 50 }),
    category: categoryArb,
    summary: nonEmptyTextArb,
    mechanism: nonEmptyTextArb,
  }),
  fc.record({
    kind: fc.constant("dispose" as const),
    turn: turnKeyArb,
    candidateIndex: fc.integer({ min: 0, max: 6 }),
    disposition: fc.constantFrom<"keep" | "drop">("keep", "drop"),
    priority: fc.option(priorityArb, { nil: undefined }),
    category: fc.option(categoryArb, { nil: undefined }),
    reason: nonEmptyTextArb,
  }),
  fc.record({
    kind: fc.constant("submitOutput" as const),
    turn: turnKeyArb,
    invalidField: fc.option(fc.constantFrom("title" as const, "path" as const, "verdict" as const), { nil: undefined }),
    hasFinding: fc.boolean(),
    priority: priorityArb,
    body: fc.constantFrom(
      'The `"remote-pin"` step skips owner-version checks.',
      'Quoted `"local-name"` and backslash \\n remain intact.',
      "Plain finding body.",
    ),
    explanation: nonEmptyTextArb,
    confidenceScore: fc.constantFrom<number | undefined>(undefined, 0, 0.5, 0.93),
  }),
  fc.record({
    kind: fc.constant("list" as const),
    turn: turnKeyArb,
  }),
  fc.record({
    kind: fc.constant("clearTurn" as const),
    turn: turnKeyArb,
  }),
  fc.record({
    kind: fc.constant("clearThread" as const),
    backend: fc.constantFrom(...BACKENDS),
    threadId: fc.constantFrom("thread-a", "thread-b"),
  }),
);

function modelTurnKey(turn: ManagedReviewCandidateTurnKey): string {
  return JSON.stringify([turn.backend, turn.threadId, turn.turnId]);
}

describe("ManagedReviewCandidateLedger model properties", () => {
  it("preserves per-turn isolation, monotonic IDs, disposition transitions, submitted outputs, and complete cleanup across arbitrary sequences", () => {
    fc.assert(
      fc.property(fc.array(stepArb, { minLength: 1, maxLength: 60 }), (steps) => {
        const ledger = new ManagedReviewCandidateLedger();
        const model = new Map<
          string,
          {
            turn: ManagedReviewCandidateTurnKey;
            nextId: number;
            candidates: ModelCandidate[];
            submittedOutput?: AppServerReviewOutput;
          }
        >();

        for (const step of steps) {
          if (step.kind === "record") {
            const key = modelTurnKey(step.turn);
            const endLine = step.startLine + step.lineSpan;
            const actual = ledger.record(step.turn, {
              file: step.file,
              start_line: step.startLine,
              end_line: endLine,
              category: step.category,
              summary: step.summary,
              mechanism: step.mechanism,
            });
            let state = model.get(key);
            if (!state) {
              state = { turn: step.turn, nextId: 1, candidates: [] };
              model.set(key, state);
            }
            const expectedCandidate: ModelCandidate = {
              id: `C${state.nextId}`,
              file: step.file.trim(),
              startLine: step.startLine,
              endLine,
              category: step.category,
              summary: step.summary.trim(),
              mechanism: step.mechanism.trim(),
              disposition: "pending",
            };
            state.nextId += 1;
            state.candidates.push(expectedCandidate);
            expect(actual).toEqual({
              ok: true,
              data: {
                id: expectedCandidate.id,
                recorded: expectedCandidate,
                total_candidates: state.candidates.length,
              },
            });
          } else if (step.kind === "dispose") {
            const key = modelTurnKey(step.turn);
            const state = model.get(key);
            const target = state?.candidates[step.candidateIndex];
            const id = target ? target.id : `C${step.candidateIndex + 100}`;
            const actual = ledger.dispose(step.turn, {
              id,
              disposition: step.disposition,
              priority: step.priority,
              category: step.category,
              reason: step.reason,
            });
            if (step.disposition === "keep" && step.priority === undefined) {
              expect(actual).toMatchObject({ ok: false, code: "invalid_arguments" });
            } else if (!target) {
              expect(actual).toMatchObject({ ok: false, code: "not_found" });
            } else {
              target.disposition = step.disposition;
              target.dispositionReason = step.reason.trim();
              if (step.category !== undefined) {
                target.category = step.category;
              }
              if (step.disposition === "keep") {
                target.priority = step.priority;
              } else {
                delete target.priority;
              }
              expect(actual).toMatchObject({
                ok: true,
                data: {
                  updated: target,
                },
              });
            }
          } else if (step.kind === "submitOutput") {
            const key = modelTurnKey(step.turn);
            const hasFinding = step.hasFinding || step.invalidField === "title" || step.invalidField === "path";
            const findings = hasFinding
              ? [{
                  title: step.invalidField === "title" ? "" : "Quoted finding",
                  body: step.body,
                  confidence_score: 0.9,
                  priority: step.priority,
                  code_location: {
                    absolute_file_path: step.invalidField === "path" ? "src/a.ts" : ABSOLUTE_FINDING_PATH,
                    line_range: { start: 10, end: 12 },
                  },
                }]
              : [];
            const claimsClean = step.invalidField === "verdict" ? hasFinding : !hasFinding;
            const correctness = claimsClean ? "patch is correct" : "patch is incorrect";
            const actual = ledger.submitOutput(step.turn, {
              findings,
              overall_correctness: correctness,
              overall_explanation: step.explanation,
              ...(step.confidenceScore !== undefined
                ? { overall_confidence_score: step.confidenceScore }
                : {}),
            });
            // An invalid submission must leave the previous accepted review intact.
            if (step.invalidField) {
              expect(actual).toMatchObject({ ok: false, code: "invalid_arguments" });
              expect(ledger.submittedOutput(step.turn)).toEqual(model.get(key)?.submittedOutput);
            } else {
              let state = model.get(key);
              if (!state) {
                state = { turn: step.turn, nextId: 1, candidates: [] };
                model.set(key, state);
              }
              const expectedOutput: AppServerReviewOutput = {
                findings,
                overall_correctness: correctness,
                overall_explanation: step.explanation.trim(),
                ...(step.confidenceScore !== undefined && step.confidenceScore > 0
                  ? { overall_confidence_score: step.confidenceScore }
                  : {}),
              };
              state.submittedOutput = expectedOutput;
              expect(actual).toMatchObject({
                ok: true,
                data: {
                  finding_count: findings.length,
                },
              });
              expect(ledger.submittedOutput(step.turn)).toEqual(expectedOutput);
            }
          } else if (step.kind === "list") {
            const expected = model.get(modelTurnKey(step.turn))?.candidates ?? [];
            const listed = ledger.list(step.turn);
            expect(listed.candidates).toEqual(expected);
            expect(listed.total).toBe(expected.length);
            expect(listed.counts).toEqual({
              pending: expected.filter((item) => item.disposition === "pending").length,
              keep: expected.filter((item) => item.disposition === "keep").length,
              drop: expected.filter((item) => item.disposition === "drop").length,
            });
            expect(ledger.submittedOutput(step.turn)).toEqual(
              model.get(modelTurnKey(step.turn))?.submittedOutput,
            );
          } else if (step.kind === "clearTurn") {
            const key = modelTurnKey(step.turn);
            expect(ledger.clearTurn(step.turn)).toBe(model.delete(key));
            expect(ledger.submittedOutput(step.turn)).toBeUndefined();
          } else {
            let expectedRemoved = 0;
            for (const [key, state] of model.entries()) {
              if (
                state.turn.backend === step.backend
                && state.turn.threadId === step.threadId
              ) {
                model.delete(key);
                expectedRemoved += 1;
              }
            }
            expect(
              ledger.clearThread({
                backend: step.backend,
                threadId: step.threadId,
              }),
            ).toBe(expectedRemoved);
          }

          expect(ledger.activeTurnCount).toBe(model.size);
        }

        ledger.clearAll();
        expect(ledger.activeTurnCount).toBe(0);
      }),
      { numRuns: 100 },
    );
  });

  it.each([
    { count: 1, verdict: "patch is correct", expected: "patch is incorrect" },
    { count: 0, verdict: "patch is incorrect", expected: "patch is correct" },
  ])("rejects '$verdict' with $count findings", ({ count, verdict, expected }) => {
    const ledger = new ManagedReviewCandidateLedger();
    const turn = { backend: "codex", threadId: "review", turnId: "turn" } as const;
    const finding = {
      title: "Guard null input",
      body: "An empty request throws before validation.",
      confidence_score: 0.95,
      priority: 1,
      code_location: { absolute_file_path: ABSOLUTE_FINDING_PATH, line_range: { start: 1, end: 1 } },
    };
    expect(ledger.submitOutput(turn, {
      findings: count ? [finding] : [],
      overall_correctness: verdict,
      overall_explanation: "Reviewed the request path.",
    })).toMatchObject({ ok: false, code: "invalid_arguments", message: expect.stringContaining(expected) });
  });

  it.each(["src/a.ts", ...(process.platform === "win32" ? ["C:src/a.ts", "/src/a.ts"] : [])])(
    "rejects a finding path that depends on the current directory or drive (%s)", (file) => {
      const ledger = new ManagedReviewCandidateLedger();
      const turn = { backend: "codex", threadId: "review", turnId: "turn" } as const;
      expect(ledger.submitOutput(turn, {
        findings: [{
          title: "Guard null input",
          body: "An empty request throws before validation.",
          confidence_score: 0.95,
          priority: 1,
          code_location: { absolute_file_path: file, line_range: { start: 1, end: 1 } },
        }],
        overall_correctness: "patch is incorrect",
        overall_explanation: "Found an unhandled request.",
      })).toMatchObject({ ok: false, code: "invalid_arguments", message: expect.stringContaining("absolute_file_path") });
    },
  );

  it("enforces field validation, bounding, and per-turn capacity limits without mutating state", () => {
    const ledger = new ManagedReviewCandidateLedger();
    const turn: ManagedReviewCandidateTurnKey = {
      backend: "acp:antigravity",
      threadId: "review-thread",
      turnId: "review-turn",
    };

    expect(
      ledger.record(turn, {
        file: "   ",
        start_line: 1,
        end_line: 1,
        category: "correctness",
        summary: "Missing guard",
        mechanism: "Crashes on empty input.",
      }),
    ).toMatchObject({ ok: false, code: "invalid_arguments" });

    expect(
      ledger.record(turn, {
        file: "a.ts",
        start_line: 20,
        end_line: 10,
        category: "correctness",
        summary: "Inverted range",
        mechanism: "End before start.",
      }),
    ).toMatchObject({ ok: false, code: "invalid_arguments" });

    expect(
      ledger.record(turn, {
        file: "a.ts",
        start_line: 1,
        end_line: 2,
        category: "not-a-category",
        summary: "Bad category",
        mechanism: "Invalid enum.",
      }),
    ).toMatchObject({ ok: false, code: "invalid_arguments" });

    expect(ledger.activeTurnCount).toBe(0);

    const oversized = "z".repeat(MANAGED_REVIEW_CANDIDATE_MAX_FIELD_LENGTH + 250);
    const first = ledger.record(turn, {
      file: "a.ts",
      start_line: 1,
      end_line: 2,
      category: "performance",
      summary: oversized,
      mechanism: oversized,
    });
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.data.recorded.summary).toHaveLength(
        MANAGED_REVIEW_CANDIDATE_MAX_FIELD_LENGTH,
      );
      expect(first.data.recorded.mechanism).toHaveLength(
        MANAGED_REVIEW_CANDIDATE_MAX_FIELD_LENGTH,
      );
    }

    for (let index = 1; index < MANAGED_REVIEW_CANDIDATE_MAX_PER_TURN; index += 1) {
      const added = ledger.record(turn, {
        file: `file-${index}.ts`,
        start_line: index,
        end_line: index,
        category: "correctness",
        summary: `Issue ${index}`,
        mechanism: `Detail ${index}`,
      });
      expect(added.ok).toBe(true);
    }

    const overflow = ledger.record(turn, {
      file: "overflow.ts",
      start_line: 1,
      end_line: 1,
      category: "correctness",
      summary: "One too many",
      mechanism: "Should hit the per-turn cap.",
    });
    expect(overflow).toMatchObject({ ok: false, code: "limit_exceeded" });
    expect(ledger.list(turn).total).toBe(MANAGED_REVIEW_CANDIDATE_MAX_PER_TURN);

    const tooManyFindings = Array.from(
      { length: MANAGED_REVIEW_OUTPUT_MAX_FINDINGS + 1 },
      (_, index) => ({
        title: `Finding ${index}`,
        body: "Detail",
        confidence_score: 0.9,
        priority: 2,
        code_location: {
          absolute_file_path: ABSOLUTE_FINDING_PATH,
          line_range: { start: 1, end: 2 },
        },
      }),
    );
    expect(
      ledger.submitOutput(turn, {
        findings: tooManyFindings,
        overall_correctness: "patch is incorrect",
        overall_explanation: "Too many findings.",
      }),
    ).toMatchObject({ ok: false, code: "limit_exceeded" });
    expect(ledger.submittedOutput(turn)).toBeUndefined();

    expect(
      ledger.submitOutput(turn, {
        findings: [
          {
            title: "Inverted range",
            body: "End before start.",
            confidence_score: 0.9,
            priority: 2,
            code_location: {
              absolute_file_path: ABSOLUTE_FINDING_PATH,
              line_range: { start: 20, end: 10 },
            },
          },
        ],
        overall_correctness: "patch is incorrect",
        overall_explanation: "Bad range.",
      }),
    ).toMatchObject({ ok: false, code: "invalid_arguments" });

    const submitted = ledger.submitOutput(turn, {
      findings: [],
      overall_correctness: "patch is correct",
      overall_explanation: "No concrete defects.",
      overall_confidence_score: 0,
    });
    expect(submitted.ok).toBe(true);
    expect(ledger.submittedOutput(turn)).toEqual({
      findings: [],
      overall_correctness: "patch is correct",
      overall_explanation: "No concrete defects.",
    });
  });
});

describe("buildReviewOutputFromCandidateLedger", () => {
  it("property: buildReviewOutputFromCandidateLedger recovers only kept entries sorted stably by priority", () => {
    const candidateArb = fc.record({
      file: fc.oneof(
        fc.constantFrom("src/a.ts", "packages/shared/b.ts", "src\\win-rel.ts"),
        fc.constantFrom("/abs/x.ts", "/repo/sub/y.ts", "D:\\abs\\z.ts"),
      ),
      startLine: fc.integer({ min: 1, max: 500 }),
      endSpan: fc.integer({ min: 0, max: 40 }),
      category: categoryArb,
      summary: nonEmptyTextArb,
      mechanism: nonEmptyTextArb,
      disposition: fc.constantFrom<"pending" | "keep" | "drop">("pending", "keep", "drop"),
      priority: priorityArb,
    });
    const checkoutArb = fc.constantFrom(
      { checkoutRoot: "/repo", joinedRoot: "/repo", separator: "/" },
      { checkoutRoot: "C:\\work\\repo", joinedRoot: "C:\\work\\repo", separator: "\\" },
      { checkoutRoot: "C:/work/repo", joinedRoot: "C:\\work\\repo", separator: "\\" },
      { checkoutRoot: "\\\\server\\share\\repo", joinedRoot: "\\\\server\\share\\repo", separator: "\\" },
      { checkoutRoot: "//server/share/repo", joinedRoot: "\\\\server\\share\\repo", separator: "\\" },
    );

    fc.assert(
      fc.property(fc.array(candidateArb, { maxLength: 15 }), checkoutArb, (raw, checkout) => {
        const candidates: ManagedReviewCandidate[] = raw.map((c, idx) => ({
          id: `C${idx + 1}`,
          file: c.file,
          startLine: c.startLine,
          endLine: c.startLine + c.endSpan,
          category: c.category,
          summary: c.summary,
          mechanism: c.mechanism,
          disposition: c.disposition,
          ...(c.disposition === "keep" ? { priority: c.priority } : {}),
        }));
        const expectedKept = candidates.filter((c) => c.disposition === "keep");
        const recovered = buildReviewOutputFromCandidateLedger(candidates, checkout.checkoutRoot);

        if (expectedKept.length === 0) {
          expect(recovered).toBeUndefined();
          return;
        }

        // Read each priority bucket in capture order, including same-file findings.
        const expectedSorted = [0, 1, 2, 3].flatMap((priority) =>
          expectedKept.filter((candidate) => candidate.priority === priority),
        );

        expect(recovered).toBeDefined();
        expect(recovered!.overall_correctness).toBe("patch is incorrect");
        expect(recovered!.findings).toMatchObject(expectedSorted.map((candidate) => ({
          title: candidate.summary,
          body: candidate.mechanism,
          priority: candidate.priority,
          code_location: {
            absolute_file_path: candidate.file.startsWith("/") || candidate.file.startsWith("D:")
              ? candidate.file
              : [checkout.joinedRoot, ...candidate.file.split(/[\\/]/)].join(checkout.separator),
            line_range: { start: candidate.startLine, end: candidate.endLine },
          },
        })));
        const roundTripped = parseReviewOutputText(JSON.stringify(recovered));
        expect(roundTripped?.findings).toHaveLength(expectedKept.length);
        expect(formatReviewOutputText(recovered!)).toContain(recovered!.findings[0]!.title);
      }),
    );
  });

  it("keeps capture order for same-file findings at the same priority", () => {
    const candidates: ManagedReviewCandidate[] = [
      { id: "C1", summary: "Preserve the retry", startLine: 20, endLine: 25 },
      { id: "C2", summary: "Release the queue", startLine: 2, endLine: 4 },
    ].map((candidate) => ({
      ...candidate,
      file: "src/a.ts",
      category: "correctness",
      mechanism: "Verified defect.",
      disposition: "keep",
      priority: 2,
    }));

    expect(buildReviewOutputFromCandidateLedger(candidates, "/repo")?.findings).toMatchObject([
      { title: "Preserve the retry", code_location: { line_range: { start: 20, end: 25 } } },
      { title: "Release the queue", code_location: { line_range: { start: 2, end: 4 } } },
    ]);
  });

  it("resolves repository-relative findings on a forward-slash UNC share", () => {
    const candidate: ManagedReviewCandidate = {
      id: "C1",
      file: "src/a.ts",
      startLine: 2,
      endLine: 4,
      category: "correctness",
      summary: "Release the queue",
      mechanism: "Verified defect.",
      disposition: "keep",
      priority: 2,
    };

    const output = buildReviewOutputFromCandidateLedger([candidate], "//server/share/repo");
    expect(output?.findings[0]?.code_location.absolute_file_path).toBe("\\\\server\\share\\repo\\src\\a.ts");
  });
});
