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
  model?: string;
  reasoningEffort?: string;
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
  summary: TokenMiserSummary;
  helperUsage?: TokenMiserHelperUsage;
};

export type TokenMiserHookOutput = {
  decision: "block";
  reason: string;
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
