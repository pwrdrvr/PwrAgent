import { resolve } from "node:path";
import fc from "fast-check";
import type {
  AppServerBackendKind,
  AppServerReviewFinding,
  AppServerReviewOutput,
} from "@pwragent/shared/contracts/normalized-app-server";
import { describe, expect, it } from "vitest";
import {
  idleCodexThreadActivity,
  transition as transitionCodexThreadActivity,
} from "../app-server/codex-thread-activity";
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
  type ManagedReviewWorkspace,
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

    ledger.armToolTurn(turn, turn.turnId, { worktreeRoot: resolve("/repo") });
    for (const { id } of ledger.list(turn).candidates) {
      expect(ledger.dispose(turn, { id, disposition: "keep", priority: 2, reason: "Verified." }).ok).toBe(true);
    }
    const overflowFinding = { ...tooManyFindings[0], title: "One too many", priority: 1 };
    expect(ledger.submitOutput(turn, {
      use_ledger: true,
      findings: [overflowFinding],
      overall_correctness: "patch is incorrect",
      overall_explanation: "Verified a defect after the ledger filled.",
    })).toMatchObject({ ok: true, data: { finding_count: MANAGED_REVIEW_CANDIDATE_MAX_PER_TURN + 1 } });
    const final = ledger.submittedOutput(turn)?.findings;
    expect(final?.[0]).toEqual(overflowFinding);
    expect(final?.slice(1).map(({ title }) => title)).toEqual(
      ledger.list(turn).candidates.map(({ summary }) => summary),
    );
  });
});

type WorkspaceScenario = {
  style: "posix" | "win32";
  workspace: ManagedReviewWorkspace;
  joinedRoot?: string;
  separator: "/" | "\\";
  files: readonly { file: string; resolved?: string }[];
};

const WORKSPACE_SCENARIOS: readonly WorkspaceScenario[] = [
  {
    style: "posix",
    workspace: { worktreeRoot: "/repo", cwd: "/repo/packages/app" },
    joinedRoot: "/repo",
    separator: "/",
    files: [
      { file: "src/a.ts", resolved: "/repo/src/a.ts" },
      { file: "packages/shared/b.ts", resolved: "/repo/packages/shared/b.ts" },
      { file: "/abs/x.ts", resolved: "/abs/x.ts" },
    ],
  },
  {
    style: "win32",
    workspace: { worktreeRoot: "C:\\work\\repo", cwd: "C:\\work\\repo\\packages\\app" },
    joinedRoot: "C:\\work\\repo",
    separator: "\\",
    files: [
      { file: "src/a.ts", resolved: "C:\\work\\repo\\src\\a.ts" },
      { file: "src\\win-rel.ts", resolved: "C:\\work\\repo\\src\\win-rel.ts" },
      { file: "D:\\abs\\z.ts", resolved: "D:\\abs\\z.ts" },
      { file: "D:/abs/w.ts", resolved: "D:/abs/w.ts" },
      { file: "/src/partial.ts", resolved: undefined },
      { file: "C:src\\drive-rel.ts", resolved: undefined },
    ],
  },
  {
    style: "win32",
    workspace: { worktreeRoot: "C:/work/repo", cwd: "C:/work/repo/packages/app" },
    joinedRoot: "C:\\work\\repo",
    separator: "\\",
    files: [
      { file: "src/a.ts", resolved: "C:\\work\\repo\\src\\a.ts" },
      { file: "D:/abs/w.ts", resolved: "D:/abs/w.ts" },
      { file: "/src/partial.ts", resolved: undefined },
      { file: "C:src\\drive-rel.ts", resolved: undefined },
    ],
  },
  {
    style: "win32",
    workspace: { worktreeRoot: "\\\\server\\share\\repo" },
    joinedRoot: "\\\\server\\share\\repo",
    separator: "\\",
    files: [
      { file: "src/a.ts", resolved: "\\\\server\\share\\repo\\src\\a.ts" },
      { file: "/src/partial.ts", resolved: undefined },
    ],
  },
  {
    style: "win32",
    workspace: { worktreeRoot: "//server/share/repo" },
    joinedRoot: "\\\\server\\share\\repo",
    separator: "\\",
    files: [
      { file: "src/a.ts", resolved: "\\\\server\\share\\repo\\src\\a.ts" },
      { file: "C:src\\drive-rel.ts", resolved: undefined },
    ],
  },
  {
    style: "posix",
    workspace: { cwd: "/remote/repo/packages/app" },
    separator: "/",
    files: [
      { file: "packages/app/src/a.ts", resolved: undefined },
      { file: "/remote/repo/packages/app/src/a.ts", resolved: "/remote/repo/packages/app/src/a.ts" },
    ],
  },
  {
    style: "win32",
    workspace: { cwd: "D:\\remote\\repo\\packages\\app" },
    separator: "\\",
    files: [
      { file: "packages/app/src/a.ts", resolved: undefined },
      { file: "D:\\remote\\repo\\packages\\app\\src\\a.ts", resolved: "D:\\remote\\repo\\packages\\app\\src\\a.ts" },
      { file: "/src/partial.ts", resolved: undefined },
      { file: "C:src\\drive-rel.ts", resolved: undefined },
    ],
  },
  {
    style: "win32",
    workspace: { cwd: "D:/remote/repo/packages/app" },
    separator: "\\",
    files: [
      { file: "packages/app/src/a.ts", resolved: undefined },
      { file: "D:/remote/repo/packages/app/src/a.ts", resolved: "D:/remote/repo/packages/app/src/a.ts" },
      { file: "/src/partial.ts", resolved: undefined },
    ],
  },
];

