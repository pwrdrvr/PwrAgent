/**
 * Registered OpenAI Decisions: the pure half of the PwrAgent contract in
 * docs/design/openai-decisions-registered-prompts.md (PR #3705).
 *
 * OpenAI exposes one method, `POST /v1/decisions`. Registration, versions,
 * update and delete are PwrAgent's own: the host stores a definition and
 * replays its questions on each invoke. Nothing in this module performs I/O.
 *
 * This is not the TypeSafe System One path (`decision-models.ts`). Clef and
 * Jev keep their own request shape, and neither is a fallback for the other.
 */

export const OPENAI_DECISIONS_ORIGIN = "https://api.openai.com";
export const OPENAI_DECISIONS_ENDPOINT = `${OPENAI_DECISIONS_ORIGIN}/v1/decisions`;
/** The guide and the create reference list this as the only supported model. */
export const OPENAI_DECISIONS_MODEL = "gpt-6-luna";
/** Usage-ledger provider and source. Never `openai`: that is the Codex family. */
export const OPENAI_DECISIONS_PROVIDER = "openai_decisions";
/** The only TTL the create reference accepts on this endpoint. */
export const OPENAI_DECISIONS_CACHE_TTL = "30m";

export const OPENAI_DECISIONS_TOOL_NAMES = [
  "decisions_register",
  "decisions_list",
  "decisions_invoke",
  "decisions_update",
  "decisions_delete",
] as const;

export type OpenAIDecisionsToolName = (typeof OPENAI_DECISIONS_TOOL_NAMES)[number];

/**
 * Product bounds. They are tighter than the API so a tool call stays small;
 * none of them is an OpenAI limit.
 */
export const OPENAI_DECISION_BOUNDS = {
  nameMaxLength: 64,
  questionsMin: 1,
  questionsMax: 16,
  questionNameMaxLength: 80,
  instructionsMaxLength: 8_000,
  choicesMin: 2,
  choicesMax: 32,
  choiceValueMaxLength: 200,
  descriptionMaxLength: 1_000,
  levelsMin: 2,
  levelsMax: 10,
  levelLabelMaxLength: 80,
  inputSchemaMaxBytes: 8 * 1024,
  inputSchemaMaxDepth: 8,
  prefixMaxLength: 32_000,
  /** The API's own `input_json` limits, enforced before any request. */
  inputJsonMaxBytes: 256 * 1024,
  inputJsonMaxDepth: 32,
  inputJsonMaxValues: 10_000,
} as const;

export const OPENAI_DECISION_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export type OpenAIDecisionScope = "profile" | "thread";

export type OpenAIDecisionChoice = { value: string; description?: string };
export type OpenAIDecisionLevel = { label: string; description?: string };

/** One question in the canonical OpenAI `questions` shape. */
export type OpenAIDecisionQuestion =
  | { type: "predicate"; instructions: string; name?: string }
  | {
      type: "choice";
      instructions: string;
      name?: string;
      choices: OpenAIDecisionChoice[];
    }
  | {
      type: "score";
      instructions: string;
      name?: string;
      levels: OpenAIDecisionLevel[];
    };

/** The JSON Schema subset a registered decision may declare for its input. */
export type OpenAIDecisionInputSchema = Record<string, unknown>;

export type OpenAIDecisionDefinition = {
  questions: OpenAIDecisionQuestion[];
  inputSchema: OpenAIDecisionInputSchema;
  prefix?: string;
};

export type OpenAIDecisionRegistration = OpenAIDecisionDefinition & {
  name: string;
  scope: OpenAIDecisionScope;
};

export type OpenAIDecisionValidation<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };

/**
 * Property names that would carry a credential. A definition or invoke input
 * that contains one anywhere is refused, so a key never reaches a stored row,
 * a prompt, or an OpenAI request through the tool's own arguments.
 */
const CREDENTIAL_PROPERTY_NAMES = new Set([
  "apikey",
  "api_key",
  "authorization",
  "openaidecisionsapikey",
]);

