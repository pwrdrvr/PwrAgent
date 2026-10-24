import type { AppServerThreadEntry } from "@pwragent/shared";
import { isTerminalTurnMetadata } from "@pwragent/shared";
import { readRendererSequence } from "./live-transcript-activity";
import { isConcreteWorkEntry } from "./transcript-render-items";

function isTurnAnswer(entry: AppServerThreadEntry, turnId: string): boolean {
  return (
    entry.turn?.id === turnId
    && entry.type === "message"
    && entry.role === "assistant"
    && entry.phase === "final"
  );
}

/**
 * Whether a late work row belongs above `answer`, a final reply of its turn.
 *
 * Only finished turns qualify. Codex stamps a final reply with its
 * second-truncated completion, and the renderer stamps live and turn-boundary
 * rows with the millisecond it saw them, so work the turn did before it
 * answered can read as newer than the answer. Below the answer, that work makes
 * the answer read as an interim reply, and the transcript folds it into the
 * turn's "Worked for" group.
 *
 * ACP agents tag every reply final, so work can follow a reply within a turn.
 * While the turn runs, nothing moves. When the renderer saw the reply before
 * the row (both carry renderer sequences), the row stays below it.
 *
 * Rows that cannot fold an answer (replies, file diffs, usage, failure
 * markers) never move.
 */
export function lateWorkBelongsAboveAnswer(
  row: AppServerThreadEntry,
  answer: AppServerThreadEntry,
): boolean {
  const turnId = row.turn?.id;
  if (!turnId || !isConcreteWorkEntry(row) || !isTurnAnswer(answer, turnId)) {
    return false;
  }
  if (!isTerminalTurnMetadata(row.turn) && !isTerminalTurnMetadata(answer.turn)) {
    return false;
  }
  const rowSequence = readRendererSequence(row);
  const answerSequence = readRendererSequence(answer);
  return (
    typeof rowSequence !== "number"
    || typeof answerSequence !== "number"
    || answerSequence > rowSequence
  );
}

/**
 * The index of the answer, the turn's last final reply, that a finished
 * turn's late work row goes above, or -1 when the row has no such place.
 */
export function turnAnswerIndexForLateWork(
  entries: readonly AppServerThreadEntry[],
  row: AppServerThreadEntry,
): number {
  const turnId = row.turn?.id;
  if (!turnId || !isConcreteWorkEntry(row)) {
    return -1;
  }
  const answerIndex = entries.findLastIndex((entry) => isTurnAnswer(entry, turnId));
  return answerIndex !== -1 && lateWorkBelongsAboveAnswer(row, entries[answerIndex]!)
    ? answerIndex
    : -1;
}

/**
 * Inserts late work rows, by turn id, above each turn's answer. The caller has
 * already checked each row with `turnAnswerIndexForLateWork`. A row whose turn
 * has no answer on the list goes last, so no row is lost.
 *
 * One pass, O(n). Returns the input array when nothing is inserted.
 */
export function insertRowsAboveTurnAnswers(
  entries: AppServerThreadEntry[],
  rowsByTurnId: ReadonlyMap<string, AppServerThreadEntry[]>,
): AppServerThreadEntry[] {
  if (rowsByTurnId.size === 0) {
    return entries;
  }
  const answerIndexByTurnId = new Map<string, number>();
  entries.forEach((entry, index) => {
    const turnId = entry.turn?.id;
    if (turnId && rowsByTurnId.has(turnId) && isTurnAnswer(entry, turnId)) {
      answerIndexByTurnId.set(turnId, index);
    }
  });
  const rowsBeforeIndex = new Map<number, AppServerThreadEntry[]>();
  const unplacedRows: AppServerThreadEntry[] = [];
  for (const [turnId, rows] of rowsByTurnId) {
    const answerIndex = answerIndexByTurnId.get(turnId);
    if (answerIndex === undefined) {
      unplacedRows.push(...rows);
    } else {
      rowsBeforeIndex.set(answerIndex, rows);
    }
  }

  const placed: AppServerThreadEntry[] = [];
  entries.forEach((entry, index) => {
    placed.push(...(rowsBeforeIndex.get(index) ?? []), entry);
  });
  placed.push(...unplacedRows);
  return placed;
}
