import path from "node:path";
import type {
  AppServerBackendKind,
  AppServerReviewFinding,
  AppServerReviewOutput,
} from "@pwragent/shared/contracts/normalized-app-server";
import { buildThreadIdentityKey } from "@pwragent/shared/contracts/navigation";
import {
  normalizeOverallCorrectness,
  normalizeReviewCategory,
  normalizeReviewConfidenceScore,
} from "@pwragent/shared/review-output";

export const MANAGED_REVIEW_CANDIDATE_CATEGORIES = [
  "correctness",
  "performance",
  "contract",
  "parity",
  "testing",
  "standards",
  "security",
  "lifecycle",
] as const;

export type ManagedReviewCandidateCategory =
  (typeof MANAGED_REVIEW_CANDIDATE_CATEGORIES)[number];

export type ManagedReviewCandidateDisposition = "pending" | "keep" | "drop";

export type ManagedReviewCandidatePriority = 0 | 1 | 2 | 3;

export const MANAGED_REVIEW_CANDIDATE_MAX_PER_TURN = 100;
export const MANAGED_REVIEW_CANDIDATE_MAX_FIELD_LENGTH = 2_000;
// The explicit findings array has its own cap so a full ledger can still report overflow.
export const MANAGED_REVIEW_OUTPUT_MAX_FINDINGS = 100;

export type ManagedReviewCandidateTurnKey = {
  backend: AppServerBackendKind;
  threadId: string;
  turnId: string;
};

type ReviewChild = Pick<ManagedReviewCandidateTurnKey, "backend" | "threadId">;

export type ManagedReviewCandidate = {
  id: string;
  file: string;
  startLine: number;
  endLine: number;
  category: ManagedReviewCandidateCategory;
  summary: string;
  mechanism: string;
  disposition: ManagedReviewCandidateDisposition;
  priority?: ManagedReviewCandidatePriority;
  confidenceScore?: number;
  dispositionReason?: string;
};

export type ManagedReviewCandidateCounts = {
  pending: number;
  keep: number;
  drop: number;
};

export type ManagedReviewCandidateListResult = {
  total: number;
  counts: ManagedReviewCandidateCounts;
  candidates: ManagedReviewCandidate[];
};

export type ManagedReviewCandidateRecordInput = {
  file: unknown;
  start_line: unknown;
  end_line: unknown;
  category: unknown;
  summary: unknown;
  mechanism: unknown;
};

export type ManagedReviewCandidateDisposeInput = Partial<ManagedReviewCandidateRecordInput> & {
  id: unknown;
  disposition: unknown;
  priority?: unknown;
  confidence_score?: unknown;
  reason: unknown;
};

export type ManagedReviewOutputSubmitInput = {
  use_ledger?: unknown;
  findings?: unknown;
  overall_correctness: unknown;
  overall_explanation: unknown;
  overall_confidence_score?: unknown;
};

export type ManagedReviewCandidateOperationResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: "invalid_arguments" | "not_found" | "limit_exceeded"; message: string };

type TurnLedgerState = {
  backend: AppServerBackendKind;
  threadId: string;
  turnId: string;
  nextId: number;
  candidates: ManagedReviewCandidate[];
  submittedOutput?: AppServerReviewOutput;
};

const VALID_CATEGORIES = new Set<string>(MANAGED_REVIEW_CANDIDATE_CATEGORIES);

function buildTurnKey(turn: ManagedReviewCandidateTurnKey): string {
  return JSON.stringify([turn.backend, turn.threadId, turn.turnId]);
}

function readBoundedText(
  value: unknown,
  field: string,
  fallback?: string,
): { ok: true; value: string } | { ok: false; message: string } {
  if (value === undefined && fallback !== undefined) return { ok: true, value: fallback };
  if (typeof value !== "string") {
    return { ok: false, message: `${field} must be a non-empty string.` };
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return { ok: false, message: `${field} must be a non-empty string.` };
  }
  if (trimmed.length > MANAGED_REVIEW_CANDIDATE_MAX_FIELD_LENGTH) {
    return {
      ok: true,
      value: trimmed.slice(0, MANAGED_REVIEW_CANDIDATE_MAX_FIELD_LENGTH),
    };
  }
  return { ok: true, value: trimmed };
}

