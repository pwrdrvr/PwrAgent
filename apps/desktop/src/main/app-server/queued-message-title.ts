import type { AppServerTurnInputItem } from "@pwragent/shared";
import queuedMessageTitlePrompt from "./queued-message-title-prompt.md?raw";
import type { ThreadTitleAdapterResult } from "./thread-title-generation-service";

/**
 * Short titles for queued messages.
 *
 * A queued message shows as one line above the composer. A message that fits
 * on that line is its own title; a long one — a child thread's progress
 * report, a pasted plan — needs a few words that tell it apart from the rest
 * of the queue. A helper turn writes those words once, when the message joins
 * a busy thread's queue. The title is display-only and lives on the queue
 * entry in memory, like the queue itself: nothing here touches sqlite.
 */

/**
 * A message at or under this many characters, on one line, is shown as typed
 * and never sent to the helper. Measured against the trimmed text.
 */
export const QUEUED_MESSAGE_TITLE_SOURCE_THRESHOLD = 60;
export const QUEUED_MESSAGE_TITLE_MAX_CHARACTERS = 48;
const QUEUED_MESSAGE_TITLE_MAX_WORDS = 7;
/** Long enough to name any message; a pasted log needs no more context. */
const QUEUED_MESSAGE_TITLE_SOURCE_LIMIT = 4_000;
const QUEUED_MESSAGE_TITLE_TIMEOUT_MS = 20_000;
const QUEUED_MESSAGE_TITLE_TURN_TIMEOUT_MS = 60_000;
const MESSAGE_PLACEHOLDER = "{{MESSAGE}}";

export const QUEUED_MESSAGE_TITLE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    title: { type: "string" },
  },
  required: ["title"],
  additionalProperties: false,
};

export const QUEUED_MESSAGE_TITLE_SYSTEM_PROMPT =
  "You label queued messages for a coding agent's operator. Return only the requested JSON.";

/**
 * The text a title would be written from, or undefined when the message
 * needs none: short and on one line, or no text at all (an image-only send).
 */
export function queuedMessageTitleSource(
  input: readonly AppServerTurnInputItem[],
): string | undefined {
  const text = input
    .flatMap((item) => (item.type === "text" ? [item.text] : []))
    .join("\n")
    .trim();
  if (!text) return undefined;
  if (text.length <= QUEUED_MESSAGE_TITLE_SOURCE_THRESHOLD && !text.includes("\n")) {
    return undefined;
  }
  return text.slice(0, QUEUED_MESSAGE_TITLE_SOURCE_LIMIT);
}

export function buildQueuedMessageTitlePrompt(source: string): string {
  return queuedMessageTitlePrompt.replace(
    MESSAGE_PLACEHOLDER,
    () => JSON.stringify(source),
  );
}

/** The helper's answer as a display title, or undefined when unusable. */
export function normalizeQueuedMessageTitle(object: unknown): string | undefined {
  if (!object || typeof object !== "object" || Array.isArray(object)) {
    return undefined;
  }
  const raw = (object as { title?: unknown }).title;
  if (typeof raw !== "string") return undefined;
  const cleaned = cleanTitle(raw);
  if (!cleaned) return undefined;
  const words = cleaned.split(/\s+/u).slice(0, QUEUED_MESSAGE_TITLE_MAX_WORDS).join(" ");
  const characters = Array.from(words);
  if (characters.length <= QUEUED_MESSAGE_TITLE_MAX_CHARACTERS) return words;
  return cleanTitle(characters.slice(0, QUEUED_MESSAGE_TITLE_MAX_CHARACTERS).join(""))
    || undefined;
}

function cleanTitle(value: string): string {
  let title = value.replace(/\s+/gu, " ").trim();
  const quoted = /^(["'`“‘])(.*)(["'`”’])$/u.exec(title);
  if (quoted) title = quoted[2]!.trim();
  return title.replace(/[.,;:!?。！？]+$/u, "").trim();
}

export type QueuedMessageTitleRequest = {
  entryId: string;
  source: string;
};

export type QueuedMessageTitlerOptions = {
  generate: (params: {
    system: string;
    prompt: string;
    schema: Record<string, unknown>;
    schemaName: string;
    timeoutMs: number;
    turnTimeoutMs: number;
  }) => Promise<ThreadTitleAdapterResult>;
  /**
   * Applies a finished title. The owner checks the entry is still queued and
   * still holds `source`; an edit or a send in the meantime drops it.
   */
  apply: (request: QueuedMessageTitleRequest, title: string) => void;
  log?: (message: string, fields: Record<string, unknown>) => void;
};

/**
 * Runs title requests one at a time. A thread handed eleven messages at once
 * gets its titles in order instead of eleven helper turns racing; a request
 * for an entry already waiting replaces the older one, so an edit does not
 * pay for the text it replaced.
 */
export class QueuedMessageTitler {
  private readonly pending = new Map<string, QueuedMessageTitleRequest>();
  private running = false;

  constructor(private readonly options: QueuedMessageTitlerOptions) {}

  request(request: QueuedMessageTitleRequest): void {
    this.pending.delete(request.entryId);
    this.pending.set(request.entryId, request);
    if (!this.running) void this.drain();
  }

  /** Drops a request that has not started: the entry left the queue. */
  forget(entryId: string): void {
    this.pending.delete(entryId);
  }

  /** Resolves once every request queued so far has finished. Tests only. */
  async idle(): Promise<void> {
    while (this.running || this.pending.size > 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  private async drain(): Promise<void> {
    this.running = true;
    try {
      for (;;) {
        const next = this.pending.values().next();
        if (next.done) return;
        const request = next.value;
        this.pending.delete(request.entryId);
        const title = await this.generate(request);
        if (title) this.options.apply(request, title);
      }
    } finally {
      this.running = false;
    }
  }

  private async generate(request: QueuedMessageTitleRequest): Promise<string | undefined> {
    try {
      const result = await this.options.generate({
        system: QUEUED_MESSAGE_TITLE_SYSTEM_PROMPT,
        prompt: buildQueuedMessageTitlePrompt(request.source),
        schema: QUEUED_MESSAGE_TITLE_SCHEMA,
        schemaName: "queued_message_title",
        timeoutMs: QUEUED_MESSAGE_TITLE_TIMEOUT_MS,
        turnTimeoutMs: QUEUED_MESSAGE_TITLE_TURN_TIMEOUT_MS,
      });
      if (result.status !== "ok") {
        this.options.log?.("queued message title unavailable", {
          entryId: request.entryId,
          status: result.status,
          reason: result.reason,
        });
        return undefined;
      }
      const title = normalizeQueuedMessageTitle(result.object);
      if (!title) {
        this.options.log?.("queued message title rejected", { entryId: request.entryId });
      }
      return title;
    } catch (error) {
      this.options.log?.("queued message title failed", {
        entryId: request.entryId,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }
}