export function findCredentialProperty(value: unknown, depth = 0): string | undefined {
  if (depth > 64 || value === null || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findCredentialProperty(item, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  for (const [key, child] of Object.entries(value)) {
    if (CREDENTIAL_PROPERTY_NAMES.has(key.toLowerCase())) return key;
    const found = findCredentialProperty(child, depth + 1);
    if (found) return found;
  }
  return undefined;
}

const REGISTRATION_KEYS = new Set([
  "name",
  "scope",
  "instructions",
  "question",
  "questions",
  "inputSchema",
  "prefix",
]);

/**
 * Validates `decisions_register` / `decisions_update` arguments and compiles
 * them into canonical questions. The shortcut `question` takes its
 * instructions from the top-level `instructions`; each item of `questions`
 * may carry its own and otherwise uses the top-level value.
 */
export function parseOpenAIDecisionRegistration(
  args: Record<string, unknown>,
  options: { extraKeys?: readonly string[] } = {},
): OpenAIDecisionValidation<OpenAIDecisionRegistration> {
  const credential = findCredentialProperty(args);
  if (credential) {
    return {
      ok: false,
      message: `Property "${credential}" is not allowed. The host attaches the OpenAI key itself.`,
    };
  }
  const allowed = new Set([...REGISTRATION_KEYS, ...(options.extraKeys ?? [])]);
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) return { ok: false, message: `Unknown property "${key}".` };
  }
  if (typeof args.name !== "string" || !OPENAI_DECISION_NAME_PATTERN.test(args.name)) {
    return {
      ok: false,
      message: "name must match ^[a-z][a-z0-9_]{0,63}$.",
    };
  }
  const scope = args.scope ?? "profile";
  if (scope !== "profile" && scope !== "thread") {
    return { ok: false, message: "scope must be profile or thread." };
  }
  if (args.instructions !== undefined && typeof args.instructions !== "string") {
    return {
      ok: false,
      message: "instructions must be a string. Image and JSON instruction parts are not supported.",
    };
  }
  const sharedInstructions = args.instructions as string | undefined;
  if (args.question !== undefined && args.questions !== undefined) {
    return { ok: false, message: "Pass question or questions, not both." };
  }
  const rawQuestions = args.questions !== undefined
    ? args.questions
    : args.question !== undefined
      ? [args.question]
      : undefined;
  if (!Array.isArray(rawQuestions)) {
    return { ok: false, message: "question or questions is required." };
  }
  if (
    rawQuestions.length < OPENAI_DECISION_BOUNDS.questionsMin
    || rawQuestions.length > OPENAI_DECISION_BOUNDS.questionsMax
  ) {
    return {
      ok: false,
      message: `questions must have ${OPENAI_DECISION_BOUNDS.questionsMin} to ${OPENAI_DECISION_BOUNDS.questionsMax} items.`,
    };
  }
  const questions: OpenAIDecisionQuestion[] = [];
  const questionNames = new Set<string>();
  for (const [index, raw] of rawQuestions.entries()) {
    const parsed = parseQuestion(raw, sharedInstructions, `questions[${index}]`);
    if (!parsed.ok) return parsed;
    if (parsed.value.name !== undefined) {
      if (questionNames.has(parsed.value.name)) {
        return { ok: false, message: `Question name "${parsed.value.name}" is repeated.` };
      }
      questionNames.add(parsed.value.name);
    }
    questions.push(parsed.value);
  }
  const schema = parseOpenAIDecisionInputSchema(args.inputSchema);
  if (!schema.ok) return schema;
  let prefix: string | undefined;
  if (args.prefix !== undefined) {
    if (typeof args.prefix !== "string") {
      return { ok: false, message: "prefix must be a string. Images are not supported." };
    }
    if (args.prefix.length > OPENAI_DECISION_BOUNDS.prefixMaxLength) {
      return {
        ok: false,
        message: `prefix must be at most ${OPENAI_DECISION_BOUNDS.prefixMaxLength} characters.`,
      };
    }
    prefix = args.prefix.length > 0 ? args.prefix : undefined;
  }
  if (looksLikeCredentialText(JSON.stringify(questions)) || (prefix && looksLikeCredentialText(prefix))) {
    return {
      ok: false,
      message: "The definition contains text that looks like an API key or bearer token.",
    };
  }
  return {
    ok: true,
    value: {
      name: args.name,
      scope,
      questions,
      inputSchema: schema.value,
      ...(prefix !== undefined ? { prefix } : {}),
    },
  };
}

