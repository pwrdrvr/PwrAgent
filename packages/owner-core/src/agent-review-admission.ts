import type { OwnerThreadIdentity } from "./thread-storage.js";

export const AGENT_REVIEW_LIMIT = 3;

export type OperatorReviewInput = { turnId: string; observedAt?: number };
type ReviewAttempt = { turnId: string; diff?: string };

export type AgentReviewAdmission = OwnerThreadIdentity & ReviewAttempt & {
  /** True when the claiming turn itself is a genuine non-review-fix operator turn. */
  isOperatorTurn?: boolean;
};
export type AgentReviewBudget = {
  /** Last genuine operator turn that cleared or anchored this window. */
  operatorTurnId?: string;
  /** Legacy field written by older builds; read as fallback for `operatorTurnId`. */
  operatorInput?: { turnId: string; observedAt: number };
  attempts: ReviewAttempt[];
};
export type AgentReviewRefusal = "duplicate_turn" | "duplicate_diff" | "limit" | "review_fix_turn";

export interface AgentReviewAdmissionStore {
  readAgentReviewBudget(thread: OwnerThreadIdentity): AgentReviewBudget | undefined;
  claimAgentReview(request: AgentReviewAdmission): AgentReviewRefusal | undefined;
  rearmAgentReviews(thread: OwnerThreadIdentity, operatorInput: OperatorReviewInput): void;
}

function budgetOperatorTurnId(current: AgentReviewBudget | undefined): string | undefined {
  return current?.operatorTurnId ?? current?.operatorInput?.turnId;
}

/**
 * Persist a new boundary only when it clears attempts that could survive a
 * restart. Rearming keys off the distinct operator turn ID rather than wall
 * clock timestamps, so same-millisecond turns and backward NTP steps still
 * rearm, and re-observing the same operator turn never clears its own attempt.
 */
export function rearmAgentReviewBudget(
  current: AgentReviewBudget | undefined,
  operatorInput: OperatorReviewInput,
): AgentReviewBudget | undefined {
  if (!current?.attempts.length) return undefined;
  if (budgetOperatorTurnId(current) === operatorInput.turnId) return undefined;
  return { operatorTurnId: operatorInput.turnId, attempts: [] };
}

function effectiveAttempts(
  current: AgentReviewBudget | undefined,
  request: Pick<AgentReviewAdmission, "turnId" | "isOperatorTurn">,
): ReviewAttempt[] {
  if (!current) return [];
  if (request.isOperatorTurn && current.attempts.length > 0
    && budgetOperatorTurnId(current) !== request.turnId) {
    return [];
  }
  return current.attempts;
}

export function canClaimAgentReview(
  current: AgentReviewBudget | undefined,
  request: Pick<AgentReviewAdmission, "turnId" | "diff" | "isOperatorTurn">,
): AgentReviewRefusal | undefined {
  return reviewRefusal(effectiveAttempts(current, request), request);
}

function reviewRefusal(attempts: ReviewAttempt[], request: ReviewAttempt): AgentReviewRefusal | undefined {
  if (attempts.some(({ turnId }) => turnId === request.turnId)) return "duplicate_turn";
  if (request.diff && attempts.some(({ diff }) => diff === request.diff)) return "duplicate_diff";
  if (attempts.length >= AGENT_REVIEW_LIMIT) return "limit";
  return undefined;
}

export function claimAgentReviewBudget(
  current: AgentReviewBudget | undefined,
  request: AgentReviewAdmission,
): AgentReviewBudget | AgentReviewRefusal {
  const attempts = effectiveAttempts(current, request);
  const refusal = reviewRefusal(attempts, request);
  if (refusal) return refusal;
  const operatorTurnId = request.isOperatorTurn
    ? request.turnId
    : budgetOperatorTurnId(current);
  return {
    ...(operatorTurnId ? { operatorTurnId } : {}),
    attempts: [...attempts, { turnId: request.turnId, ...(request.diff ? { diff: request.diff } : {}) }],
  };
}
