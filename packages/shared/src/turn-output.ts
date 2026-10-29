/**
 * The final answer in a `turn/completed` notification's `turn.output`.
 *
 * Claude reports each assistant message of the turn as its own part, so the
 * answer is the last non-empty part, not its progress notes before it. Codex
 * sends no parts and ACP sends at most one. Accepts `unknown` because some
 * readers see a raw notification whose `output` may be missing.
 */
export function finalTurnOutputText(output: unknown): string | undefined {
  if (!Array.isArray(output)) return undefined;
  return output
    .map((part: unknown) =>
      part
      && typeof part === "object"
      && (part as { type?: unknown }).type === "text"
      && typeof (part as { text?: unknown }).text === "string"
        ? ((part as { text: string }).text).trim()
        : "",
    )
    .findLast(Boolean);
}