/** An OpenAI-style secret key or a bearer header value. */
export function looksLikeCredentialText(text: string): boolean {
  return /\bsk-[A-Za-z0-9_-]{16,}/.test(text) || /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i.test(text);
}

function parseQuestion(
  raw: unknown,
  sharedInstructions: string | undefined,
  path: string,
): OpenAIDecisionValidation<OpenAIDecisionQuestion> {
  if (!isPlainObject(raw)) return { ok: false, message: `${path} must be an object.` };
  const type = raw.type;
  const allowedKeys = type === "choice"
    ? ["type", "name", "instructions", "choices"]
    : type === "score"
      ? ["type", "name", "instructions", "levels"]
      : ["type", "name", "instructions"];
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.includes(key)) {
      return { ok: false, message: `${path}.${key} is not allowed for a ${String(type)} question.` };
    }
  }
  if (type !== "predicate" && type !== "choice" && type !== "score") {
    return { ok: false, message: `${path}.type must be predicate, choice or score.` };
  }
  const instructions = raw.instructions === undefined ? sharedInstructions : raw.instructions;
  if (typeof instructions !== "string") {
    return {
      ok: false,
      message: `${path} needs string instructions. Image and JSON instruction parts are not supported.`,
    };
  }
  if (
    instructions.trim().length === 0
    || instructions.length > OPENAI_DECISION_BOUNDS.instructionsMaxLength
  ) {
    return {
      ok: false,
      message: `${path} instructions must be 1 to ${OPENAI_DECISION_BOUNDS.instructionsMaxLength} characters.`,
    };
  }
  let name: string | undefined;
  if (raw.name !== undefined) {
    if (
      typeof raw.name !== "string"
      || raw.name.length === 0
      || raw.name.length > OPENAI_DECISION_BOUNDS.questionNameMaxLength
    ) {
      return {
        ok: false,
        message: `${path}.name must be 1 to ${OPENAI_DECISION_BOUNDS.questionNameMaxLength} characters.`,
      };
    }
    name = raw.name;
  }
  const base = { instructions, ...(name !== undefined ? { name } : {}) };
  if (type === "predicate") return { ok: true, value: { type, ...base } };
  if (type === "choice") {
    const choices = raw.choices;
    if (
      !Array.isArray(choices)
      || choices.length < OPENAI_DECISION_BOUNDS.choicesMin
      || choices.length > OPENAI_DECISION_BOUNDS.choicesMax
    ) {
      return {
        ok: false,
        message: `${path}.choices must have ${OPENAI_DECISION_BOUNDS.choicesMin} to ${OPENAI_DECISION_BOUNDS.choicesMax} items.`,
      };
    }
    const seen = new Set<string>();
    const parsed: OpenAIDecisionChoice[] = [];
    for (const [index, choice] of choices.entries()) {
      const choicePath = `${path}.choices[${index}]`;
      if (!isPlainObject(choice)) return { ok: false, message: `${choicePath} must be an object.` };
      for (const key of Object.keys(choice)) {
        if (key !== "value" && key !== "description") {
          return { ok: false, message: `${choicePath}.${key} is not allowed.` };
        }
      }
      if (typeof choice.value !== "string") {
        return {
          ok: false,
          message: `${choicePath}.value must be a string. Boolean values are not supported.`,
        };
      }
      if (choice.value.length === 0 || choice.value.length > OPENAI_DECISION_BOUNDS.choiceValueMaxLength) {
        return {
          ok: false,
          message: `${choicePath}.value must be 1 to ${OPENAI_DECISION_BOUNDS.choiceValueMaxLength} characters.`,
        };
      }
      if (seen.has(choice.value)) {
        return { ok: false, message: `${path}.choices repeats "${choice.value}".` };
      }
      seen.add(choice.value);
      const description = parseDescription(choice.description, choicePath);
      if (!description.ok) return description;
      parsed.push({
        value: choice.value,
        ...(description.value !== undefined ? { description: description.value } : {}),
      });
    }
    return { ok: true, value: { type, ...base, choices: parsed } };
  }
  const levels = raw.levels;
  if (
    !Array.isArray(levels)
    || levels.length < OPENAI_DECISION_BOUNDS.levelsMin
    || levels.length > OPENAI_DECISION_BOUNDS.levelsMax
  ) {
    return {
      ok: false,
      message: `${path}.levels must have ${OPENAI_DECISION_BOUNDS.levelsMin} to ${OPENAI_DECISION_BOUNDS.levelsMax} items.`,
    };
  }
  const seen = new Set<string>();
  const parsed: OpenAIDecisionLevel[] = [];
  for (const [index, level] of levels.entries()) {
    const levelPath = `${path}.levels[${index}]`;
    if (!isPlainObject(level)) return { ok: false, message: `${levelPath} must be an object.` };
    for (const key of Object.keys(level)) {
      if (key !== "label" && key !== "description") {
        return { ok: false, message: `${levelPath}.${key} is not allowed.` };
      }
    }
    if (
      typeof level.label !== "string"
      || level.label.length === 0
      || level.label.length > OPENAI_DECISION_BOUNDS.levelLabelMaxLength
    ) {
      return {
        ok: false,
        message: `${levelPath}.label must be 1 to ${OPENAI_DECISION_BOUNDS.levelLabelMaxLength} characters.`,
      };
    }
    if (seen.has(level.label)) {
      return { ok: false, message: `${path}.levels repeats "${level.label}".` };
    }
    seen.add(level.label);
    const description = parseDescription(level.description, levelPath);
    if (!description.ok) return description;
    parsed.push({
      label: level.label,
      ...(description.value !== undefined ? { description: description.value } : {}),
    });
  }
  return { ok: true, value: { type, ...base, levels: parsed } };
}

