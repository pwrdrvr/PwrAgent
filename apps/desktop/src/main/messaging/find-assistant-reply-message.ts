import type {
  AppServerThreadMessage,
  AppServerThreadReplay,
} from "@pwragent/shared";

/**
 * The assistant message a reply is about to be posted for. An item id names
 * it exactly. Otherwise the text picks it, within the turn when one is known.
 * A thread's owner and a federation gateway pick with the same rule.
 */
export function findAssistantMessageForText(
  replay: AppServerThreadReplay,
  text: string,
  itemId?: string,
  turnId?: string,
): AppServerThreadMessage | undefined {
  if (itemId) {
    for (let index = replay.messages.length - 1; index >= 0; index -= 1) {
      const message = replay.messages[index];
      if (message?.role === "assistant" && message.id === itemId) {
        return message;
      }
    }
    for (let index = replay.entries.length - 1; index >= 0; index -= 1) {
      const entry = replay.entries[index];
      if (
        entry?.type === "message"
        && entry.role === "assistant"
        && entry.id === itemId
      ) {
        return entry;
      }
    }
  }
  const expected = text.trim();
  if (turnId) {
    for (let index = replay.entries.length - 1; index >= 0; index -= 1) {
      const entry = replay.entries[index];
      if (
        entry?.type === "message"
        && entry.role === "assistant"
        && entry.turn?.id === turnId
        && entry.text.trim() === expected
      ) {
        return entry;
      }
    }
  }
  // Empty assistant messages need an item or turn identity. Falling back to a
  // text-only match here could pick an unrelated image-only result from an
  // earlier turn when the current terminal event produced no assistant output.
  if (!expected && (itemId || turnId)) {
    return undefined;
  }
  for (let index = replay.messages.length - 1; index >= 0; index -= 1) {
    const message = replay.messages[index];
    if (message?.role === "assistant" && message.text.trim() === expected) {
      return message;
    }
  }
  for (let index = replay.entries.length - 1; index >= 0; index -= 1) {
    const entry = replay.entries[index];
    if (
      entry?.type === "message"
      && entry.role === "assistant"
      && entry.text.trim() === expected
    ) {
      return entry;
    }
  }
  return undefined;
}