function readPositiveLine(
  value: unknown,
  field: string,
): { ok: true; value: number } | { ok: false; message: string } {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    return { ok: false, message: `${field} must be a positive integer.` };
  }
  return { ok: true, value };
}

function readCandidateDetails(
  input: Partial<ManagedReviewCandidateRecordInput>,
  previous?: ManagedReviewCandidate,
):
  | { ok: true; value: Pick<ManagedReviewCandidate, "file" | "startLine" | "endLine" | "summary" | "mechanism"> }
  | { ok: false; message: string } {
  const { start_line = previous?.startLine, end_line = previous?.endLine } = input;
  const file = readBoundedText(input.file, "file", previous?.file);
  if (!file.ok) return file;
  const startLine = readPositiveLine(start_line, "start_line");
  if (!startLine.ok) return startLine;
  const endLine = readPositiveLine(end_line, "end_line");
  if (!endLine.ok) return endLine;
  if (endLine.value < startLine.value) {
    return { ok: false, message: "end_line must be greater than or equal to start_line." };
  }
  const summary = readBoundedText(input.summary, "summary", previous?.summary);
  if (!summary.ok) return summary;
  const mechanism = readBoundedText(input.mechanism, "mechanism", previous?.mechanism);
  if (!mechanism.ok) return mechanism;
  return {
    ok: true,
    value: {
      file: file.value,
      startLine: startLine.value,
      endLine: endLine.value,
      summary: summary.value,
      mechanism: mechanism.value,
    },
  };
}

function readCategory(
  value: unknown,
): { ok: true; value: ManagedReviewCandidateCategory } | { ok: false; message: string } {
  if (typeof value !== "string" || !VALID_CATEGORIES.has(value)) {
    return {
      ok: false,
      message: `category must be one of: ${MANAGED_REVIEW_CANDIDATE_CATEGORIES.join(", ")}.`,
    };
  }
  return { ok: true, value: value as ManagedReviewCandidateCategory };
}

function readPriority(
  value: unknown,
): { ok: true; value: ManagedReviewCandidatePriority } | { ok: false; message: string } {
  if (
    typeof value !== "number"
    || !Number.isInteger(value)
    || value < 0
    || value > 3
  ) {
    return { ok: false, message: "priority must be an integer from 0 to 3." };
  }
  return { ok: true, value: value as ManagedReviewCandidatePriority };
}

function countDispositions(
  candidates: readonly ManagedReviewCandidate[],
): ManagedReviewCandidateCounts {
  let pending = 0;
  let keep = 0;
  let drop = 0;
  for (const candidate of candidates) {
    if (candidate.disposition === "keep") {
      keep += 1;
    } else if (candidate.disposition === "drop") {
      drop += 1;
    } else {
      pending += 1;
    }
  }
  return { pending, keep, drop };
}

function cloneCandidate(
  candidate: ManagedReviewCandidate,
): ManagedReviewCandidate {
  return { ...candidate };
}

function cloneReviewFinding(
  finding: AppServerReviewFinding,
): AppServerReviewFinding {
  return {
    ...finding,
    code_location: {
      absolute_file_path: finding.code_location.absolute_file_path,
      line_range: {
        start: finding.code_location.line_range.start,
        end: finding.code_location.line_range.end,
      },
    },
  };
}

function cloneReviewOutput(
  output: AppServerReviewOutput,
): AppServerReviewOutput {
  return {
    findings: output.findings.map(cloneReviewFinding),
    overall_correctness: output.overall_correctness,
    overall_explanation: output.overall_explanation,
    ...(output.overall_confidence_score === undefined
      ? {}
      : { overall_confidence_score: output.overall_confidence_score }),
  };
}

function readNonEmptyString(
  value: unknown,
  field: string,
): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof value !== "string") {
    return { ok: false, message: `${field} must be a non-empty string.` };
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return { ok: false, message: `${field} must be a non-empty string.` };
  }
  return { ok: true, value: trimmed };
}

