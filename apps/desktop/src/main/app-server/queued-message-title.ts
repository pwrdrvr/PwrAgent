import type {
  AppServerBackendKind,
  AppServerThreadMessageOrigin,
  AppServerTurnInputItem,
} from "@pwragent/shared";
import queuedMessageTitlePrompt from "./queued-message-title-prompt.md?raw";
import type { ThreadTitleAdapterResult } from "./thread-title-generation-service";

/**
 * Short titles for queued messages.
 *
 * A queued message shows as one line above the composer. A message that fits
 * on that line is its own title; a long one — a child thread's progress
 * report, a pasted plan — needs a few words that tell it apart from the rest
 * of the queue. A helper turn writes those words once the message has sat in
 * a busy thread's queue for a moment. The title is display-only and lives on
 * the queue entry in memory, like the queue itself. The owner records each finished
 * run (its cost and what it wrote) through `settle`; nothing in this module
 * touches sqlite.
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
/**
 * How long a message waits in the queue before it is titled. A cross-thread
 * message to a busy thread is admitted as queued and then steered into the
 * running turn one event-loop turn later, so titling on admission paid for a
 * label nobody could see: 150 of 159 runs on one thread landed nothing. A
 * message that is still waiting after this long is worth naming.
 */
export const QUEUED_MESSAGE_TITLE_SETTLE_MS = 3_000;
/** Each name in the context, so a pasted title cannot crowd out the message. */
const QUEUED_MESSAGE_TITLE_CONTEXT_NAME_LIMIT = 80;
/** Senders named in the context; a bigger batch ends with "and N more". */
const QUEUED_MESSAGE_TITLE_CONTEXT_SENDER_LIMIT = 5;
const PLACEHOLDER_PATTERN = /\{\{(MESSAGE|CONTEXT)\}\}/gu;

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

/**
 * Who sent a queued message and which thread it waits for. It travels beside
 * the capped source, not inside it, so a long message cannot cut it off.
 */
export type QueuedMessageTitleContext = {
  from?: string[];
  to?: string;
};

/**
 * The context for a queue entry, or undefined when nothing is known. A
 * sender with no title of its own is looked up in the local thread cache.
 */
export function queuedMessageTitleContext(params: {
  origins: readonly (AppServerThreadMessageOrigin | undefined)[];
  recipientTitle?: string;
  lookupTitle: (identity: { backend: AppServerBackendKind; threadId: string }) => string | undefined;
}): QueuedMessageTitleContext | undefined {
  const senders: string[] = [];
  for (const origin of params.origins) {
    const sender = origin ? senderName(origin, params.lookupTitle) : undefined;
    if (sender && !senders.includes(sender)) senders.push(sender);
  }
  const from = senders.length > QUEUED_MESSAGE_TITLE_CONTEXT_SENDER_LIMIT
    ? [
        ...senders.slice(0, QUEUED_MESSAGE_TITLE_CONTEXT_SENDER_LIMIT - 1),
        `and ${senders.length - QUEUED_MESSAGE_TITLE_CONTEXT_SENDER_LIMIT + 1} more`,
      ]
    : senders;
  const to = contextName(params.recipientTitle);
  if (from.length === 0 && !to) return undefined;
  return {
    ...(from.length > 0 ? { from } : {}),
    ...(to ? { to } : {}),
  };
}

function senderName(
  origin: AppServerThreadMessageOrigin,
  lookupTitle: (identity: { backend: AppServerBackendKind; threadId: string }) => string | undefined,
): string | undefined {
  const thread = origin.sourceThread;
  if (thread) {
    // A remote sender's id means nothing to the local cache.
    const title = contextName(thread.title)
      ?? (thread.instanceId ? undefined : contextName(lookupTitle(thread)));
    if (!title) return undefined;
    const instance = thread.instanceId
      ? contextName(thread.instanceLabel ?? thread.instanceId)
      : undefined;
    return contextName(instance ? `${title} on ${instance}` : title);
  }
  const messaging = origin.messaging;
  if (messaging) {
    const actor = contextName(messaging.actor.displayName ?? messaging.actor.username);
    return actor ? contextName(`${actor} via ${messaging.platform}`) : undefined;
  }
  const subAgent = origin.subAgent;
  if (subAgent) return contextName(`Sub-agent: ${subAgent.task}`);
  return undefined;
}