function parseDescription(
  value: unknown,
  path: string,
): OpenAIDecisionValidation<string | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "string" || value.length > OPENAI_DECISION_BOUNDS.descriptionMaxLength) {
    return {
      ok: false,
      message: `${path}.description must be a string of at most ${OPENAI_DECISION_BOUNDS.descriptionMaxLength} characters.`,
    };
  }
  return { ok: true, value };
}

const SCHEMA_TYPES = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);
/**
 * Keywords the input validator enforces. Anything else is refused at
 * registration rather than silently ignored, so a stored schema never
 * promises a check that invoke does not perform. `pattern` is excluded: an
 * operator-supplied regular expression is a backtracking risk.
 */
const SCHEMA_KEYWORDS = new Set([
  "$schema",
  "type",
  "title",
  "description",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
]);

export function parseOpenAIDecisionInputSchema(
  value: unknown,
): OpenAIDecisionValidation<OpenAIDecisionInputSchema> {
  if (!isPlainObject(value)) {
    return { ok: false, message: "inputSchema must be a JSON Schema object." };
  }
  const bytes = utf8ByteLength(JSON.stringify(value));
  if (bytes > OPENAI_DECISION_BOUNDS.inputSchemaMaxBytes) {
    return {
      ok: false,
      message: `inputSchema must be at most ${OPENAI_DECISION_BOUNDS.inputSchemaMaxBytes} bytes.`,
    };
  }
  if (value.type !== "object" && value.type !== "string") {
    return { ok: false, message: "inputSchema.type must be object or string." };
  }
  const problem = schemaProblem(value, "inputSchema", 0);
  return problem ? { ok: false, message: problem } : { ok: true, value };
}

