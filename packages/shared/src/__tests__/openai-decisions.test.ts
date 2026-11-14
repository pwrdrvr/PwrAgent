import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  OPENAI_DECISIONS_MODEL,
  buildOpenAIDecisionsRequestBody,
  findCredentialProperty,
  parseOpenAIDecisionRegistration,
  priceOpenAIDecisionsUsage,
  readOpenAIDecisionsUsage,
  redactOpenAIDecisionsText,
  validateOpenAIDecisionInput,
} from "../openai-decisions";

// Request shapes pinned to the create reference retrieved 2026-11-14.

const TICKET_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ticket"],
  properties: { ticket: { type: "string", maxLength: 8000 } },
};

function register(args: Record<string, unknown>) {
  const parsed = parseOpenAIDecisionRegistration(args);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.value;
}

describe("request JSON", () => {
  it("sends a choice question with the prefix as the only cached developer text", () => {
    const definition = register({
      name: "route_support_ticket",
      instructions: "Which queue should handle this ticket?",
      question: {
        type: "choice",
        name: "queue",
        choices: [
          { value: "billing", description: "Payments, invoices, and refunds." },
          { value: "other", description: "Anything else." },
        ],
      },
      inputSchema: TICKET_SCHEMA,
      prefix: "Shared rubric text reused across invokes.",
    });
    const body = buildOpenAIDecisionsRequestBody({
      questions: definition.questions,
      prefix: definition.prefix,
      input: { ticket: "I was charged twice." },
      promptCacheKey: "a".repeat(64),
      safetyIdentifier: "b".repeat(64),
    });
    expect(JSON.parse(JSON.stringify(body))).toEqual({
      model: "gpt-6-luna",
      input: [
        {
          role: "developer",
          content: [{
            type: "input_text",
            text: "Shared rubric text reused across invokes.",
            prompt_cache_breakpoint: { mode: "explicit" },
          }],
        },
        {
          role: "user",
          content: [{ type: "input_json", data: { ticket: "I was charged twice." } }],
        },
      ],
      questions: [{
        type: "choice",
        instructions: "Which queue should handle this ticket?",
        name: "queue",
        choices: [
          { value: "billing", description: "Payments, invoices, and refunds." },
          { value: "other", description: "Anything else." },
        ],
      }],
      prompt_cache_key: "a".repeat(64),
      prompt_cache_options: { mode: "explicit", ttl: "30m" },
      safety_identifier: "b".repeat(64),
    });
    // The documented body has no such fields; the breakpoint is never on a question.
    for (const forbidden of ["reasoning", "service_tier", "tools", "temperature", "store", "region"]) {
      expect(body).not.toHaveProperty(forbidden);
    }
    expect(JSON.stringify(body.questions)).not.toContain("prompt_cache_breakpoint");
    expect(JSON.stringify(body.input[0])).not.toContain("Which queue");
  });

  it("sends score and predicate questions without a developer message or cache options when there is no prefix", () => {
    const definition = register({
      name: "triage",
      questions: [
        {
          type: "score",
          name: "urgency",
          instructions: "How urgent is this?",
          levels: [{ label: "low" }, { label: "medium" }, { label: "high", description: "Same day." }],
        },
        { type: "predicate", name: "refund", instructions: "Does the customer ask for a refund?" },
      ],
      inputSchema: { type: "string", maxLength: 100 },
    });
    const body = buildOpenAIDecisionsRequestBody({
      questions: definition.questions,
      prefix: definition.prefix,
      input: "Please refund me today.",
      promptCacheKey: "c".repeat(64),
      safetyIdentifier: "d".repeat(64),
    });
    expect(JSON.parse(JSON.stringify(body))).toEqual({
      model: OPENAI_DECISIONS_MODEL,
      input: [{ role: "user", content: [{ type: "input_text", text: "Please refund me today." }] }],
      questions: [
        {
          type: "score",
          instructions: "How urgent is this?",
          name: "urgency",
          levels: [{ label: "low" }, { label: "medium" }, { label: "high", description: "Same day." }],
        },
        { type: "predicate", instructions: "Does the customer ask for a refund?", name: "refund" },
      ],
      prompt_cache_key: "c".repeat(64),
      safety_identifier: "d".repeat(64),
    });
  });
});

