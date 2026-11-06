import type { AppServerThreadEntry } from "@pwragent/shared";

/** The most transcript a primer carries, in characters (about 15k tokens). */
export const CLAUDE_PRIMER_MAX_CHARS = 60_000;

/** One message longer than this keeps its start and end only. */
const MAX_MESSAGE_CHARS = 8_000;

const PRIMER_HEADER = [
  "This conversation continues in a new Claude session because Claude Code deleted the previous one.",
  "Below is PwrAgent's record of the earlier messages, newest last. Tool calls and their output are not included,",
  "so check the working tree before relying on details from them. Treat it as background, not as new requests.",
].join(" ");

const PRIMER_FOOTER = "End of the earlier conversation. The operator's new message follows.";

/**
 * The text that opens the first prompt of a thread's new Claude session: the
 * thread's own user and assistant messages, newest kept first, within
 * `maxChars`. Undefined when there is nothing to carry over.
 */
export function buildClaudeSessionPrimer(
  entries: readonly AppServerThreadEntry[],
  maxChars = CLAUDE_PRIMER_MAX_CHARS,
): string | undefined {
  const messages = entries.flatMap((entry) => entry.type === "message" && entry.text.trim()
    ? [`${entry.role === "user" ? "Operator" : "Claude"}: ${clip(entry.text.trim())}`]
    : []);
  const budget = maxChars - PRIMER_HEADER.length - PRIMER_FOOTER.length - 8;
  const kept: string[] = [];
  let used = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (used + message.length + 2 > budget) break;
    kept.unshift(message);
    used += message.length + 2;
  }
  if (!kept.length) return undefined;
  const omitted = messages.length - kept.length;
  return [
    PRIMER_HEADER,
    ...(omitted ? [`(${omitted} earlier ${omitted === 1 ? "message is" : "messages are"} not included.)`] : []),
    "",
    kept.join("\n\n"),
    "",
    PRIMER_FOOTER,
  ].join("\n");
}

function clip(text: string): string {
  if (text.length <= MAX_MESSAGE_CHARS) return text;
  const half = Math.floor((MAX_MESSAGE_CHARS - 20) / 2);
  return `${text.slice(0, half)}\n[…shortened…]\n${text.slice(-half)}`;
}
