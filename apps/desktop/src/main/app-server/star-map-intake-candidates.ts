/**
 * The shape of a Star Map intake's "which project?" list, shared by the two
 * things that produce one: the intake agent's `ask_operator_to_pick_project`
 * tool and the deterministic resolver that stands in for it.
 *
 * These live together because both numbers are load-bearing in two places at
 * once. The cap is sliced by the dispatcher AND interpolated into the tool
 * schema the model reads, so two copies would let the model be told a
 * different limit than the one enforced. The truncation length is what keeps
 * a reason from overflowing its row, and its code-point rule is what keeps a
 * clause ending in an emoji from leaving a lone surrogate there.
 */

/** How many projects the operator is ever asked to choose between. */
export const MAX_DISAMBIGUATION_CANDIDATES = 8;

const MAX_CANDIDATE_REASON_CHARS = 120;

/**
 * Cut a reason at a character boundary, so a clause ending in an emoji or
 * other non-BMP character does not leave a lone surrogate in the row.
 */
export function truncateCandidateReason(reason: string): string {
  if (reason.length <= MAX_CANDIDATE_REASON_CHARS) return reason;
  return [...reason].slice(0, MAX_CANDIDATE_REASON_CHARS).join("");
}
