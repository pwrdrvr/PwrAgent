import type { ThreadLock } from "./contracts/navigation";

/** Longest lock note kept, in UTF-16 code units. Longer notes are truncated. */
export const THREAD_LOCK_NOTE_MAX_LENGTH = 1000;

/** Trims a lock note and caps its length. Blank becomes undefined. */
export function normalizeThreadLockNote(note: string | undefined): string | undefined {
  const trimmed = note?.trim();
  if (!trimmed) return undefined;
  return trimmed.length > THREAD_LOCK_NOTE_MAX_LENGTH
    ? trimmed.slice(0, THREAD_LOCK_NOTE_MAX_LENGTH).trimEnd()
    : trimmed;
}

/** Longest note offered again as a recent-note chip in the lock dialog. */
export const THREAD_LOCK_RECENT_NOTE_MAX_LENGTH = 48;
/** How many recent notes the lock dialog offers. */
export const THREAD_LOCK_RECENT_NOTES_LIMIT = 5;

/**
 * Normalizes a note for the recent-notes list, or undefined when it does not
 * belong there: blank, more than one line, or longer than a chip holds. A
 * long note still saves on the thread; it just is not offered again.
 */
export function normalizeRecentThreadLockNote(note: string | undefined): string | undefined {
  const normalized = normalizeThreadLockNote(note);
  if (!normalized || /[\r\n]/.test(normalized)) return undefined;
  return normalized.length > THREAD_LOCK_RECENT_NOTE_MAX_LENGTH ? undefined : normalized;
}

/** Reads a stored recent-notes list, dropping anything malformed. */
export function parseRecentThreadLockNotes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const notes: string[] = [];
  for (const entry of value) {
    const note = typeof entry === "string" ? normalizeRecentThreadLockNote(entry) : undefined;
    if (note && !notes.includes(note)) notes.push(note);
    if (notes.length === THREAD_LOCK_RECENT_NOTES_LIMIT) break;
  }
  return notes;
}

/**
 * Moves a note to the front of the recent-notes list, newest first and
 * without repeats. A note that does not qualify leaves the list as it was.
 */
export function rememberRecentThreadLockNote(
  notes: readonly string[],
  note: string | undefined,
): string[] {
  const normalized = normalizeRecentThreadLockNote(note);
  if (!normalized) return [...notes];
  return [normalized, ...notes.filter((existing) => existing !== normalized)]
    .slice(0, THREAD_LOCK_RECENT_NOTES_LIMIT);
}

/** Drops a note from the recent-notes list, as its chip's remove button does. */
export function forgetRecentThreadLockNote(
  notes: readonly string[],
  note: string | undefined,
): string[] {
  const normalized = normalizeThreadLockNote(note);
  return notes.filter((existing) => existing !== normalized);
}

const THREAD_LOCK_REFUSAL_PREFIX = "This thread is locked";

/**
 * The one refusal every turn source receives for a locked thread: the
 * composer, queued releases, CI auto-repair and PR auto-fix, messaging,
 * peers, scheduled actions, and agent tools. It names the note so a log line
 * or a channel reply explains why nothing ran.
 */
export function threadLockRefusalMessage(lock: Pick<ThreadLock, "note">): string {
  if (!lock.note) return `${THREAD_LOCK_REFUSAL_PREFIX}. Unlock it before starting a turn.`;
  const note = /[.!?]["')\]]?$/.test(lock.note) ? lock.note : `${lock.note}.`;
  return `${THREAD_LOCK_REFUSAL_PREFIX}: ${note} Unlock it before starting a turn.`;
}

/**
 * Whether an error message is a lock refusal. The refusal crosses IPC and
 * federation as text, and its note is free text that can read like any other
 * error ("repair in progress"), so callers that classify errors by wording
 * must ask this first.
 */
export function isThreadLockRefusal(message: string): boolean {
  return message.includes(THREAD_LOCK_REFUSAL_PREFIX);
}
