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
  "parent_intent",
  "actionable_state",
  "script_status",
  "max_output_tokens",
  "content_items",
]);
const TOKEN_MISER_CODE_MODE_TEXT_ITEM_KEYS = new Set(["type", "text"]);
const TOKEN_MISER_ACTIONABLE_STATE_KEYS = new Set(["version", "entries"]);
const TOKEN_MISER_ACTIONABLE_STATE_ENTRY_KEYS = new Set([
  "session_id",
  "process_id",
  "chunk_id",
  "state",
  "exit_code",
  "required_follow_up",
]);
const TOKEN_MISER_REQUIRED_FOLLOW_UP_KEYS = new Set([
  "operation",
  "arguments",
]);
const TOKEN_MISER_WRITE_STDIN_ARGUMENT_KEYS = new Set([
  "session_id",
  "chars",
]);
const TOKEN_MISER_CODE_MODE_ACCEPTANCE_KEYS = new Set([
  "version",
  "response_id",
  "thread_id",
  "turn_id",
  "call_id",
  "cell_id",
]);
const TOKEN_MISER_POST_TOOL_USE_ACCEPTANCE_KEYS = new Set([
  "version",
  "response_id",
  "session_id",
  "turn_id",
  "tool_use_id",
]);

export type TokenMiserPostToolUsePayload = {
  session_id: string;
  turn_id: string;
  hook_event_name: "PostToolUse";
  tool_name: string;
  tool_use_id: string;
  /**
   * True for a result consumed inside Code Mode; false for a result that the
   * direct PostToolUse hook can replace. Older Codex builds omit this marker,
   * so its presence is the protocol opt-in that makes direct gating safe.
   */
  is_code_mode_nested: boolean;
  /** Present only when the fork will acknowledge a selected replacement. */
  token_miser_acceptance_version: 1;
  /** Advertises the opt-in exact-output field without changing tool_response. */
  token_miser_exact_tool_response_version?: 1;
  /** Full stable hook response used only by the capability-gated Token Miser hook. */
  token_miser_exact_tool_response?: unknown;
  /** Present on Codex builds that can join nested calls to an outer cell. */
  token_miser_grouping_version?: 1;
  /** Stable group key shared with the outer reducer request's `cell_id`. */
  code_mode_cell_id?: string;
  /** Runtime-local member identity within `code_mode_cell_id`. */
  code_mode_tool_call_id?: string;
  /** Most recent model-visible assistant narration before this call. */
  parent_intent?: string;
  tool_input?: unknown;
  tool_response: unknown;
};

export type TokenMiserSummary = {
  summary: string;
  usefulDetails: string[];
  /**
   * Legacy helper guidance retained for stored-object compatibility. New
   * summaries are deliberately factual and omit continuation guidance.
   */
  suggestedNextStep?: string;
};

export type TokenMiserGroupMemberSummary = {
  objectId: string;
  toolCallId: string;
  toolName: string;
  summary: string;
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
  /** Whether the parent received a summary or the ordinary original result. */
  disposition?: "summarized" | "passed_through";
  /** Code Mode cell identity for a grouped parallel reduction. */
  groupId?: string;
  groupMembers?: TokenMiserGroupMemberSummary[];
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
    /** Opaque fork acknowledgement id; ignored by unsupported Codex builds. */
    response_id?: string;
  };
};

export type TokenMiserCodeModeTextContentItem = {
  type: "input_text";
  text: string;
};

export type TokenMiserCodeModeActionableState = {
  version: 1;
  entries: Array<{
    session_id: number;
    process_id: number;
    chunk_id: string;
    state: "running" | "completed";
    exit_code: number | null;
    required_follow_up: {
      operation: "write_stdin";
      arguments: {
        session_id: number;
        chars: string;
      };
    } | null;
  }>;
};

export type TokenMiserCodeModeObservation = {
  version: 1;
  observationId: string;
  threadId: string;
  turnId: string;
  callId: string;
  cellId: string;
  createdAt: number;
  outputCharacters: number;
  outputPreview?: string;
  outputPreviewTruncated?: boolean;
  maxOutputTokens: number;
  scriptStatus: string;
  script?: string;
  retrieval: boolean;
  capturedNestedInvocationCount: number;
  capturedCommandInvocationCount?: number;
  capturedPollingInvocationCount?: number;
  capturedPatchInvocationCount?: number;
  capturedOtherInvocationCount?: number;
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
  /** Most recent model-visible assistant narration before this cell. */
  parent_intent?: string;
  /** Codex-owned continuation state that every response must echo exactly. */
  actionable_state?: TokenMiserCodeModeActionableState;
  script_status: string;
  max_output_tokens: number;
  content_items: TokenMiserCodeModeTextContentItem[];
};

export type TokenMiserCodeModeReductionOutput = {
  replacement: TokenMiserCodeModeTextContentItem[];
  response_id: string;
  actionable_state?: TokenMiserCodeModeActionableState;
} | {
  replacement: null;
};

/**
 * Codex sends this only after it has parsed and selected a replacement.
 * PwrAgent does not publish a gate or its savings before this acknowledgement.
 */