describe("definition bounds", () => {
  const base = { name: "ok_name", instructions: "Is it?", question: { type: "predicate" }, inputSchema: TICKET_SCHEMA };

  it.each([
    ["an uppercase name", { ...base, name: "Bad" }],
    ["a boolean choice value", { ...base, question: { type: "choice", choices: [{ value: true }, { value: "no" }] } }],
    ["one choice", { ...base, question: { type: "choice", choices: [{ value: "only" }] } }],
    ["repeated choices", { ...base, question: { type: "choice", choices: [{ value: "a" }, { value: "a" }] } }],
    ["one score level", { ...base, question: { type: "score", levels: [{ label: "x" }] } }],
    ["image instructions", { ...base, instructions: [{ type: "input_image", image_url: "https://x" }] }],
    ["17 questions", { ...base, question: undefined, questions: Array.from({ length: 17 }, () => ({ type: "predicate" })) }],
    ["a $ref schema", { ...base, inputSchema: { type: "object", properties: { a: { $ref: "#/x" } } } }],
    ["a pattern keyword", { ...base, inputSchema: { type: "string", pattern: "(a+)+$" } }],
    ["an oversize schema", { ...base, inputSchema: { type: "string", description: "x".repeat(9000) } }],
    ["an array root schema", { ...base, inputSchema: { type: "array" } }],
    ["an apiKey property", { ...base, apiKey: "anything" }],
    ["a nested authorization property", { ...base, inputSchema: { type: "object", properties: { authorization: { type: "string" } } } }],
    ["a key in the prefix", { ...base, prefix: "use sk-proj-ABCDEFGHIJKLMNOPQRSTUV" }],
    ["an unknown property", { ...base, endpoint: "https://example.com" }],
  ])("rejects %s", (_label, args) => {
    const parsed = parseOpenAIDecisionRegistration(
      Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined)),
    );
    expect(parsed.ok).toBe(false);
  });

  it("validates invoke input against the stored schema and refuses credential properties", () => {
    expect(validateOpenAIDecisionInput(TICKET_SCHEMA, { ticket: "hi" }).ok).toBe(true);
    expect(validateOpenAIDecisionInput(TICKET_SCHEMA, {}).ok).toBe(false);
    expect(validateOpenAIDecisionInput(TICKET_SCHEMA, { ticket: 5 }).ok).toBe(false);
    expect(validateOpenAIDecisionInput(TICKET_SCHEMA, { ticket: "hi", extra: 1 }).ok).toBe(false);
    expect(validateOpenAIDecisionInput(TICKET_SCHEMA, { ticket: "x".repeat(8001) }).ok).toBe(false);
    expect(validateOpenAIDecisionInput({ type: "object" }, { apiKey: "x" }).ok).toBe(false);
    expect(findCredentialProperty({ a: [{ OpenAIDecisionsApiKey: 1 }] })).toBe("OpenAIDecisionsApiKey");
  });
});

