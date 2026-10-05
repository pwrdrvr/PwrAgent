import { formatPrimaryAccel } from "../../lib/keyboard-accel";

/**
 * Tips the empty reply composer shows in place of a fixed placeholder, one at
 * a time (see `useComposerTip`).
 *
 * Each tip names the key to press or the words to say, so it can be acted on
 * from the box it appears in. Keep each one to 58 characters in its
 * Windows/Linux form. The reply box is about 410px wide at the default
 * 1280px window with both side panels open, which leaves ~384px of text; at
 * Geist 14px a 58-character tip measures at most ~370px. The empty box stays
 * one line tall (see `composer-height-growth.spec.ts`), so a narrower box
 * truncates a tip with an ellipsis rather than growing. Shortcut tips are
 * functions so they render the platform's chord (⌘ on macOS, Ctrl elsewhere)
 * when shown.
 */
export const COMPOSER_TIPS: readonly (() => string)[] = [
  () => "Type @ to mention a project, machine, or profile",
  () => "Type # to mention a thread or pull request",
  () => "Type / for commands, like /review for a code review",
  () => "Type $ for Codex skills. Other harnesses use /",
  () => "Pin a thread to keep it from being auto-archived",
  () => "In Directories, Keep at Top holds a thread above pins",
  () => "Say “Send #thread a message asking it to…”",
  () => "Say “Hand off a child thread to…”, with or without history",
  () => "Say “Hand off a thread in @project to…”",
  () => "The $ tab shows turn cost at list price and limit pace",
  () => `${formatPrimaryAccel("K")} jumps to a thread. ${formatPrimaryAccel("F", { shift: true })} searches them all`,
  () => `While a turn runs, ${formatPrimaryAccel("Enter")} steers your message in`,
  () => `${formatPrimaryAccel("[")} and ${formatPrimaryAccel("]")} go back and forward between threads`,
  () => "Right-click a thread to fork it or start a sub-thread",
  () => "Paste or drop images, GIFs, and PDFs here",
  () => "The Drafts lens lists replies you started but never sent",
  () => "Drive threads from Telegram, Slack, or Discord",
  () => "Right-click a thread and Mark Unread to revisit it later",
];
