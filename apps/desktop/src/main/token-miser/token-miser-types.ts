export const TOKEN_MISER_DEFAULT_THRESHOLD_CHARACTERS = 5_000;
export const TOKEN_MISER_MODEL_VISIBLE_CAP_CHARACTERS = 40_000;
export const TOKEN_MISER_ESTIMATED_CHARACTERS_PER_TOKEN = 4;

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
    additionalContext: string;
  };
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