describe("usage and price", () => {
  it("prices the documented example: input already includes cached and cache-write tokens", () => {
    const usage = readOpenAIDecisionsUsage({
      input_tokens: 1000,
      input_tokens_details: { cached_tokens: 400, cache_write_tokens: 100 },
      output_tokens: 7,
      output_tokens_details: { reasoning_tokens: 7 },
    });
    expect(usage).toEqual({
      inputTokens: 1000, cachedTokens: 400, cacheWriteTokens: 100, outputTokens: 7, reasoningTokens: 7,
    });
    expect(priceOpenAIDecisionsUsage(usage)).toEqual({
      status: "priced",
      rateId: "gpt-6-luna-decisions-input-lte-272k",
      longContext: false,
      regularUncachedTokens: 500,
      uncachedInputCostMicros: 50, // 500 × $0.10/1M
      cachedInputCostMicros: 4, // 400 × $0.01/1M
      cacheWriteInputCostMicros: 13, // 100 × $0.125/1M = 12.5, rounded like the shared pricer
      outputCostMicros: 0, // output, including 7 reasoning tokens, is not charged
      totalCostMicros: 67,
    });
  });

  it("doubles input and cache rates for one measured request over 272K input, still with $0 output", () => {
    const price = priceOpenAIDecisionsUsage({
      inputTokens: 272_001, cachedTokens: 1, cacheWriteTokens: 0, outputTokens: 12, reasoningTokens: 0,
    });
    expect(price).toMatchObject({
      status: "priced",
      longContext: true,
      rateId: "gpt-6-luna-decisions-input-gt-272k",
      uncachedInputCostMicros: 54_400, // 272,000 × $0.20/1M
      cachedInputCostMicros: 0, // 1 × $0.02/1M rounds to 0
      outputCostMicros: 0,
    });
    expect(priceOpenAIDecisionsUsage({
      inputTokens: 272_000, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0,
    })).toMatchObject({ longContext: false, uncachedInputCostMicros: 27_200 });
  });

  it("calls inconsistent or missing usage unpriced, never free", () => {
    expect(priceOpenAIDecisionsUsage({
      inputTokens: 100, cachedTokens: 80, cacheWriteTokens: 40, outputTokens: 0, reasoningTokens: 0,
    })).toEqual({ status: "unpriced", reason: "insufficient-token-breakdown" });
    expect(priceOpenAIDecisionsUsage(readOpenAIDecisionsUsage(undefined)).status).toBe("unpriced");
    expect(readOpenAIDecisionsUsage({ input_tokens: 10, output_tokens: 0 })).toBeUndefined();
    expect(readOpenAIDecisionsUsage({ input_tokens: -1, output_tokens: 0, input_tokens_details: {} })).toBeUndefined();
  });

  it("matches a direct reading of the documented formula for every consistent usage", () => {
    const rate = (perMillionUsd: number, tokens: number, multiplier: number) =>
      Math.round((tokens * perMillionUsd * multiplier * 1_000_000) / 1_000_000);
    fc.assert(fc.property(
      fc.nat({ max: 2_000_000 }), fc.nat({ max: 2_000_000 }), fc.nat({ max: 2_000_000 }), fc.nat({ max: 50_000 }),
      (input, cached, writes, output) => {
        const price = priceOpenAIDecisionsUsage({
          inputTokens: input, cachedTokens: cached, cacheWriteTokens: writes, outputTokens: output, reasoningTokens: 0,
        });
        const uncached = input - cached - writes;
        if (uncached < 0) {
          expect(price.status).toBe("unpriced");
          return;
        }
        const multiplier = input > 272_000 ? 2 : 1;
        expect(price).toMatchObject({
          status: "priced",
          regularUncachedTokens: uncached,
          uncachedInputCostMicros: rate(0.1, uncached, multiplier),
          cachedInputCostMicros: rate(0.01, cached, multiplier),
          cacheWriteInputCostMicros: rate(0.125, writes, multiplier),
          outputCostMicros: 0,
        });
      },
    ));
  });
});

it("redacts the key and bearer values and caps upstream text at 200 characters", () => {
  const key = "sk-test-0123456789abcdef";
  const text = redactOpenAIDecisionsText(`Incorrect API key provided: ${key}. Bearer abc.def ${"x".repeat(400)}`, [key]);
  expect(text).not.toContain(key);
  expect(text).not.toContain("abc.def");
  expect(text.length).toBeLessThanOrEqual(201);
});