function readConfidenceScore(
  value: unknown,
  field: string,
): { ok: true; value: number } | { ok: false; message: string } {
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || value < 0
    || value > 1
  ) {
    return { ok: false, message: `${field} must be a number between 0 and 1.` };
  }
  return { ok: true, value };
}

function asPlainObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parseSubmittedFinding(
  value: unknown,
  index: number,
): { ok: true; value: AppServerReviewFinding } | { ok: false; message: string } {
  const prefix = `findings[${index}]`;
  const record = asPlainObject(value);
  if (!record) {
    return { ok: false, message: `${prefix} must be an object.` };
  }
  const title = readNonEmptyString(record.title, `${prefix}.title`);
  if (!title.ok) return title;
  const body = readNonEmptyString(record.body, `${prefix}.body`);
  if (!body.ok) return body;
  const confidenceScore = readConfidenceScore(
    record.confidence_score,
    `${prefix}.confidence_score`,
  );
  if (!confidenceScore.ok) return confidenceScore;
  const priority = readPriority(record.priority);
  if (!priority.ok) {
    return { ok: false, message: `${prefix}.${priority.message}` };
  }
  let category: string | undefined;
  if (record.category !== undefined) {
    const normalized = normalizeReviewCategory(record.category);
    if (!normalized) {
      return {
        ok: false,
        message: `${prefix}.category must be a short single-line string.`,
      };
    }
    category = normalized;
  }
  const location = asPlainObject(record.code_location);
  if (!location) {
    return { ok: false, message: `${prefix}.code_location must be an object.` };
  }
  const filePath = readNonEmptyString(
    location.absolute_file_path,
    `${prefix}.code_location.absolute_file_path`,
  );
  if (!filePath.ok) return filePath;
  // A rooted Windows path without a drive or share still depends on the current drive.
  if (!path.isAbsolute(filePath.value)
    || (process.platform === "win32" && path.parse(filePath.value).root.length === 1)) {
    return {
      ok: false,
      message: `${prefix}.code_location.absolute_file_path must be an absolute path to the file in the reviewed worktree.`,
    };
  }
  const lineRange = asPlainObject(location.line_range);
  if (!lineRange) {
    return { ok: false, message: `${prefix}.code_location.line_range must be an object.` };
  }
  const start = readPositiveLine(
    lineRange.start,
    `${prefix}.code_location.line_range.start`,
  );
  if (!start.ok) return start;
  const end = readPositiveLine(
    lineRange.end,
    `${prefix}.code_location.line_range.end`,
  );
  if (!end.ok) return end;
  if (end.value < start.value) {
    return {
      ok: false,
      message: `${prefix}.code_location.line_range.end must be greater than or equal to start.`,
    };
  }
  return {
    ok: true,
    value: {
      title: title.value,
      body: body.value,
      confidence_score: confidenceScore.value,
      priority: priority.value,
      ...(category ? { category } : {}),
      code_location: {
        absolute_file_path: filePath.value,
        line_range: {
          start: start.value,
          end: end.value,
        },
      },
    },
  };
}

function fullyQualifiedWindowsPath(value: string): boolean {
  return path.win32.isAbsolute(value) && path.win32.parse(value).root.length > 1;
}

function resolveLedgerFindingPath(file: string, cwd?: string): string | undefined {
  if (fullyQualifiedWindowsPath(file)) return file;
  if (cwd && fullyQualifiedWindowsPath(cwd)) {
    // A partially rooted path can depend on a drive or its working directory.
    return path.win32.parse(file).root ? undefined : path.win32.resolve(cwd, file);
  }
  if (cwd && path.posix.isAbsolute(cwd)) {
    return path.posix.isAbsolute(file) ? file : path.posix.resolve(cwd, file);
  }
  return process.platform !== "win32" && path.posix.isAbsolute(file) ? file : undefined;
}

/**
 * Purely in-memory scratchpad of candidate defects recorded during a single
 * managed code review turn. Entries never touch SQLite or disk and are cleared
 * when the review turn terminates or the registry shuts down.
 */