function schemaProblem(schema: unknown, path: string, depth: number): string | undefined {
  if (depth > OPENAI_DECISION_BOUNDS.inputSchemaMaxDepth) {
    return `${path} nests deeper than ${OPENAI_DECISION_BOUNDS.inputSchemaMaxDepth} levels.`;
  }
  if (!isPlainObject(schema)) return `${path} must be an object.`;
  for (const key of Object.keys(schema)) {
    if (!SCHEMA_KEYWORDS.has(key)) return `${path}.${key} is not a supported schema keyword.`;
  }
  if (schema.$schema !== undefined && typeof schema.$schema !== "string") {
    return `${path}.$schema must be a string. It is never fetched.`;
  }
  if (typeof schema.type !== "string" || !SCHEMA_TYPES.has(schema.type)) {
    return `${path}.type must be one of ${[...SCHEMA_TYPES].join(", ")}.`;
  }
  for (const key of ["title", "description"] as const) {
    if (schema[key] !== undefined && typeof schema[key] !== "string") return `${path}.${key} must be a string.`;
  }
  for (const key of ["minLength", "maxLength", "minItems", "maxItems"] as const) {
    const bound = schema[key];
    if (bound !== undefined && (!Number.isInteger(bound) || (bound as number) < 0)) {
      return `${path}.${key} must be a non-negative integer.`;
    }
  }
  for (const key of ["minimum", "maximum"] as const) {
    if (schema[key] !== undefined && !Number.isFinite(schema[key])) return `${path}.${key} must be a number.`;
  }
  if (schema.enum !== undefined) {
    if (
      !Array.isArray(schema.enum)
      || schema.enum.length === 0
      || !schema.enum.every((item) => item === null || ["string", "number", "boolean"].includes(typeof item))
    ) {
      return `${path}.enum must be a non-empty array of strings, numbers, booleans or null.`;
    }
  }
  if (schema.properties !== undefined) {
    if (schema.type !== "object" || !isPlainObject(schema.properties)) {
      return `${path}.properties needs type object and an object value.`;
    }
    for (const [name, child] of Object.entries(schema.properties)) {
      const problem = schemaProblem(child, `${path}.properties.${name}`, depth + 1);
      if (problem) return problem;
    }
  }
  if (schema.required !== undefined) {
    if (
      schema.type !== "object"
      || !Array.isArray(schema.required)
      || !schema.required.every((item) => typeof item === "string")
    ) {
      return `${path}.required must be an array of property names on an object schema.`;
    }
  }
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") {
    return `${path}.additionalProperties must be true or false.`;
  }
  if (schema.items !== undefined) {
    if (schema.type !== "array") return `${path}.items needs type array.`;
    return schemaProblem(schema.items, `${path}.items`, depth + 1);
  }
  return undefined;
}

/**
 * Checks invoke input against a stored schema, plus the API's `input_json`
 * limits. Runs before the secret is read and before any request.
 */
export function validateOpenAIDecisionInput(
  schema: OpenAIDecisionInputSchema,
  input: unknown,
): OpenAIDecisionValidation<unknown> {
  const credential = findCredentialProperty(input);
  if (credential) {
    return { ok: false, message: `Input property "${credential}" is not allowed.` };
  }
  const serialized = JSON.stringify(input ?? null);
  if (utf8ByteLength(serialized) > OPENAI_DECISION_BOUNDS.inputJsonMaxBytes) {
    return {
      ok: false,
      message: `input must be at most ${OPENAI_DECISION_BOUNDS.inputJsonMaxBytes} bytes of compact JSON.`,
    };
  }
  const shape = jsonShape(input, 0);
  if (shape.depth > OPENAI_DECISION_BOUNDS.inputJsonMaxDepth) {
    return { ok: false, message: `input nests deeper than ${OPENAI_DECISION_BOUNDS.inputJsonMaxDepth} levels.` };
  }
  if (shape.values > OPENAI_DECISION_BOUNDS.inputJsonMaxValues) {
    return { ok: false, message: `input has more than ${OPENAI_DECISION_BOUNDS.inputJsonMaxValues} values.` };
  }
  const problem = inputProblem(schema, input, "input");
  return problem ? { ok: false, message: problem } : { ok: true, value: input };
}