describe("buildReviewOutputFromCandidateLedger", () => {
  it("recovers only resolvable kept entries sorted stably by priority with category and confidenceScore preserved", () => {
    const scenarioWithCandidatesArb = fc.constantFrom(...WORKSPACE_SCENARIOS).chain((scenario) =>
      fc.record({
        scenario: fc.constant(scenario),
        entries: fc.array(
          fc.record({
            fileCase: fc.constantFrom(...scenario.files),
            startLine: fc.integer({ min: 1, max: 500 }),
            endSpan: fc.integer({ min: 0, max: 40 }),
            category: categoryArb,
            summary: nonEmptyTextArb,
            mechanism: nonEmptyTextArb,
            disposition: fc.constantFrom<"pending" | "keep" | "drop">("pending", "keep", "drop"),
            priority: priorityArb,
            confidenceScore: fc.option(fc.constantFrom(0, 0.25, 0.72, 0.96), { nil: undefined }),
          }),
          { maxLength: 15 },
        ),
      }),
    );

    fc.assert(
      fc.property(scenarioWithCandidatesArb, ({ scenario, entries }) => {
        const candidates: ManagedReviewCandidate[] = entries.map((entry, idx) => ({
          id: `C${idx + 1}`,
          file: entry.fileCase.file,
          startLine: entry.startLine,
          endLine: entry.startLine + entry.endSpan,
          category: entry.category,
          summary: entry.summary,
          mechanism: entry.mechanism,
          disposition: entry.disposition,
          ...(entry.disposition === "keep" ? { priority: entry.priority } : {}),
          ...(entry.confidenceScore !== undefined ? { confidenceScore: entry.confidenceScore } : {}),
        }));

        const expectedEntries = entries
          .map((entry, idx) => ({ candidate: candidates[idx]!, resolved: entry.fileCase.resolved }))
          .filter(
            (item): item is { candidate: ManagedReviewCandidate; resolved: string } =>
              item.candidate.disposition === "keep" && item.resolved !== undefined,
          );

        const recovered = buildReviewOutputFromCandidateLedger(candidates, scenario.workspace);

        if (expectedEntries.length === 0) {
          expect(recovered).toBeUndefined();
          return;
        }

        // Read each priority bucket in capture order, including same-file findings.
        const expectedFindings: AppServerReviewFinding[] = [0, 1, 2, 3].flatMap((priority) =>
          expectedEntries
            .filter(({ candidate }) => candidate.priority === priority)
            .map(({ candidate, resolved }) => ({
              title: candidate.summary,
              body: candidate.mechanism,
              confidence_score: candidate.confidenceScore ?? 0,
              priority,
              category: candidate.category,
              code_location: {
                absolute_file_path: resolved,
                line_range: { start: candidate.startLine, end: candidate.endLine },
              },
            })),
        );

        const count = expectedFindings.length;
        expect(recovered).toEqual({
          findings: expectedFindings,
          overall_correctness: "patch is incorrect",
          overall_explanation: `Recovered ${count} kept ${count === 1 ? "finding" : "findings"} from the managed review candidate ledger because no valid final review report was submitted or parsed.`,
        });
        expect(recovered!.overall_explanation).not.toContain("malformed review JSON");

        const roundTripped = parseReviewOutputText(JSON.stringify(recovered));
        expect(roundTripped).toEqual(recovered);
        expect(formatReviewOutputText(recovered!)).toContain(recovered!.findings[0]!.title);
      }),
    );
  });

  it("keeps capture order for same-file findings at the same priority and preserves category and confidenceScore", () => {
    const candidates: ManagedReviewCandidate[] = [
      {
        id: "C1",
        file: "src/a.ts",
        startLine: 20,
        endLine: 25,
        category: "lifecycle",
        summary: "Preserve the retry",
        mechanism: "Verified defect.",
        disposition: "keep",
        priority: 2,
        confidenceScore: 0.92,
      },
      {
        id: "C2",
        file: "src/a.ts",
        startLine: 2,
        endLine: 4,
        category: "correctness",
        summary: "Release the queue",
        mechanism: "Verified defect.",
        disposition: "keep",
        priority: 2,
      },
    ];

    const recovered = buildReviewOutputFromCandidateLedger(candidates, { worktreeRoot: "/repo" });
    expect(recovered).toEqual({
      findings: [
        {
          title: "Preserve the retry",
          body: "Verified defect.",
          confidence_score: 0.92,
          priority: 2,
          category: "lifecycle",
          code_location: {
            absolute_file_path: "/repo/src/a.ts",
            line_range: { start: 20, end: 25 },
          },
        },
        {
          title: "Release the queue",
          body: "Verified defect.",
          confidence_score: 0,
          priority: 2,
          category: "correctness",
          code_location: {
            absolute_file_path: "/repo/src/a.ts",
            line_range: { start: 2, end: 4 },
          },
        },
      ],
      overall_correctness: "patch is incorrect",
      overall_explanation: "Recovered 2 kept findings from the managed review candidate ledger because no valid final review report was submitted or parsed.",
    });
  });

  it.each([
    ["POSIX worktreeRoot + relative", { worktreeRoot: "/repo" }, "src/a.ts", "/repo/src/a.ts"],
    ["POSIX worktreeRoot + absolute", { worktreeRoot: "/repo" }, "/abs/x.ts", "/abs/x.ts"],
    ["Windows backslash worktreeRoot + relative", { worktreeRoot: "C:\\work\\repo" }, "src/a.ts", "C:\\work\\repo\\src\\a.ts"],
    ["Windows forward-slash toDirectoryId worktreeRoot + relative", { worktreeRoot: "C:/work/repo" }, "src/a.ts", "C:\\work\\repo\\src\\a.ts"],
    ["Windows UNC backslash worktreeRoot + relative", { worktreeRoot: "\\\\server\\share\\repo" }, "src/a.ts", "\\\\server\\share\\repo\\src\\a.ts"],
    ["Windows UNC forward-slash worktreeRoot + relative", { worktreeRoot: "//server/share/repo" }, "src/a.ts", "\\\\server\\share\\repo\\src\\a.ts"],
    ["Windows worktreeRoot + already-absolute", { worktreeRoot: "C:/work/repo" }, "D:\\abs\\z.ts", "D:\\abs\\z.ts"],
    ["Windows worktreeRoot + root-relative /src/a.ts", { worktreeRoot: "C:\\work\\repo" }, "/src/a.ts", undefined],
    ["Windows worktreeRoot + drive-relative C:src\\a.ts", { worktreeRoot: "C:\\work\\repo" }, "C:src\\a.ts", undefined],
    ["Remote POSIX cwd without worktreeRoot + relative", { cwd: "/remote/repo/packages/app" }, "packages/app/src/a.ts", undefined],
    ["Remote POSIX cwd without worktreeRoot + absolute", { cwd: "/remote/repo/packages/app" }, "/remote/repo/packages/app/src/a.ts", "/remote/repo/packages/app/src/a.ts"],
    ["Remote Windows cwd without worktreeRoot + relative", { cwd: "D:\\remote\\repo\\packages\\app" }, "packages/app/src/a.ts", undefined],
    ["Remote Windows forward-slash cwd without worktreeRoot + absolute", { cwd: "D:/remote/repo/packages/app" }, "D:/remote/repo/packages/app/src/a.ts", "D:/remote/repo/packages/app/src/a.ts"],
    ["Remote Windows cwd without worktreeRoot + root-relative", { cwd: "D:\\remote\\repo\\packages\\app" }, "/src/a.ts", undefined],
    ["Remote Windows cwd without worktreeRoot + drive-relative", { cwd: "D:\\remote\\repo\\packages\\app" }, "C:src\\a.ts", undefined],
  ] as const)("handles %s (%j, %s)", (_label, workspace, file, expectedPath) => {
    const candidate: ManagedReviewCandidate = {
      id: "C1",
      file,
      startLine: 2,
      endLine: 4,
      category: "correctness",
      summary: "Release the queue",
      mechanism: "Verified defect.",
      disposition: "keep",
      priority: 2,
    };

    const output = buildReviewOutputFromCandidateLedger([candidate], workspace);
    if (expectedPath === undefined) {
      expect(output).toBeUndefined();
    } else {
      expect(output?.findings).toHaveLength(1);
      expect(output?.findings[0]?.code_location.absolute_file_path).toBe(expectedPath);
      expect(parseReviewOutputText(JSON.stringify(output))).toEqual(output);
    }
  });

  it("skips unresolvable kept entries while keeping resolvable ones with an accurate explanation count", () => {
    const candidates: ManagedReviewCandidate[] = [
      {
        id: "C1",
        file: "packages/app/src/relative.ts",
        startLine: 1,
        endLine: 2,
        category: "correctness",
        summary: "Relative path on remote workspace",
        mechanism: "Cannot be resolved without checkoutRoot.",
        disposition: "keep",
        priority: 1,
      },
      {
        id: "C2",
        file: "/remote/repo/packages/app/src/absolute.ts",
        startLine: 10,
        endLine: 12,
        category: "security",
        summary: "Absolute path on remote workspace",
        mechanism: "Already absolute and safe to recover.",
        disposition: "keep",
        priority: 2,
        confidenceScore: 0.88,
      },
    ];

    const recovered = buildReviewOutputFromCandidateLedger(candidates, {
      cwd: "/remote/repo/packages/app",
    });
    expect(recovered).toEqual({
      findings: [
        {
          title: "Absolute path on remote workspace",
          body: "Already absolute and safe to recover.",
          confidence_score: 0.88,
          priority: 2,
          category: "security",
          code_location: {
            absolute_file_path: "/remote/repo/packages/app/src/absolute.ts",
            line_range: { start: 10, end: 12 },
          },
        },
      ],
      overall_correctness: "patch is incorrect",
      overall_explanation: "Recovered 1 kept finding from the managed review candidate ledger because no valid final review report was submitted or parsed.",
    });
    expect(parseReviewOutputText(JSON.stringify(recovered))).toEqual(recovered);
  });
});

