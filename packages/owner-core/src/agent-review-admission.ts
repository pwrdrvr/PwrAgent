import type { OwnerThreadIdentity } from "./thread-storage.js";

export const AGENT_REVIEW_LIMIT = 3;

export type OperatorReviewInput = { turnId: string; observedAt: number };
type ReviewAttempt = { turnId: string; diff?: string };

export type AgentReviewAdmission = OwnerThreadIdentity & ReviewAttempt & { operatorInput?: OperatorReviewInput };
export type AgentReviewBudget = { operatorInput?: OperatorReviewInput; attempts: ReviewAttempt[] };
export type AgentReviewRefusal = "duplicate_turn" | "duplicate_diff" | "limit";

export interface AgentReviewAdmissionStore {
  readAgentReviewBudget(thread: OwnerThreadIdentity): AgentReviewBudget | undefined;
  claimAgentReview(request: AgentReviewAdmission): AgentReviewRefusal | undefined;
  rearmAgentReviews(thread: OwnerThreadIdentity, operatorInput: OperatorReviewInput): void;
}

function reviewBudget(current: AgentReviewBudget | undefined, operatorInput?: OperatorReviewInput): AgentReviewBudget {
  if (!current || (operatorInput && operatorInput.turnId !== current.operatorInput?.turnId
    && operatorInput.observedAt > (current.operatorInput?.observedAt ?? -Infinity))) {
    return { operatorInput, attempts: [] };
  }
  return current;
}

/** Persist a new boundary only when it clears attempts that could survive a restart. */
export function rearmAgentReviewBudget(
  current: AgentReviewBudget | undefined,
  operatorInput: OperatorReviewInput,
): AgentReviewBudget | undefined {
  if (!current?.attempts.length) return undefined;
  const next = reviewBudget(current, operatorInput);
  return next === current ? undefined : next;
}

export function canClaimAgentReview(current: AgentReviewBudget | undefined, request: Pick<AgentReviewAdmission, "operatorInput" | "turnId" | "diff">): AgentReviewRefusal | undefined {
  return reviewRefusal(reviewBudget(current, request.operatorInput).attempts, request);
}

function reviewRefusal(attempts: ReviewAttempt[], request: ReviewAttempt): AgentReviewRefusal | undefined {
  if (attempts.some(({ turnId }) => turnId === request.turnId)) return "duplicate_turn";
  if (request.diff && attempts.some(({ diff }) => diff === request.diff)) return "duplicate_diff";
  if (attempts.length >= AGENT_REVIEW_LIMIT) return "limit";
  return undefined;
}

export function claimAgentReviewBudget(current: AgentReviewBudget | undefined, request: AgentReviewAdmission): AgentReviewBudget | AgentReviewRefusal {
  const budget = reviewBudget(current, request.operatorInput);
  const refusal = reviewRefusal(budget.attempts, request);
  if (refusal) return refusal;
  return { ...budget, attempts: [...budget.attempts, { turnId: request.turnId, diff: request.diff }] };
}
