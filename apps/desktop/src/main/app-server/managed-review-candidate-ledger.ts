import type { AppServerBackendKind } from "@pwragent/shared/contracts/normalized-app-server";
import { buildThreadIdentityKey } from "@pwragent/shared/contracts/navigation";

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

export type ManagedReviewCandidateDisposeInput = {
  id: unknown;
  disposition: unknown;
  priority?: unknown;
  category?: unknown;
  reason: unknown;
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
};

const VALID_CATEGORIES = new Set<string>(MANAGED_REVIEW_CANDIDATE_CATEGORIES);

function buildTurnKey(turn: ManagedReviewCandidateTurnKey): string {
  return JSON.stringify([turn.backend, turn.threadId, turn.turnId]);
}

function readBoundedText(
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

/**
 * Purely in-memory scratchpad of candidate defects recorded during a single
 * managed code review turn. Entries never touch SQLite or disk and are cleared
 * when the review turn terminates or the registry shuts down.
 */
export class ManagedReviewCandidateLedger {
  private readonly turns = new Map<string, TurnLedgerState>();
  /** Only a fresh Codex child can be armed before the provider assigns its turn ID. */
  private readonly toolTurns = new Map<string, string | null>();

  armToolTurn(child: ReviewChild, turnId: string | null): void {
    this.toolTurns.set(buildThreadIdentityKey(child.backend, child.threadId), turnId);
  }

  confirmToolTurn(turn: ManagedReviewCandidateTurnKey): void {
    const key = buildThreadIdentityKey(turn.backend, turn.threadId);
    if (this.toolTurns.get(key) === null) this.toolTurns.set(key, turn.turnId);
  }

  hasToolTurn(turn: ReviewChild & { turnId?: string }): boolean {
    return Boolean(turn.turnId)
      && this.toolTurns.get(buildThreadIdentityKey(turn.backend, turn.threadId)) === turn.turnId;
  }

  retireToolTurn(turn: ManagedReviewCandidateTurnKey): void {
    const key = buildThreadIdentityKey(turn.backend, turn.threadId);
    const active = this.toolTurns.get(key);
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
    const file = readBoundedText(input.file, "file");
    if (!file.ok) {
      return { ok: false, code: "invalid_arguments", message: file.message };
    }
    const startLine = readPositiveLine(input.start_line, "start_line");
    if (!startLine.ok) {
      return { ok: false, code: "invalid_arguments", message: startLine.message };
    }
    const endLine = readPositiveLine(input.end_line, "end_line");
    if (!endLine.ok) {
      return { ok: false, code: "invalid_arguments", message: endLine.message };
    }
    if (endLine.value < startLine.value) {
      return {
        ok: false,
        code: "invalid_arguments",
        message: "end_line must be greater than or equal to start_line.",
      };
    }
    const category = readCategory(input.category);
    if (!category.ok) {
      return { ok: false, code: "invalid_arguments", message: category.message };
    }
    const summary = readBoundedText(input.summary, "summary");
    if (!summary.ok) {
      return { ok: false, code: "invalid_arguments", message: summary.message };
    }
    const mechanism = readBoundedText(input.mechanism, "mechanism");
    if (!mechanism.ok) {
      return { ok: false, code: "invalid_arguments", message: mechanism.message };
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
      file: file.value,
      startLine: startLine.value,
      endLine: endLine.value,
      category: category.value,
      summary: summary.value,
      mechanism: mechanism.value,
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
