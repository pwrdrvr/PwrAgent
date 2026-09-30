import type { AcpBackendId } from "@pwragent/shared";
import {
  AcpEphemeralPromptError,
  type AcpEphemeralPromptRequest,
  type AcpEphemeralPromptResult,
} from "../acp/acp-ephemeral-prompt";
import {
  buildMinimalGrokHelperSessionPolicy,
  GROK_DISCARD_SESSION_METHOD,
} from "../acp/minimal-helper-session";
import { parseAcpJsonAnswer } from "./acp-json-answer";
import type { ThreadTitleAdapterResult } from "./thread-title-generation-service";

type AcpStructuredHelper = {
  label: string;
  /** `_meta` for a session with no tools, given its system prompt. */
  sessionMeta: (systemPrompt: string) => Record<string, unknown>;
  discardMethods: readonly string[];
};

/**
 * ACP agents that can answer a structured request with no tools. An agent is
 * listed only once a capture has shown its profile really removes every tool;
 * denying permission requests is not enough (see minimal-helper-session.ts).
 */
const ACP_STRUCTURED_HELPERS: Partial<Record<AcpBackendId, AcpStructuredHelper>> = {
  "acp:grok": {
    label: "Grok",
    sessionMeta: (systemPrompt) => buildMinimalGrokHelperSessionPolicy({
      description: "Answer one structured request from the supplied text.",
      name: "pwragent-structured-helper",
      systemPrompt,
    }).sessionMeta,
    discardMethods: [GROK_DISCARD_SESSION_METHOD],
  },
};

export function hasAcpStructuredHelper(backend: string): backend is AcpBackendId {
  return Object.hasOwn(ACP_STRUCTURED_HELPERS, backend);
}

/** Answer characters an ACP structured helper may return. */
const DEFAULT_MAX_OUTPUT_CHARS = 32_000;

/**
 * One structured answer from an ACP agent, in a session that has no tools and
 * that the agent forgets afterwards. ACP has no output schema, so the schema
 * is stated in both the system prompt and the prompt, and the answer is parsed
 * and checked against it here. `turnTimeoutMs` bounds the whole run, agent
 * start included.
 */
export async function generateAcpStructuredObject(params: {
  backend: AcpBackendId;
  /** A directory the operator does not work in. */
  cwd: string;
  run: (request: AcpEphemeralPromptRequest) => Promise<AcpEphemeralPromptResult>;
  model?: string;
  reasoningEffort?: string;
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
  isMatch?: (value: Record<string, unknown>) => boolean;
  turnTimeoutMs: number;
  maxOutputChars?: number;
}): Promise<ThreadTitleAdapterResult> {
  const helper = ACP_STRUCTURED_HELPERS[params.backend];
  if (!helper) {
    return {
      status: "unavailable",
      reason: `${params.backend}_structured_generation_unavailable`,
    };
  }
  const contract = "Reply with only one JSON object that matches this JSON Schema, "
    + `with no other text and no code fence:\n${JSON.stringify(params.schema)}`;
  const maxOutputChars = params.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  let result: AcpEphemeralPromptResult;
  try {
    result = await params.run({
      cwd: params.cwd,
      prompt: `${params.prompt}\n\n${contract}`,
      sessionMeta: helper.sessionMeta(`${params.system}\nYou have no tools.\n${contract}`),
      ...(params.model ? { model: params.model } : {}),
      ...(params.reasoningEffort ? { reasoningEffort: params.reasoningEffort } : {}),
      timeoutMs: params.turnTimeoutMs,
      maxOutputChars,
      discardMethods: helper.discardMethods,
    });
  } catch (error) {
    return { status: "failed", reason: failureReason(helper.label, error, params.turnTimeoutMs, maxOutputChars) };
  }
  const object = parseAcpJsonAnswer(result.text);
  if (
    !isRecord(object)
    || !matchesSchema(params.schema, object)
    || params.isMatch?.(object) === false
  ) {
    return { status: "failed", reason: `${helper.label} did not answer with the requested JSON.` };
  }
  const model = result.model ?? params.model;
  return {
    status: "ok",
    object,
    ...(model ? { model } : {}),
    ...(params.reasoningEffort ? { reasoningEffort: params.reasoningEffort } : {}),
  };
}

function failureReason(label: string, error: unknown, timeoutMs: number, maxOutputChars: number): string {
  if (!(error instanceof AcpEphemeralPromptError)) {
    return `${label} is unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
  switch (error.failure) {
    case "timeout":
      return `${label} did not answer within ${Math.ceil(timeoutMs / 1_000)} s.`;
    case "output_limit":
      return `${label}'s answer passed ${maxOutputChars.toLocaleString("en-US")} characters.`;
    case "model_unavailable":
    case "stopped":
      return `${label}: ${error.message}`;
    case "protocol":
      return `${label} could not run the request: ${error.message}`;
  }
}

/**
 * The subset of JSON Schema that structured requests here use: types,
 * `required`, `properties`, `items` and `additionalProperties: false`.
 */
function matchesSchema(schema: Record<string, unknown>, value: unknown): boolean {
  switch (schema.type) {
    case "object": {
      if (!isRecord(value)) return false;
      const properties = isRecord(schema.properties) ? schema.properties : {};
      const required = Array.isArray(schema.required) ? schema.required : [];
      if (required.some((key) => typeof key === "string" && !(key in value))) return false;
      if (schema.additionalProperties === false && Object.keys(value).some((key) => !(key in properties))) return false;
      return Object.entries(properties).every(([key, property]) =>
        !(key in value) || !isRecord(property) || matchesSchema(property, value[key]));
    }
    case "array":
      return Array.isArray(value)
        && (!isRecord(schema.items) || value.every((item) => matchesSchema(schema.items as Record<string, unknown>, item)));
    case "string":
      return typeof value === "string";
    case "integer":
      return Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    default:
      return true;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
