import type { AppServerBackendKind } from "@pwragnt/shared";
import {
  XaiEphemeralObjectCaller,
  type XaiObjectClientLike,
} from "./ephemeral-object-call";
import { buildThreadTitlePrompt } from "./thread-title-prompt";

export const THREAD_TITLE_PROMPT_VERSION = "thread-title-v1";
export const DEFAULT_GROK_THREAD_TITLE_MODEL = "grok-4-1-fast-non-reasoning";

const THREAD_TITLE_TIMEOUT_MS = 20_000;
const MAX_TITLE_CHARACTERS = 50;
const MAX_TITLE_WORDS = 6;

const THREAD_TITLE_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title"],
  properties: {
    title: {
      type: "string",
      minLength: 1,
      maxLength: 80,
    },
  },
} as const;

export type ThreadTitleAdapterParams = {
  prompt: string;
  promptVersion: string;
  schema: Record<string, unknown>;
  schemaName: string;
  timeoutMs: number;
};

export type ThreadTitleAdapterResult =
  | {
      status: "ok";
      object: unknown;
      cachedTokens?: number;
    }
  | {
      status: "unavailable" | "failed";
      reason: string;
    };

export type ThreadTitleGenerator = {
  generateTitle(params: ThreadTitleAdapterParams): Promise<ThreadTitleAdapterResult>;
};

export type ThreadTitleGenerationResult =
  | {
      status: "generated";
      title: string;
      cachedTokens?: number;
    }
  | {
      status: "unavailable" | "invalid" | "failed";
      reason: string;
    };

export type ThreadTitleGenerationServiceOptions = {
  generators?: Partial<Record<AppServerBackendKind, ThreadTitleGenerator>>;
  timeoutMs?: number;
};

export type GrokThreadTitleGeneratorOptions = {
  apiKey?: string;
  baseUrl?: string;
  client?: XaiObjectClientLike;
  model?: string;
  timeoutMs?: number;
};

export class ThreadTitleGenerationService {
  private readonly generators: Partial<Record<AppServerBackendKind, ThreadTitleGenerator>>;
  private readonly timeoutMs: number;

  constructor(options: ThreadTitleGenerationServiceOptions = {}) {
    this.generators = {
      grok: new GrokThreadTitleGenerator({ timeoutMs: options.timeoutMs }),
      ...options.generators,
    };
    this.timeoutMs = options.timeoutMs ?? THREAD_TITLE_TIMEOUT_MS;
  }

  async generateTitle(params: {
    backend: AppServerBackendKind;
    userPrompt: string;
  }): Promise<ThreadTitleGenerationResult> {
    const userPrompt = params.userPrompt.trim();
    if (!userPrompt) {
      return {
        status: "invalid",
        reason: "empty_prompt",
      };
    }

    const generator = this.generators[params.backend];
    if (!generator) {
      return {
        status: "unavailable",
        reason: `${params.backend}_title_generator_unavailable`,
      };
    }

    const result = await generator.generateTitle({
      prompt: buildThreadTitlePrompt(userPrompt),
      promptVersion: THREAD_TITLE_PROMPT_VERSION,
      schema: THREAD_TITLE_RESPONSE_SCHEMA,
      schemaName: "thread_title",
      timeoutMs: this.timeoutMs,
    });
    if (result.status !== "ok") {
      return result;
    }

    const normalized = normalizeThreadTitleObject(result.object, userPrompt);
    if (!normalized.title) {
      return {
        status: "invalid",
        reason: normalized.reason,
      };
    }

    return {
      status: "generated",
      title: normalized.title,
      cachedTokens: result.cachedTokens,
    };
  }
}

export class GrokThreadTitleGenerator implements ThreadTitleGenerator {
  private readonly caller: XaiEphemeralObjectCaller;
  private readonly model: string;
  private readonly timeoutMs?: number;

  constructor(options: GrokThreadTitleGeneratorOptions = {}) {
    this.model = options.model?.trim() || DEFAULT_GROK_THREAD_TITLE_MODEL;
    this.timeoutMs = options.timeoutMs;
    this.caller = new XaiEphemeralObjectCaller({
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      client: options.client,
      model: this.model,
    });
  }

  async generateTitle(
    params: ThreadTitleAdapterParams
  ): Promise<ThreadTitleAdapterResult> {
    const result = await this.caller.generateObject({
      model: this.model,
      promptCacheKey: params.promptVersion,
      headers: {
        "x-grok-conv-id": params.promptVersion,
      },
      timeoutMs: this.timeoutMs ?? params.timeoutMs,
      schema: params.schema,
      schemaName: params.schemaName,
      system: [
        "Generate a concise desktop thread title.",
        "Return JSON that matches the schema exactly.",
      ].join("\n"),
      prompt: params.prompt,
    });

    if (result.status !== "ok") {
      return result;
    }

    return {
      status: "ok",
      object: result.response.object,
      cachedTokens: result.response.cachedTokens,
    };
  }
}

function normalizeThreadTitleObject(
  object: unknown,
  userPrompt: string
): { title?: string; reason: string } {
  if (!object || typeof object !== "object" || Array.isArray(object)) {
    return { reason: "title_payload_must_be_object" };
  }

  const title = (object as { title?: unknown }).title;
  if (typeof title !== "string") {
    return { reason: "title_must_be_string" };
  }

  const cleaned = cleanThreadTitle(title);
  if (!cleaned) {
    return { reason: "title_empty" };
  }
  if (cleaned.length > MAX_TITLE_CHARACTERS) {
    return { reason: "title_too_long" };
  }
  if (countWords(cleaned) > MAX_TITLE_WORDS) {
    return { reason: "title_too_many_words" };
  }
  if (!preservesTicketReferences(userPrompt, cleaned)) {
    return { reason: "ticket_reference_missing" };
  }

  return {
    title: cleaned,
    reason: "ok",
  };
}

function cleanThreadTitle(value: string): string {
  let title = value.trim();
  title = stripMatchingQuotes(title);
  title = title.replace(/[.!?。！？]+$/u, "").trim();
  return title;
}

function stripMatchingQuotes(value: string): string {
  const pairs: Array<[string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ["`", "`"],
  ];

  for (const [left, right] of pairs) {
    if (value.startsWith(left) && value.endsWith(right) && value.length >= 2) {
      return value.slice(1, -1).trim();
    }
  }

  return value;
}

function countWords(value: string): number {
  return value.split(/\s+/).filter(Boolean).length;
}

function preservesTicketReferences(userPrompt: string, title: string): boolean {
  const promptRefs = extractTicketReferences(userPrompt);
  if (promptRefs.length === 0) {
    return true;
  }

  const normalizedTitle = normalizeReferenceText(title);
  return promptRefs.every((reference) =>
    normalizedTitle.includes(normalizeReferenceText(reference))
  );
}

function extractTicketReferences(value: string): string[] {
  const references: string[] = [];
  const patterns = [
    /\b[A-Z][A-Z0-9]+-\d+\b/g,
    /#\d+\b/g,
    /\b\d{2,}\b/g,
    /\b(?:issue|pr|pull request)\s+#?\d+\b/gi,
  ];

  for (const pattern of patterns) {
    for (const match of value.matchAll(pattern)) {
      references.push(match[0]);
    }
  }

  return references;
}

function normalizeReferenceText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}