export class ManagedReviewCandidateLedger {
  private readonly turns = new Map<string, TurnLedgerState>();
  /** Only a fresh Codex child can be armed before the provider assigns its turn ID. */
  private readonly toolTurns = new Map<string, { turnId: string | null; cwd?: string }>();

  armToolTurn(child: ReviewChild, turnId: string | null, cwd?: string): void {
    this.toolTurns.set(buildThreadIdentityKey(child.backend, child.threadId), { turnId, cwd });
  }

  confirmToolTurn(turn: ManagedReviewCandidateTurnKey): void {
    const active = this.toolTurns.get(buildThreadIdentityKey(turn.backend, turn.threadId));
    if (active?.turnId === null) active.turnId = turn.turnId;
  }

  hasToolTurn(turn: ReviewChild & { turnId?: string }): boolean {
    return Boolean(turn.turnId)
      && this.toolTurns.get(buildThreadIdentityKey(turn.backend, turn.threadId))?.turnId === turn.turnId;
  }

  retireToolTurn(turn: ManagedReviewCandidateTurnKey): void {
    const key = buildThreadIdentityKey(turn.backend, turn.threadId);
    const active = this.toolTurns.get(key)?.turnId;
    // A terminal can arrive before startTurn returns or before turn/started
    // for a freshly created Codex child. Never reopen it on a late receipt.
    if (active === null || active === turn.turnId) this.toolTurns.delete(key);
  }

  record(
    turn: ManagedReviewCandidateTurnKey,
    input: ManagedReviewCandidateRecordInput,
  ): ManagedReviewCandidateOperationResult<{
    id: string;
    recorded: ManagedReviewCandidate;
    total_candidates: number;
  }> {
    const details = readCandidateDetails(input);
    if (!details.ok) return { ok: false, code: "invalid_arguments", message: details.message };
    const category = readCategory(input.category);
    if (!category.ok) {
      return { ok: false, code: "invalid_arguments", message: category.message };
    }
    const key = buildTurnKey(turn);
    let state = this.turns.get(key);
    if (!state) {
      state = {
        backend: turn.backend,
        threadId: turn.threadId,
        turnId: turn.turnId,
        nextId: 1,
        candidates: [],
      };
      this.turns.set(key, state);
    }
    if (state.candidates.length >= MANAGED_REVIEW_CANDIDATE_MAX_PER_TURN) {
      return {
        ok: false,
        code: "limit_exceeded",
        message: `At most ${MANAGED_REVIEW_CANDIDATE_MAX_PER_TURN} review candidates may be recorded per review turn.`,
      };
    }

    const candidate: ManagedReviewCandidate = {
      id: `C${state.nextId}`,
      ...details.value,
      category: category.value,
      disposition: "pending",
    };
    state.nextId += 1;
    state.candidates.push(candidate);

    return {
      ok: true,
      data: {
        id: candidate.id,
        recorded: cloneCandidate(candidate),
        total_candidates: state.candidates.length,
      },
    };
  }

  list(turn: ManagedReviewCandidateTurnKey): ManagedReviewCandidateListResult {
    const state = this.turns.get(buildTurnKey(turn));
    const candidates = state ? state.candidates.map(cloneCandidate) : [];
    return {
      total: candidates.length,
      counts: countDispositions(candidates),
      candidates,
    };
  }

