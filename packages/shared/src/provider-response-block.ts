import type {
  AppServerThreadActivityEntry,
  AppServerThreadTurnMetadata,
  ProviderResponseBlock,
} from "./contracts/normalized-app-server";

/**
 * The Responses API ends a filtered response with `response.incomplete` and
 * `incomplete_details.reason: "content_filter"`. Codex's display text for that
 * terminal event, which it puts in
 * `TurnError.additionalDetails` on a retry and in `TurnError.message` when the
 * turn fails: "stream disconnected before completion: Incomplete response
 * returned, reason: content_filter". Codex 0.163 sends no dedicated
 * `codexErrorInfo` for it (`responseStreamDisconnected` on a retry, `other` on
 * failure), so this text is the only protocol field that names the block.
 */
const CONTENT_FILTER_REASON = /\breason:\s*content_filter\b/i;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isContentFilterErrorInfo(value: unknown): boolean {
  if (value === "contentFilter") return true;
  const record = asRecord(value);
  return record !== undefined && "contentFilter" in record;
}

/**
 * Reads a Codex App Server `TurnError` (from an `error` notification or a
 * failed turn) and reports whether the provider blocked the response.
 *
 * A dedicated `codexErrorInfo: "contentFilter"` is honored first so the rule
 * keeps working when Codex stops spelling the reason out in text.
 */
export function detectProviderResponseBlock(error: unknown): ProviderResponseBlock | undefined {
  const record = asRecord(error);
  if (!record) return undefined;
  if (record.block === "contentFilter") return "contentFilter";
  if (isContentFilterErrorInfo(record.codexErrorInfo)) return "contentFilter";
  for (const key of ["message", "additionalDetails"] as const) {
    const text = record[key];
    if (typeof text === "string" && CONTENT_FILTER_REASON.test(text)) {
      return "contentFilter";
    }
  }
  return undefined;
}

/**
 * One sentence that names the block. `turnEnded` distinguishes a block Codex
 * recovered from (it retries with guidance to offer a permitted alternative)
 * from one that ended the turn.
 */
export function describeProviderResponseBlock(params: {
  block: ProviderResponseBlock;
  turnEnded: boolean;
}): string {
  return params.turnEnded
    ? "The model provider's content filter blocked the response, and the turn ended."
    : "The model provider's content filter blocked a response. The agent was asked to offer a permitted alternative instead.";
}

const BLOCK_ENTRY_ID_PREFIX = "response-block-";

/**
 * The transcript entry for a blocked response. There is one per turn: a block
 * that later ends the turn replaces the retry's entry, and the live entry and
 * the same turn's replay entry share the id, so they merge instead of
 * rendering twice. Pass the provider's `turnId` when it is known; the
 * client's own turn id can differ from the one replay reports.
 */
export function buildProviderResponseBlockEntry(params: {
  block: ProviderResponseBlock;
  turnEnded: boolean;
  turn?: AppServerThreadTurnMetadata;
  turnId?: string;
  createdAt?: number;
}): AppServerThreadActivityEntry | undefined {
  const turnId = params.turnId ?? params.turn?.id;
  if (!turnId) return undefined;
  return {
    type: "activity",
    id: `${BLOCK_ENTRY_ID_PREFIX}${turnId}`,
    summary: `Blocked by content filter: ${describeProviderResponseBlock(params)}`,
    tone: "warning",
    details: [],
    ...(params.createdAt !== undefined ? { createdAt: params.createdAt } : {}),
    ...(params.turn ? { turn: params.turn } : {}),
  };
}

/**
 * Whether an entry is a blocked-response entry. thread/read never carries a
 * block Codex recovered from, so a live one must not be settled by a replay
 * that merely moved past its turn.
 */
export function isProviderResponseBlockEntry(entry: { type: string; id: string }): boolean {
  return entry.type === "activity" && entry.id.startsWith(BLOCK_ENTRY_ID_PREFIX);
}

/**
 * The block, if any, that a normalized live notification reports, and whether
 * the turn ended because of it. Callers run this on every agent event, so it
 * rejects other methods before reading anything.
 */
export function readProviderResponseBlockNotification(notification: {
  method: string;
  params: Record<string, unknown>;
}): { block: ProviderResponseBlock; turnEnded: boolean; turnId?: string } | undefined {
  const { method, params } = notification;
  if (method !== "error" && method !== "turn/failed") return undefined;
  const turn = asRecord(params.turn);
  const turnId = typeof params.turnId === "string"
    ? params.turnId
    : typeof turn?.id === "string" ? turn.id : undefined;
  if (method === "error") {
    const block = detectProviderResponseBlock(params.error);
    return block
      ? { block, turnEnded: params.willRetry !== true, ...(turnId ? { turnId } : {}) }
      : undefined;
  }
  const block = detectProviderResponseBlock(turn?.error);
  return block ? { block, turnEnded: true, ...(turnId ? { turnId } : {}) } : undefined;
}
