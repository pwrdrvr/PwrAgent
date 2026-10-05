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

/**
 * The one refusal every turn source receives for a locked thread: the
 * composer, queued releases, CI auto-repair and PR auto-fix, messaging,
 * peers, scheduled actions, and agent tools. It names the note so a log line
 * or a channel reply explains why nothing ran.
 */
export function threadLockRefusalMessage(lock: Pick<ThreadLock, "note">): string {
  if (!lock.note) return "This thread is locked. Unlock it before starting a turn.";
  const note = /[.!?]["')\]]?$/.test(lock.note) ? lock.note : `${lock.note}.`;
  return `This thread is locked: ${note} Unlock it before starting a turn.`;
}
