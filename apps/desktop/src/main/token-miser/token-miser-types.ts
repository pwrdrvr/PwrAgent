export const TOKEN_MISER_DEFAULT_THRESHOLD_CHARACTERS = 5_000;
export const TOKEN_MISER_ESTIMATED_CHARACTERS_PER_TOKEN = 4;
export const TOKEN_MISER_MODEL_VISIBLE_CAP_TOKENS = 10_000;
export const TOKEN_MISER_CODE_MODE_MAX_RESPONSE_BYTES = 64 * 1024;
export const TOKEN_MISER_MODEL_VISIBLE_CAP_CHARACTERS =
  TOKEN_MISER_MODEL_VISIBLE_CAP_TOKENS
  * TOKEN_MISER_ESTIMATED_CHARACTERS_PER_TOKEN;
const TOKEN_MISER_CODE_MODE_PAYLOAD_KEYS = new Set([
  "version",
  "thread_id",
  "turn_id",
  "call_id",
  "cell_id",
  "script",
  "script_status",
  "max_output_tokens",
  "content_items",
]);
const TOKEN_MISER_CODE_MODE_TEXT_ITEM_KEYS = new Set(["type", "text"]);

export type TokenMiserPostToolUsePayload = {
  session_id: string;
  turn_id: string;
  hook_event_name: "PostToolUse";
  tool_name: string;
  tool_use_id: string;
  tool_input?: unknown;
  tool_response: unknown;
};

export type TokenMiserSummary = {
  summary: string;
  usefulDetails: string[];
  suggestedNextStep: string;
};

export type TokenMiserHelperUsage = {
  helperThreadId?: string;
  helperTurnId?: string;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  tokenUsage?: unknown;
};

export type TokenMiserObjectMetadata = {
  version: 1;
  objectId: string;
  threadId: string;
  turnId: string;
  toolUseId: string;
  toolName: string;
  createdAt: number;
  originalCharacters: number;
  baselineParentTokens: number;
  replacementCharacters: number;
  retrievedCharacters: number;
  /** Versioned opt-in so pre-replay-accounting objects are not tracked forever. */
  replayTrackingVersion?: 2;
  parentRequestsObservedAfterGate?: number;
  lastParentCumulativeInputTokens?: number;
  cachedReplayCount?: number;
  cachedBaselineTokens?: number;
  cachedRevealedTokens?: number;
  replayTrackingStoppedAt?: number;
  parentRequestEpoch?: string;
  summary: TokenMiserSummary;
  helperUsage?: TokenMiserHelperUsage;
  /**
   * The model whose context this gate protected, captured at creation.
   *
   * Pricing needs the parent's rate, and the usage line that normally carries
   * it can be absent: a native review runs on the parent thread with no usage
   * line of its own, and mid-turn the parent's line may not be priced yet.
   * Stamping the model here lets a gate price without one.
   */
  parentModel?: string;
  parentServiceTier?: string;
};

export type TokenMiserHookOutput = {
  continue: false;
  stopReason: string;
  hookSpecificOutput: {
    hookEventName: "PostToolUse";
    additionalContext?: string;
  };
};

export type TokenMiserCodeModeTextContentItem = {
  type: "input_text";
  text: string;
};

/**
 * Version 1 of the script-to-model reduction request emitted by the
 * PwrAgent Codex fork. Non-text content is deliberately outside this host
 * implementation: images, audio, and encrypted content must reach Codex's
 * fail-open path unchanged rather than being flattened or silently lost.
 */
export type TokenMiserCodeModeOutputPayload = {
  version: 1;
  thread_id: string;
  turn_id: string;
  call_id: string;
  cell_id: string;
  script?: string;
  script_status: string;
  max_output_tokens: number;
  content_items: TokenMiserCodeModeTextContentItem[];
};

export type TokenMiserCodeModeReductionOutput = {
  replacement: TokenMiserCodeModeTextContentItem[] | null;
};

export function estimateTokenCount(characters: number): number {
  return Math.ceil(
    Math.max(0, characters) / TOKEN_MISER_ESTIMATED_CHARACTERS_PER_TOKEN,
  );
}

export function serializeToolResponse(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined) {
    return "null";
  }
  try {
    return JSON.stringify(value, null, 2) ?? "null";
  } catch {
    return String(value);
  }
}

export function isTokenMiserPostToolUsePayload(
  value: unknown,
): value is TokenMiserPostToolUsePayload {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.hook_event_name === "PostToolUse"
    && typeof record.session_id === "string"
    && record.session_id.length > 0
    && typeof record.turn_id === "string"
    && record.turn_id.length > 0
    && typeof record.tool_name === "string"
    && record.tool_name.length > 0
    && typeof record.tool_use_id === "string"
    && record.tool_use_id.length > 0
    && Object.prototype.hasOwnProperty.call(record, "tool_response")
  );
}

export function isTokenMiserCodeModeOutputPayload(
  value: unknown,
): value is TokenMiserCodeModeOutputPayload {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    hasOnlyKeys(record, TOKEN_MISER_CODE_MODE_PAYLOAD_KEYS)
    && record.version === 1
    && isNonEmptyString(record.thread_id)
    && isNonEmptyString(record.turn_id)
    && isNonEmptyString(record.call_id)
    && isNonEmptyString(record.cell_id)
    && (record.script === undefined || typeof record.script === "string")
    && isNonEmptyString(record.script_status)
    && Number.isSafeInteger(record.max_output_tokens)
    && (record.max_output_tokens as number) > 0
    && Array.isArray(record.content_items)
    && record.content_items.length > 0
    && record.content_items.every(isCodeModeTextContentItem)
  );
}

function isCodeModeTextContentItem(
  value: unknown,
): value is TokenMiserCodeModeTextContentItem {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    hasOnlyKeys(record, TOKEN_MISER_CODE_MODE_TEXT_ITEM_KEYS)
    && record.type === "input_text"
    && typeof record.text === "string"
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function hasOnlyKeys(
  record: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
): boolean {
  return Object.keys(record).every((key) => allowedKeys.has(key));
}

/**
 * Last observed result of Codex-side activation, written next to the objects so
 * the Settings screen can read it without a live channel to the backend and it
 * survives a restart.
 */
export type TokenMiserActivationStatus = {
  state: "active" | "unavailable";
  reason?: string;
  observedAt: number;
};

export const TOKEN_MISER_ACTIVATION_FILENAME = "activation.json";