function contextName(value: string | undefined): string | undefined {
  const name = value?.replace(/\s+/gu, " ").trim();
  if (!name) return undefined;
  const characters = Array.from(name);
  if (characters.length <= QUEUED_MESSAGE_TITLE_CONTEXT_NAME_LIMIT) return name;
  return `${characters.slice(0, QUEUED_MESSAGE_TITLE_CONTEXT_NAME_LIMIT - 1).join("").trimEnd()}…`;
}

export function buildQueuedMessageTitlePrompt(
  source: string,
  context?: QueuedMessageTitleContext,
): string {
  // One pass, so text in the message cannot land in the context's slot.
  return queuedMessageTitlePrompt.replace(
    PLACEHOLDER_PATTERN,
    (_match, name: string) =>
      name === "MESSAGE" ? JSON.stringify(source) : JSON.stringify(context ?? {}),
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
  /** The thread whose queue holds the entry, which the run is charged to. */
  backend: AppServerBackendKind;
  threadId: string;
  source: string;
  context?: QueuedMessageTitleContext;
};

/** What one helper run produced, for the owner's record of it. */
export type QueuedMessageTitleSettlement = {
  startedAt: number;
  /** The helper's answer; a request that threw reads as `failed`. */
  result: ThreadTitleAdapterResult;
  /** Set when the answer normalized to a usable title. */
  title?: string;
  /** Whether `apply` landed `title` on its entry. */
  applied: boolean;
};

export type QueuedMessageTitlerOptions = {
  generate: (params: {
    system: string;
    prompt: string;
    schema: Record<string, unknown>;
    schemaName: string;
    /** Always true: labelling text needs no shell, exec, or sub-agents. */
    disableExecution: true;
    timeoutMs: number;
    turnTimeoutMs: number;
  }) => Promise<ThreadTitleAdapterResult>;
  /**
   * Whether the entry is still queued and still holds `source`, checked just
   * before a run starts. A request that has gone stale is dropped unrun.
   */
  isCurrent?: (request: QueuedMessageTitleRequest) => boolean;
  /** How long a request waits before it runs. Defaults to the settle window. */
  settleMs?: number;
  /**
   * Applies a finished title and says whether it landed. The owner checks the
   * entry is still queued and still holds `source`; an edit or a send in the
   * meantime drops it.
   */
  apply: (request: QueuedMessageTitleRequest, title: string) => boolean;
  /**
   * Records a finished run, landed or not. Awaited before the next request
   * starts, so `idle` also covers the record.
   */
  settle?: (
    request: QueuedMessageTitleRequest,
    settlement: QueuedMessageTitleSettlement,
  ) => Promise<void> | void;
  log?: (message: string, fields: Record<string, unknown>) => void;
};

/**
 * Runs title requests one at a time. A thread handed eleven messages at once
 * gets its titles in order instead of eleven helper turns racing; a request
 * for an entry already waiting replaces the older one and restarts its
 * settle window, so an edit or a growing batch pays for one title, not one
 * per version of the text.
 */
export class QueuedMessageTitler {
  private readonly pending = new Map<
    string,
    { request: QueuedMessageTitleRequest; readyAt: number }
  >();
  private readonly settleMs: number;
  private running = false;
  private closed = false;
  private wake: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: QueuedMessageTitlerOptions) {
    this.settleMs = Math.max(0, options.settleMs ?? QUEUED_MESSAGE_TITLE_SETTLE_MS);
  }

  request(request: QueuedMessageTitleRequest): void {
    if (this.closed) return;
    this.pending.delete(request.entryId);
    this.pending.set(request.entryId, { request, readyAt: Date.now() + this.settleMs });
    this.kick();
  }

  /** Drops a request that has not started: the entry left the queue. */
  forget(entryId: string): void {
    this.pending.delete(entryId);
    if (this.pending.size === 0) this.clearWake();
  }

  /** Drops every waiting request. A run already out finishes on its own. */
  close(): void {
    this.closed = true;
    this.pending.clear();
    this.clearWake();
  }

  /** Resolves once every request queued so far has finished. Tests only. */
  async idle(): Promise<void> {
    while (this.running || this.pending.size > 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  private kick(): void {
    if (this.running) return;
    if (this.hasReadyRequest()) {
      this.clearWake();
      void this.drain();
      return;
    }
    this.scheduleWake();
  }

  private hasReadyRequest(): boolean {
    const now = Date.now();
    for (const { readyAt } of this.pending.values()) {
      if (readyAt <= now) return true;
    }
    return false;
  }

  /** The first ready request in arrival order, taken off the list. */
  private takeReadyRequest(): QueuedMessageTitleRequest | undefined {
    const now = Date.now();
    for (const [entryId, { request, readyAt }] of this.pending) {
      if (readyAt > now) continue;
      this.pending.delete(entryId);
      return request;
    }
    return undefined;
  }

  private scheduleWake(): void {
    this.clearWake();
    if (this.closed || this.pending.size === 0) return;
    let earliest = Number.POSITIVE_INFINITY;
    for (const { readyAt } of this.pending.values()) earliest = Math.min(earliest, readyAt);
    this.wake = setTimeout(() => {
      this.wake = undefined;
      this.kick();
    }, Math.max(0, earliest - Date.now()));
    this.wake.unref?.();
  }

  private clearWake(): void {
    if (this.wake === undefined) return;
    clearTimeout(this.wake);
    this.wake = undefined;
  }

  private async drain(): Promise<void> {
    this.running = true;
    try {
      for (;;) {
        const request = this.takeReadyRequest();
        if (!request) return;
        if (this.options.isCurrent && !this.options.isCurrent(request)) {
          this.options.log?.("queued message title skipped", { entryId: request.entryId });
          continue;
        }
        const startedAt = Date.now();
        const { result, title } = await this.generate(request);
        const applied = title !== undefined && this.options.apply(request, title);
        await this.settle(request, {
          startedAt,
          result,
          ...(title !== undefined ? { title } : {}),
          applied,
        });
      }
    } finally {
      this.running = false;
      this.scheduleWake();
    }
  }

  private async settle(
    request: QueuedMessageTitleRequest,
    settlement: QueuedMessageTitleSettlement,
  ): Promise<void> {
    try {
      await this.options.settle?.(request, settlement);
    } catch (error) {
      this.options.log?.("queued message title record failed", {
        entryId: request.entryId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async generate(
    request: QueuedMessageTitleRequest,
  ): Promise<{ result: ThreadTitleAdapterResult; title?: string }> {
    try {
      const result = await this.options.generate({
        system: QUEUED_MESSAGE_TITLE_SYSTEM_PROMPT,
        prompt: buildQueuedMessageTitlePrompt(request.source, request.context),
        schema: QUEUED_MESSAGE_TITLE_SCHEMA,
        schemaName: "queued_message_title",
        disableExecution: true,
        timeoutMs: QUEUED_MESSAGE_TITLE_TIMEOUT_MS,
        turnTimeoutMs: QUEUED_MESSAGE_TITLE_TURN_TIMEOUT_MS,
      });
      if (result.status !== "ok") {
        this.options.log?.("queued message title unavailable", {
          entryId: request.entryId,
          status: result.status,
          reason: result.reason,
        });
        return { result };
      }
      const title = normalizeQueuedMessageTitle(result.object);
      if (!title) {
        this.options.log?.("queued message title rejected", { entryId: request.entryId });
        return { result };
      }
      return { result, title };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.options.log?.("queued message title failed", {
        entryId: request.entryId,
        error: reason,
      });
      return { result: { status: "failed", reason } };
    }
  }
}