  dispose(
    turn: ManagedReviewCandidateTurnKey,
    input: ManagedReviewCandidateDisposeInput,
  ): ManagedReviewCandidateOperationResult<{
    updated: ManagedReviewCandidate;
    summary: ManagedReviewCandidateCounts;
  }> {
    const id = readBoundedText(input.id, "id");
    if (!id.ok) {
      return { ok: false, code: "invalid_arguments", message: id.message };
    }
    if (input.disposition !== "keep" && input.disposition !== "drop") {
      return {
        ok: false,
        code: "invalid_arguments",
        message: 'disposition must be "keep" or "drop".',
      };
    }
    const reason = readBoundedText(input.reason, "reason");
    if (!reason.ok) {
      return { ok: false, code: "invalid_arguments", message: reason.message };
    }
    let nextCategory: ManagedReviewCandidateCategory | undefined;
    if (input.category !== undefined) {
      const parsedCategory = readCategory(input.category);
      if (!parsedCategory.ok) {
        return {
          ok: false,
          code: "invalid_arguments",
          message: parsedCategory.message,
        };
      }
      nextCategory = parsedCategory.value;
    }
    let nextPriority: ManagedReviewCandidatePriority | undefined;
    if (input.priority !== undefined) {
      const parsedPriority = readPriority(input.priority);
      if (!parsedPriority.ok) {
        return {
          ok: false,
          code: "invalid_arguments",
          message: parsedPriority.message,
        };
      }
      nextPriority = parsedPriority.value;
    } else if (input.disposition === "keep") {
      return {
        ok: false,
        code: "invalid_arguments",
        message: 'priority (0-3) is required when disposition is "keep".',
      };
    }

    const state = this.turns.get(buildTurnKey(turn));
    const candidate = state?.candidates.find((entry) => entry.id === id.value);
    if (!state || !candidate) {
      return {
        ok: false,
        code: "not_found",
        message: `Unknown review candidate id: ${id.value}`,
      };
    }

    const details = readCandidateDetails(input, candidate);
    if (!details.ok) return { ok: false, code: "invalid_arguments", message: details.message };
    if (input.confidence_score !== undefined) {
      const confidence = readConfidenceScore(input.confidence_score, "confidence_score");
      if (!confidence.ok) return { ok: false, code: "invalid_arguments", message: confidence.message };
      candidate.confidenceScore = confidence.value;
    }

    Object.assign(candidate, details.value);
    candidate.disposition = input.disposition;
    candidate.dispositionReason = reason.value;
    if (nextCategory !== undefined) {
      candidate.category = nextCategory;
    }
    if (input.disposition === "keep") {
      candidate.priority = nextPriority;
    } else {
      delete candidate.priority;
    }

    return {
      ok: true,
      data: {
        updated: cloneCandidate(candidate),
        summary: countDispositions(state.candidates),
      },
    };
  }

