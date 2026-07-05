const TIMEOUT_MS = 20_000;
const MAX_PROMPT_CHARS = 4_000;

const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["prompt"],
  properties: {
    prompt: {
      type: "string",
      minLength: 1,
      maxLength: 4_000,
    },
  },
} as const;

const SYSTEM_PROMPT = [
  "You write the task prompt for an automated agent that runs when a matching",
  "chat message arrives (for example a Datadog alert in a group).",
  "Given the operator's plain-language description, return a clear, self-contained",
  "task prompt the agent can follow every time it fires.",
  "Guidance:",
  "- Write 2-5 sentences in the imperative, addressed to the agent.",
  "- Say what to investigate, which data/tools to use if the operator mentioned any,",
  "  and to end with a short, human-readable summary of findings.",
  "- The triggering message is provided to the agent automatically; refer to it as",
  '  "the incoming message" rather than inventing specifics.',
  "- No placeholders, no preamble, no meta commentary. Return JSON matching the schema.",
].join("\n");

export type AutomationPromptDraftResult =
  | { status: "generated"; prompt: string }
  | { status: "unavailable" | "invalid" | "failed"; reason: string };

/**
 * Provider-agnostic structured one-shot. Supplied by the backend registry so
 * drafting runs on the operator's configured backend (Codex/Grok), not a
 * hardcoded provider.
 */
export type StructuredGenerator = (request: {
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
  schemaName?: string;
  timeoutMs?: number;
}) => Promise<
  | { status: "ok"; object: unknown }
  | { status: "unavailable" | "failed"; reason: string }
>;

export async function generateAutomationPromptDraft(params: {
  description: string;
  generate: StructuredGenerator;
}): Promise<AutomationPromptDraftResult> {
  const description = params.description.trim();
  if (!description) {
    return { status: "invalid", reason: "empty_description" };
  }

  const result = await params.generate({
    system: SYSTEM_PROMPT,
    prompt: description,
    schema: RESPONSE_SCHEMA,
    schemaName: "automation_prompt",
    timeoutMs: TIMEOUT_MS,
  });
  if (result.status !== "ok") {
    return result;
  }

  const object = result.object;
  const prompt =
    object && typeof object === "object" && !Array.isArray(object)
      ? (object as { prompt?: unknown }).prompt
      : undefined;
  if (typeof prompt !== "string") {
    return { status: "invalid", reason: "prompt_must_be_string" };
  }
  const cleaned = prompt.trim();
  if (!cleaned) {
    return { status: "invalid", reason: "prompt_empty" };
  }
  return { status: "generated", prompt: cleaned.slice(0, MAX_PROMPT_CHARS) };
}