export type TokenMiserCodeModeAcceptancePayload = {
  version: 1;
  response_id: string;
  thread_id: string;
  turn_id: string;
  call_id: string;
  cell_id: string;
};

/**
 * The Codex fork sends this only after selecting the hook replacement as the
 * model-visible result. PwrAgent does not publish a direct-hook gate before
 * this acknowledgement.
 */
export type TokenMiserPostToolUseAcceptancePayload = {
  version: 1;
  response_id: string;
  session_id: string;
  turn_id: string;
  tool_use_id: string;
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
    && typeof record.is_code_mode_nested === "boolean"
    && record.token_miser_acceptance_version === 1
    && record.token_miser_exact_tool_response_version === 1
    && Object.prototype.hasOwnProperty.call(
      record,
      "token_miser_exact_tool_response",
    )
    && (
      record.token_miser_grouping_version === undefined
      || record.token_miser_grouping_version === 1
    )
    && (
      record.code_mode_cell_id === undefined
      || isNonEmptyString(record.code_mode_cell_id)
    )
    && (
      record.code_mode_tool_call_id === undefined
      || isNonEmptyString(record.code_mode_tool_call_id)
    )
    && (
      record.parent_intent === undefined
      || (
        typeof record.parent_intent === "string"
        && hasAtMostUnicodeScalars(record.parent_intent, 4_000)
      )
    )
    && (
      record.is_code_mode_nested === false
      || record.token_miser_grouping_version !== 1
      || (
        isNonEmptyString(record.code_mode_cell_id)
        && isNonEmptyString(record.code_mode_tool_call_id)
      )
    )
    && Object.prototype.hasOwnProperty.call(record, "tool_response")
  );
}

function isCodeModeActionableState(
  value: unknown,
): value is TokenMiserCodeModeActionableState {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return hasOnlyKeys(record, TOKEN_MISER_ACTIONABLE_STATE_KEYS)
    && record.version === 1
    && Array.isArray(record.entries)
    && record.entries.length > 0
    && record.entries.length <= 64
    && record.entries.every(isCodeModeActionableStateEntry);
}

function isCodeModeActionableStateEntry(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return hasOnlyKeys(record, TOKEN_MISER_ACTIONABLE_STATE_ENTRY_KEYS)
    && isInt32(record.session_id)
    && isInt32(record.process_id)
    && isNonEmptyString(record.chunk_id)
    && record.chunk_id.length <= 1_000
    && (record.state === "running" || record.state === "completed")
    && (record.exit_code === null || isInt32(record.exit_code))
    && (
      record.required_follow_up === null
      || isCodeModeRequiredFollowUp(record.required_follow_up)
    );
}

function isCodeModeRequiredFollowUp(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (
    !hasOnlyKeys(record, TOKEN_MISER_REQUIRED_FOLLOW_UP_KEYS)
    || record.operation !== "write_stdin"
    || !record.arguments
    || typeof record.arguments !== "object"
  ) {
    return false;
  }
  const args = record.arguments as Record<string, unknown>;
  return hasOnlyKeys(args, TOKEN_MISER_WRITE_STDIN_ARGUMENT_KEYS)
    && isInt32(args.session_id)
    && typeof args.chars === "string"
    && args.chars.length <= 10_000;
}

function isInt32(value: unknown): value is number {
  return Number.isInteger(value)
    && (value as number) >= -2_147_483_648
    && (value as number) <= 2_147_483_647;
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
    && (
      record.parent_intent === undefined
      || (
        typeof record.parent_intent === "string"
        && hasAtMostUnicodeScalars(record.parent_intent, 4_000)
      )
    )
    && (
      record.actionable_state === undefined
      || isCodeModeActionableState(record.actionable_state)
    )
    && isNonEmptyString(record.script_status)
    && Number.isSafeInteger(record.max_output_tokens)
    && (record.max_output_tokens as number) > 0
    && Array.isArray(record.content_items)
    && record.content_items.length > 0
    && record.content_items.every(isCodeModeTextContentItem)
  );
}

export function isTokenMiserCodeModeAcceptancePayload(
  value: unknown,
): value is TokenMiserCodeModeAcceptancePayload {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    hasOnlyKeys(record, TOKEN_MISER_CODE_MODE_ACCEPTANCE_KEYS)
    && record.version === 1
    && isNonEmptyString(record.response_id)
    && isNonEmptyString(record.thread_id)
    && isNonEmptyString(record.turn_id)
    && isNonEmptyString(record.call_id)
    && isNonEmptyString(record.cell_id)
  );
}

export function isTokenMiserPostToolUseAcceptancePayload(
  value: unknown,
): value is TokenMiserPostToolUseAcceptancePayload {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    hasOnlyKeys(record, TOKEN_MISER_POST_TOOL_USE_ACCEPTANCE_KEYS)
    && record.version === 1
    && isNonEmptyString(record.response_id)
    && isNonEmptyString(record.session_id)
    && isNonEmptyString(record.turn_id)
    && isNonEmptyString(record.tool_use_id)
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

function hasAtMostUnicodeScalars(value: string, maximum: number): boolean {
  let count = 0;
  for (const _character of value) {
    count += 1;
    if (count > maximum) {
      return false;
    }
  }
  return true;
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