describe("CodexThreadActivity reviewTerminal redelivery preservation", () => {
  it("preserves candidateLedgerSnapshot and submittedOutput across duplicate turn/completed deliveries", () => {
    const owner = {};
    const snapshot = {
      total: 1,
      counts: { pending: 0, keep: 1, drop: 0 },
      candidates: [
        {
          id: "C1",
          file: "src/review.ts",
          startLine: 5,
          endLine: 8,
          category: "correctness" as const,
          summary: "Preserve the guard",
          mechanism: "The retry bypasses the guard.",
          disposition: "keep" as const,
          priority: 2 as const,
        },
      ],
    };
    const submittedOutput: AppServerReviewOutput = {
      findings: [],
      overall_correctness: "patch is correct",
      overall_explanation: "Submitted explicitly.",
    };

    let state = transitionCodexThreadActivity(idleCodexThreadActivity(), {
      type: "reviewStartOpened",
      owner,
    });
    state = transitionCodexThreadActivity(state, {
      type: "reviewTerminal",
      terminal: {
        backend: "codex",
        threadId: "review-child",
        turnId: "review-turn",
        method: "turn/completed",
        candidateLedgerSnapshot: snapshot,
      },
    });
    // Redelivery after the ledger is already cleared carries no snapshot.
    state = transitionCodexThreadActivity(state, {
      type: "reviewTerminal",
      terminal: {
        backend: "codex",
        threadId: "review-child",
        turnId: "review-turn",
        method: "turn/completed",
      },
    });
    expect(state.reviewStarts[0]?.terminals).toEqual([
      {
        backend: "codex",
        threadId: "review-child",
        turnId: "review-turn",
        method: "turn/completed",
        candidateLedgerSnapshot: snapshot,
      },
    ]);

    // A later redelivery with submittedOutput preserves both fields without dropping the snapshot.
    state = transitionCodexThreadActivity(state, {
      type: "reviewTerminal",
      terminal: {
        backend: "codex",
        threadId: "review-child",
        turnId: "review-turn",
        method: "turn/completed",
        submittedOutput,
      },
    });
    expect(state.reviewStarts[0]?.terminals).toEqual([
      {
        backend: "codex",
        threadId: "review-child",
        turnId: "review-turn",
        method: "turn/completed",
        submittedOutput,
        candidateLedgerSnapshot: snapshot,
      },
    ]);
  });
});
