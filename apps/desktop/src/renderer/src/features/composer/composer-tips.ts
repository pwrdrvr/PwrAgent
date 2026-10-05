import { formatPrimaryAccel } from "../../lib/keyboard-accel";

/**
 * Tips the empty reply composer shows in place of a fixed placeholder, one at
 * a time (see `useComposerTip`).
 *
 * Each tip names the key to press or the words to say, so it can be acted on
 * from the box it appears in. Keep each one to about 80 characters: Geist at
 * 14px fits that on one line of a ~575px composer, and a longer tip wraps and
 * grows the empty box. Shortcut tips are functions so they render the
 * platform's chord (⌘ on macOS, Ctrl elsewhere) when shown.
 */
export const COMPOSER_TIPS: readonly (() => string)[] = [
  () => "Type @ to mention a project folder, or a federated machine or profile",
  () => "Type # to mention another thread or a pull request by number",
  () => "Type / for commands, like /review to review uncommitted changes",
  () => "Type $ to pick a Codex skill. Other harnesses list their skills under /",
  () => "Pinned threads are never auto-archived. Right-click a thread to pin it",
  () => "In Directories, right-click a thread and choose Keep at Top to hold it first",
  () => "Mention a #thread and say “Send that thread a message asking it to…”",
  () => "Ask to “hand off a child thread to…” with or without this thread’s history",
  () => "Say “Hand off a thread in @project to…” to start work in another project",
  () => "The $ tab on the right shows this turn’s cost at list price and your limit pace",
  () => `Press ${formatPrimaryAccel("K")} to jump to any thread, or ${formatPrimaryAccel("F", { shift: true })} to search them all`,
  () => `While a turn runs, Enter queues your message and ${formatPrimaryAccel("Enter")} steers it in`,
  () => `Press ${formatPrimaryAccel("[")} and ${formatPrimaryAccel("]")} to go back and forward between threads`,
  () => "Right-click a thread to fork it or start a sub-thread in a new worktree",
  () => "Paste or drop images, GIFs, and PDFs straight into this box",
  () => "The Drafts lens lists every thread with a reply you started and never sent",
  () => "Connect Telegram, Slack, or Discord in Settings to run threads from your phone",
  () => "Right-click a thread and choose Mark Unread to come back to it later",
];