  submitOutput(
    turn: ManagedReviewCandidateTurnKey,
    input: ManagedReviewOutputSubmitInput,
  ): ManagedReviewCandidateOperationResult<{
    finding_count: number;
    ledger_summary: ManagedReviewCandidateCounts & { total: number };
  }> {
    if (input.use_ledger !== undefined && typeof input.use_ledger !== "boolean") {
      return { ok: false, code: "invalid_arguments", message: "use_ledger must be a boolean." };
    }
    const useLedger = input.use_ledger === true;
    const explicitFindings = useLedger && input.findings === undefined ? [] : input.findings;
    if (!Array.isArray(explicitFindings)) {
      return { ok: false, code: "invalid_arguments", message: "findings must be an array." };
    }
    if (explicitFindings.length > MANAGED_REVIEW_OUTPUT_MAX_FINDINGS) {
      return {
        ok: false,
        code: "limit_exceeded",
        message: `The findings array may contain at most ${MANAGED_REVIEW_OUTPUT_MAX_FINDINGS} explicit review findings.`,
      };
    }
    const findings: AppServerReviewFinding[] = [];
    const key = buildTurnKey(turn);
    let state = this.turns.get(key);
    if (useLedger && state?.candidates.some(({ disposition }) => disposition === "pending")) {
      return {
        ok: false,
        code: "invalid_arguments",
        message: "Mark every recorded candidate keep or drop before submitting the ledger.",
      };
    }
    if (useLedger && state) {
      const active = this.toolTurns.get(buildThreadIdentityKey(turn.backend, turn.threadId));
      const cwd = active?.turnId === turn.turnId ? active.cwd : undefined;
      for (const candidate of state.candidates) {
        if (candidate.disposition !== "keep") continue;
        const file = resolveLedgerFindingPath(candidate.file, cwd);
        if (!file) {
          return {
            ok: false,
            code: "invalid_arguments",
            message: `Update candidate ${candidate.id} with an absolute file path before submitting.`,
          };
        }
        findings.push({
          title: candidate.summary,
          body: candidate.mechanism,
          priority: candidate.priority,
          category: candidate.category,
          confidence_score: candidate.confidenceScore ?? 0,
          code_location: {
            absolute_file_path: file,
            line_range: { start: candidate.startLine, end: candidate.endLine },
          },
        });
      }
    }
    for (let index = 0; index < explicitFindings.length; index += 1) {
      const parsed = parseSubmittedFinding(explicitFindings[index], index);
      if (!parsed.ok) {
        return { ok: false, code: "invalid_arguments", message: parsed.message };
      }
      findings.push(parsed.value);
    }
    if (useLedger) {
      findings.sort((a, b) => (a.priority ?? 3) - (b.priority ?? 3));
    }
    const correctness = readNonEmptyString(
      input.overall_correctness,
      "overall_correctness",
    );
    if (!correctness.ok) {
      return { ok: false, code: "invalid_arguments", message: correctness.message };
    }
    const verdict = normalizeOverallCorrectness(correctness.value, findings);
    const expectedVerdict = findings.length === 0 ? "patch is correct" : "patch is incorrect";
    if (verdict !== expectedVerdict) {
      return {
        ok: false,
        code: "invalid_arguments",
        message: `overall_correctness must be "${expectedVerdict}" when the findings array is ${findings.length === 0 ? "empty" : "non-empty"}.`,
      };
    }
    const explanation = readNonEmptyString(
      input.overall_explanation,
      "overall_explanation",
    );
    if (!explanation.ok) {
      return { ok: false, code: "invalid_arguments", message: explanation.message };
    }
    let overallConfidence: number | undefined;
    if (input.overall_confidence_score !== undefined) {
      const parsedScore = readConfidenceScore(
        input.overall_confidence_score,
        "overall_confidence_score",
      );
      if (!parsedScore.ok) {
        return { ok: false, code: "invalid_arguments", message: parsedScore.message };
      }
      overallConfidence = normalizeReviewConfidenceScore(parsedScore.value);
    }

    const output: AppServerReviewOutput = {
      findings,
      overall_correctness: verdict,
      overall_explanation: explanation.value,
      ...(overallConfidence === undefined
        ? {}
        : { overall_confidence_score: overallConfidence }),
    };

    if (!state) {
      state = {
        backend: turn.backend,
        threadId: turn.threadId,
        turnId: turn.turnId,
        nextId: 1,
        candidates: [],
      };
      this.turns.set(key, state);
    }
    state.submittedOutput = output;

    return {
      ok: true,
      data: {
        finding_count: findings.length,
        ledger_summary: {
          total: state.candidates.length,
          ...countDispositions(state.candidates),
        },
      },
    };
  }

  submittedOutput(turn: ManagedReviewCandidateTurnKey): AppServerReviewOutput | undefined {
    const submitted = this.turns.get(buildTurnKey(turn))?.submittedOutput;
    return submitted ? cloneReviewOutput(submitted) : undefined;
  }

  snapshot(turn: ManagedReviewCandidateTurnKey): ManagedReviewCandidateCounts & { total: number } {
    const state = this.turns.get(buildTurnKey(turn));
    if (!state) {
      return { total: 0, pending: 0, keep: 0, drop: 0 };
    }
    return {
      total: state.candidates.length,
      ...countDispositions(state.candidates),
    };
  }

  clearTurn(turn: ManagedReviewCandidateTurnKey): boolean {
    return this.turns.delete(buildTurnKey(turn));
  }

  clearThread(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): number {
    this.toolTurns.delete(buildThreadIdentityKey(params.backend, params.threadId));
    let removed = 0;
    for (const [key, state] of this.turns.entries()) {
      if (state.backend === params.backend && state.threadId === params.threadId) {
        this.turns.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  clearAll(): void {
    this.turns.clear();
    this.toolTurns.clear();
  }

  get activeTurnCount(): number {
    return this.turns.size;
  }
}
