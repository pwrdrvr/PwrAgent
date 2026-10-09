import { formatActionChord, formatPrimaryAccel } from "../../lib/keyboard-accel";

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
 * functions so they render the operator's current chord in the platform's
 * notation when shown, and show nothing (the plain placeholder) when the
 * operator unbound it.
 */
const withChord = (
  actionId: Parameters<typeof formatActionChord>[0],
  tip: (chord: string) => string,
) => (): string | undefined => {
  const chord = formatActionChord(actionId);
  return chord === undefined ? undefined : tip(chord);
};

export const COMPOSER_TIPS: readonly (() => string | undefined)[] = [
  () => "Type @ to mention a project, machine, or profile",
  () => "Type # to mention a thread or pull request",
  () => "Type / for commands, like /review for a code review",
  () => "Type $ for Codex skills. Other harnesses use /",
  () => "Pins keep your active threads in focus. Unpin to tidy up",
  () => "In Directories, Keep at Top holds a thread above pins",
  () => "Say “Send #thread a message asking it to…”",
  () => "Say “Handoff a child thread to…” to split off visible work",
  () => "Say “Handoff a thread in @project to…”",
  () => "The $ tab shows turn cost at list price and limit pace",
  withChord("navigation.jump_to_thread", (chord) => `${chord} finds threads by name, PR #, branch, or project`),
  withChord("navigation.jump_to_thread", (chord) => `To start a thread fast: ${chord}, type a project, then Enter`),
  withChord("navigation.jump_to_thread", (chord) => `${chord}, a PR number, and Enter opens that PR’s thread`),
  withChord("navigation.search_threads", (chord) => `${chord} searches the text of every transcript`),
  () => `While a turn runs, ${formatPrimaryAccel("Enter")} steers your message in`,
  () => {
    const back = formatActionChord("navigation.back");
    const forward = formatActionChord("navigation.forward");
    return back === undefined || forward === undefined
      ? undefined
      : `${back} and ${forward} go back and forward between threads`;
  },
  () => "Right-click a thread to fork it or start a sub-thread",
  () => "Paste or drop images, GIFs, and PDFs here",
  () => "The Drafts lens lists replies you started but never sent",
  () => "Drive threads from Telegram, Slack, or Discord",
  () => "Right-click a thread and Mark Unread to revisit it later",
];