function jsonShape(value: unknown, depth: number): { depth: number; values: number } {
  if (value === null || typeof value !== "object") return { depth, values: 1 };
  const children = Array.isArray(value) ? value : Object.values(value);
  let maxDepth = depth + 1;
  let values = 1;
  for (const child of children) {
    const shape = jsonShape(child, depth + 1);
    maxDepth = Math.max(maxDepth, shape.depth);
    values += shape.values;
    if (values > OPENAI_DECISION_BOUNDS.inputJsonMaxValues) break;
  }
  return { depth: maxDepth, values };
}

function inputProblem(schema: Record<string, unknown>, value: unknown, path: string): string | undefined {
  const type = schema.type as string;
  if (!matchesType(type, value)) return `${path} must be ${type}.`;
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => item === value)) {
    return `${path} must be one of ${JSON.stringify(schema.enum)}.`;
  }
  if (typeof value === "string") {
    const length = [...value].length;
    if (typeof schema.minLength === "number" && length < schema.minLength) {
      return `${path} must be at least ${schema.minLength} characters.`;
    }
    if (typeof schema.maxLength === "number" && length > schema.maxLength) {
      return `${path} must be at most ${schema.maxLength} characters.`;
    }
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) return `${path} must be >= ${schema.minimum}.`;
    if (typeof schema.maximum === "number" && value > schema.maximum) return `${path} must be <= ${schema.maximum}.`;
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      return `${path} must have at least ${schema.minItems} items.`;
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      return `${path} must have at most ${schema.maxItems} items.`;
    }
    if (isPlainObject(schema.items)) {
      for (const [index, item] of value.entries()) {
        const problem = inputProblem(schema.items, item, `${path}[${index}]`);
        if (problem) return problem;
      }
    }
  }
  if (isPlainObject(value)) {
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    for (const name of (schema.required as string[] | undefined) ?? []) {
      if (!Object.hasOwn(value, name)) return `${path}.${name} is required.`;
    }
    for (const [name, child] of Object.entries(value)) {
      const childSchema = properties[name];
      if (isPlainObject(childSchema)) {
        const problem = inputProblem(childSchema, child, `${path}.${name}`);
        if (problem) return problem;
      } else if (schema.additionalProperties === false) {
        return `${path}.${name} is not allowed.`;
      }
    }
  }
  return undefined;
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return Number.isInteger(value);
    case "boolean": return typeof value === "boolean";
    case "null": return value === null;
    case "array": return Array.isArray(value);
    case "object": return isPlainObject(value);
    default: return false;
  }
}

/** The documented `POST /v1/decisions` body. No other field is ever sent. */
export type OpenAIDecisionsRequestBody = {
  model: typeof OPENAI_DECISIONS_MODEL;
  input: Array<{
    role: "developer" | "user";
    content: Array<Record<string, unknown>>;
  }>;
  questions: OpenAIDecisionQuestion[];
  prompt_cache_key: string;
  prompt_cache_options?: { mode: "explicit"; ttl: typeof OPENAI_DECISIONS_CACHE_TTL };
  safety_identifier: string;
};

/**
 * Builds the request body. The stored prefix is the only cached content: an
 * explicit breakpoint sits on the developer text, and questions stay outside
 * the prefix as the guide requires. Without a prefix there is no developer
 * message, breakpoint, or cache options, and no cache hit is promised.
 */
