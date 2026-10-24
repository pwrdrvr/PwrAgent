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