export function buildOpenAIDecisionsRequestBody(params: {
  questions: readonly OpenAIDecisionQuestion[];
  prefix?: string;
  input: unknown;
  promptCacheKey: string;
  safetyIdentifier: string;
}): OpenAIDecisionsRequestBody {
  const userContent = typeof params.input === "string"
    ? [{ type: "input_text", text: params.input }]
    : [{ type: "input_json", data: params.input }];
  const prefix = params.prefix && params.prefix.length > 0 ? params.prefix : undefined;
  return {
    model: OPENAI_DECISIONS_MODEL,
    input: [
      ...(prefix
        ? [{
            role: "developer" as const,
            content: [{
              type: "input_text",
              text: prefix,
              prompt_cache_breakpoint: { mode: "explicit" },
            }],
          }]
        : []),
      { role: "user" as const, content: userContent },
    ],
    questions: params.questions.map((question) => structuredCloneQuestion(question)),
    prompt_cache_key: params.promptCacheKey,
    ...(prefix
      ? { prompt_cache_options: { mode: "explicit" as const, ttl: OPENAI_DECISIONS_CACHE_TTL } }
      : {}),
    safety_identifier: params.safetyIdentifier,
  };
}

function structuredCloneQuestion(question: OpenAIDecisionQuestion): OpenAIDecisionQuestion {
  return JSON.parse(JSON.stringify(question)) as OpenAIDecisionQuestion;
}

/**
 * Canonical JSON with sorted object keys, so the same definition always
 * hashes to the same prompt cache key.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const entries = Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
}

/** The material the prompt cache key hashes. It holds no key and no user input. */
export function openAIDecisionPromptCacheMaterial(params: {
  decisionId: string;
  version: number;
  questions: readonly OpenAIDecisionQuestion[];
  prefix?: string;
}): string {
  return [
    "pwragent-decisions-cache",
    params.decisionId,
    String(params.version),
    canonicalJson({ questions: params.questions, prefix: params.prefix ?? null }),
  ].join("\u0000");
}

/** The material the safety identifier hashes: never an email or account id. */
export function openAIDecisionSafetyMaterial(params: {
  profileId: string;
  backend: string;
  threadId: string;
}): string {
  return `pwragent-decisions\u0000${params.profileId}\u0000${params.backend}\u0000${params.threadId}`;
}

// --- Usage and price -------------------------------------------------------

/** Decisions rates for gpt-6-luna, retrieved 2026-11-14. Output is not charged. */
export const OPENAI_DECISIONS_PRICING_CATALOG_ID = "openai-decisions";
export const OPENAI_DECISIONS_PRICING_CATALOG_VERSION = "2026-11-14";
export const OPENAI_DECISIONS_LONG_CONTEXT_THRESHOLD = 272_000;
export const OPENAI_DECISIONS_RATES_MICROS_PER_MILLION = {
  uncachedInput: 100_000,
  cachedInput: 10_000,
  cacheWriteInput: 125_000,
  output: 0,
} as const;

export type OpenAIDecisionsUsage = {
  inputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
};

/**
 * Reads the response `usage`. Returns undefined when the counts are missing
 * or not non-negative integers: that is "unknown", never zero. Cache counts
 * are read from `input_tokens_details` (or the top level of `usage`); when
 * neither carries a breakdown the request's cache split is unknown.
 */
export function readOpenAIDecisionsUsage(usage: unknown): OpenAIDecisionsUsage | undefined {
  if (!isPlainObject(usage)) return undefined;
  const inputTokens = usage.input_tokens;
  const outputTokens = usage.output_tokens;
  if (!isTokenCount(inputTokens) || !isTokenCount(outputTokens)) return undefined;
  const inputDetails = isPlainObject(usage.input_tokens_details) ? usage.input_tokens_details : undefined;
  const cachedRaw = inputDetails?.cached_tokens ?? usage.cached_tokens;
  const cacheWriteRaw = inputDetails?.cache_write_tokens ?? usage.cache_write_tokens;
  if (!inputDetails && cachedRaw === undefined && cacheWriteRaw === undefined) return undefined;
  const cachedTokens = cachedRaw ?? 0;
  const cacheWriteTokens = cacheWriteRaw ?? 0;
  if (!isTokenCount(cachedTokens) || !isTokenCount(cacheWriteTokens)) return undefined;
  const outputDetails = isPlainObject(usage.output_tokens_details) ? usage.output_tokens_details : undefined;
  const reasoningRaw = outputDetails?.reasoning_tokens ?? 0;
  if (!isTokenCount(reasoningRaw)) return undefined;
  return {
    inputTokens,
    cachedTokens,
    cacheWriteTokens,
    outputTokens,
    reasoningTokens: reasoningRaw,
  };
}

export type OpenAIDecisionsPrice =
  | {
      status: "priced";
      rateId: string;
      longContext: boolean;
      /** input - cached - cache writes. */
      regularUncachedTokens: number;
      uncachedInputCostMicros: number;
      cachedInputCostMicros: number;
      cacheWriteInputCostMicros: number;
      outputCostMicros: 0;
      totalCostMicros: number;
    }
  | { status: "unpriced"; reason: "insufficient-token-breakdown" };

/**
 * Prices one measured Decisions response. `input_tokens` already includes
 * cached and cache-write tokens, so they are subtracted, never added. A
 * negative remainder means the usage object is inconsistent: unpriced, not
 * free. Output, including reasoning, is $0 on this route. The long-context
 * band doubles input and cache rates for this one request only.
 */
export function priceOpenAIDecisionsUsage(usage: OpenAIDecisionsUsage | undefined): OpenAIDecisionsPrice {
  if (!usage) return { status: "unpriced", reason: "insufficient-token-breakdown" };
  const regularUncachedTokens = usage.inputTokens - usage.cachedTokens - usage.cacheWriteTokens;
  if (regularUncachedTokens < 0 || usage.reasoningTokens > usage.outputTokens) {
    return { status: "unpriced", reason: "insufficient-token-breakdown" };
  }
  const longContext = usage.inputTokens > OPENAI_DECISIONS_LONG_CONTEXT_THRESHOLD;
  const multiplier = longContext ? 2 : 1;
  const rates = OPENAI_DECISIONS_RATES_MICROS_PER_MILLION;
  const uncachedInputCostMicros = costMicros(regularUncachedTokens, rates.uncachedInput * multiplier);
  const cachedInputCostMicros = costMicros(usage.cachedTokens, rates.cachedInput * multiplier);
  const cacheWriteInputCostMicros = costMicros(usage.cacheWriteTokens, rates.cacheWriteInput * multiplier);
  return {
    status: "priced",
    rateId: longContext
      ? "gpt-6-luna-decisions-input-gt-272k"
      : "gpt-6-luna-decisions-input-lte-272k",
    longContext,
    regularUncachedTokens,
    uncachedInputCostMicros,
    cachedInputCostMicros,
    cacheWriteInputCostMicros,
    outputCostMicros: 0,
    totalCostMicros: uncachedInputCostMicros + cachedInputCostMicros + cacheWriteInputCostMicros,
  };
}

function costMicros(tokens: number, microsPerMillion: number): number {
  if (tokens <= 0 || microsPerMillion <= 0) return 0;
  return Math.round((tokens * microsPerMillion) / 1_000_000);
}

// --- Redaction --------------------------------------------------------------

const UPSTREAM_DETAIL_MAX_LENGTH = 200;

/**
 * Removes every occurrence of each secret, then any bearer token, from text
 * that may reach a log or a tool result, and caps it at 200 characters.
 */
export function redactOpenAIDecisionsText(text: string, secrets: readonly (string | undefined)[]): string {
  let redacted = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) redacted = redacted.split(secret).join("[redacted]");
  }
  redacted = redacted
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[redacted]");
  return redacted.length > UPSTREAM_DETAIL_MAX_LENGTH
    ? `${redacted.slice(0, UPSTREAM_DETAIL_MAX_LENGTH)}…`
    : redacted;
}

/** Short visible ids pasted from the OpenAI dashboard. They are not keys. */
export function normalizeOpenAIDecisionsAccountId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= 64 && !/\s/.test(trimmed) ? trimmed : undefined;
}

function isTokenCount(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}
