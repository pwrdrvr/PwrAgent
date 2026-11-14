import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ThreadUsageLineRecord } from "@pwragent/shared";
import { OpenAIDecisionStore } from "../storage/openai-decision-store";
import {
  OpenAIDecisionsError,
  OpenAIDecisionsService,
  type OpenAIDecisionsServiceOptions,
} from "../openai-decisions/openai-decisions-service";
import { codexModelProviderAccountKey } from "../usage-account-identity";
import type { StateDb } from "../state/state-db";
import { openInMemoryStateDb } from "./sqlite-test-utils";

// A synthetic key: never a real secret. Every assertion below checks that it
// stays out of results, logs, rows, and usage lines.
const TEST_KEY = "sk-test-openai-decisions-0123456789abcdef";
const CODEX = { backend: "codex", threadId: "thread-a" };
const OTHER_THREAD = { backend: "codex", threadId: "thread-b" };
const CLAUDE = { backend: "claude", threadId: "thread-c" };

const TICKET_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ticket"],
  properties: { ticket: { type: "string", maxLength: 8000 } },
};

const ROUTE_DEFINITION = {
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
};

type CapturedRequest = { method?: string; url?: string; headers: IncomingHttpHeaders; body: unknown };
type MockResponse = { status: number; headers?: Record<string, string>; body: unknown };

/** A local stand-in for POST /v1/decisions. No request leaves the machine. */
class MockDecisionsServer {
  readonly requests: CapturedRequest[] = [];
  readonly responses: MockResponse[] = [];
  private server?: Server;
  endpoint = "";

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        this.requests.push({
          method: request.method,
          url: request.url,
          headers: request.headers,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        });
        const next = this.responses.shift() ?? successResponse();
        response.writeHead(next.status, { "content-type": "application/json", ...next.headers });
        response.end(JSON.stringify(next.body));
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const { port } = this.server!.address() as AddressInfo;
    this.endpoint = `http://127.0.0.1:${port}/v1/decisions`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}

function successResponse(usage: Record<string, unknown> = {
  input_tokens: 1000,
  input_tokens_details: { cached_tokens: 400, cache_write_tokens: 100 },
  output_tokens: 7,
  output_tokens_details: { reasoning_tokens: 7 },
}, requestId = "req_test_1"): MockResponse {
  // The service passes the body through except `usage`; the answer field
  // name here is fixture data and is not asserted by the service.
  return {
    status: 200,
    headers: { "x-request-id": requestId },
    body: {
      model: "gpt-6-luna",
      answers: [{ type: "choice", name: "queue", choice: "billing", confidence: 0.9 }],
      usage,
    },
  };
}

let db: StateDb;
let server: MockDecisionsServer;
let logs: string[];
let usageLines: ThreadUsageLineRecord[];
let secret: string | undefined;
let sleeps: number[];

function makeService(overrides: Partial<OpenAIDecisionsServiceOptions> = {}, stateDb = db) {
  let ids = 0;
  return new OpenAIDecisionsService({
    store: new OpenAIDecisionStore(stateDb),
    readApiKey: async () => secret,
    readAccountSettings: () => ({ projectId: "proj_test" }),
    profileId: () => "test-profile",
    recordUsageLine: async (line) => { usageLines.push(line); },
    endpoint: server.endpoint,
    sleep: async (ms) => { sleeps.push(ms); },
    now: () => 1_700_000_000_000,
    newDecisionId: () => `decision-${++ids}`,
    log: {
      info: (message, fields) => logs.push(`${message} ${JSON.stringify(fields)}`),
      warn: (message, fields) => logs.push(`${message} ${JSON.stringify(fields)}`),
    },
    ...overrides,
  });
}

async function captureError(work: () => unknown): Promise<OpenAIDecisionsError> {
  try {
    await work();
  } catch (error) {
    if (error instanceof OpenAIDecisionsError) return error;
    throw error;
  }
  throw new Error("expected an OpenAIDecisionsError");
}

beforeEach(async () => {
  db = openInMemoryStateDb();
  server = new MockDecisionsServer();
  await server.start();
  logs = [];
  usageLines = [];
  secret = TEST_KEY;
  sleeps = [];
});

afterEach(async () => {
  await server.stop();
  db.close();
});

describe("registry", () => {
  it("registers locally without a request and refuses a second active name in scope", async () => {
    const service = makeService();
    expect(service.register(CODEX, ROUTE_DEFINITION)).toMatchObject({
      decisionId: "decision-1", name: "route_support_ticket", version: 1, scope: "profile",
    });
    expect(server.requests).toHaveLength(0);
    expect((await captureError(() => service.register(CODEX, ROUTE_DEFINITION))).code)
      .toBe("decision_name_taken");
    // Profile scope is profile-wide: another backend's thread collides too.
    expect((await captureError(() => service.register(CLAUDE, ROUTE_DEFINITION))).code)
      .toBe("decision_name_taken");
    // The unique index enforces it even if two writers race past the read.
    const store = new OpenAIDecisionStore(db);
    expect(() => store.insertFirstVersion({
      ...store.getActive("decision-1")!, decisionId: "racer", ownerBackend: "claude",
    })).toThrow(/already exists/);
  });

  it("keeps thread scope to its owning thread and profile scope to its profile", async () => {
    const service = makeService();
    service.register(CODEX, { ...ROUTE_DEFINITION, name: "private_rule", scope: "thread" });
    service.register(CODEX, { ...ROUTE_DEFINITION, name: "shared_rule" });
    const names = (caller: typeof CODEX) =>
      (service.list(caller, {}) as { decisions: Array<{ name: string }> }).decisions.map((d) => d.name);
    expect(names(CODEX)).toEqual(["private_rule", "shared_rule"]);
    expect(names(OTHER_THREAD)).toEqual(["shared_rule"]);
    expect(names(CLAUDE)).toEqual(["shared_rule"]);
    expect((await captureError(() => service.invoke(OTHER_THREAD, {
      name: "private_rule", input: { ticket: "x" },
    }))).code).toBe("decision_not_found");
    expect((await captureError(() => service.delete(OTHER_THREAD, { name: "private_rule" }))).code)
      .toBe("decision_not_found");
    // Another thread may reuse a thread-scoped name.
    expect(service.register(OTHER_THREAD, { ...ROUTE_DEFINITION, name: "private_rule", scope: "thread" }))
      .toMatchObject({ scope: "thread" });

    // A second profile is a second state database.
    const otherProfile = openInMemoryStateDb();
    try {
      const otherService = makeService({}, otherProfile);
      expect((otherService.list(CODEX, {}) as { decisions: unknown[] }).decisions).toEqual([]);
    } finally {
      otherProfile.close();
    }
    expect(server.requests).toHaveLength(0);
  });

  it("gives each update a new version and cache key, and keeps old versions pinnable until delete", async () => {
    const service = makeService();
    service.register(CODEX, ROUTE_DEFINITION);
    const updated = service.update(OTHER_THREAD, {
      ...ROUTE_DEFINITION,
      instructions: "Which team owns this ticket?",
    });
    expect(updated).toMatchObject({ decisionId: "decision-1", version: 2 });
    expect((await captureError(() => service.update(CODEX, { ...ROUTE_DEFINITION, scope: "thread" }))).code)
      .toBe("invalid_definition");

    await service.invoke(CODEX, { name: "route_support_ticket", input: { ticket: "a" } });
    await service.invoke(CODEX, { name: "route_support_ticket", version: 1, input: { ticket: "b" } });
    const [latest, pinned] = server.requests.map((request) => request.body as {
      questions: Array<{ instructions: string }>;
      prompt_cache_key: string;
    });
    expect(latest!.questions[0]!.instructions).toBe("Which team owns this ticket?");
    expect(pinned!.questions[0]!.instructions).toBe("Which queue should handle this ticket?");
    expect(latest!.prompt_cache_key).toMatch(/^[0-9a-f]{64}$/);
    expect(latest!.prompt_cache_key).not.toBe(pinned!.prompt_cache_key);

    expect(service.delete(CODEX, { name: "route_support_ticket" })).toMatchObject({ deleted: true });
    const before = server.requests.length;
    for (const args of [
      { name: "route_support_ticket", input: { ticket: "c" } },
      { decisionId: "decision-1", version: 1, input: { ticket: "c" } },
    ]) {
      expect((await captureError(() => service.invoke(CODEX, args))).code).toBe("decision_deleted");
    }
    expect(server.requests).toHaveLength(before);
    // The name is free again, as a new decision starting at version 1.
    expect(service.register(CODEX, ROUTE_DEFINITION)).toMatchObject({ decisionId: "decision-2", version: 1 });
  });
});

describe("invoke", () => {
  it("sends the exact documented request with the key only in the Authorization header", async () => {
    const service = makeService();
    service.register(CODEX, ROUTE_DEFINITION);
    const result = await service.invoke(CODEX, {
      name: "route_support_ticket",
      input: { ticket: "I was charged twice." },
    });
    expect(server.requests).toHaveLength(1);
    const [request] = server.requests;
    expect(request!.method).toBe("POST");
    expect(request!.url).toBe("/v1/decisions");
    expect(request!.headers.authorization).toBe(`Bearer ${TEST_KEY}`);
    expect(request!.headers["openai-project"]).toBe("proj_test");
    expect(request!.headers["openai-organization"]).toBeUndefined();
    expect(request!.headers["content-type"]).toBe("application/json");
    const body = request!.body as Record<string, unknown>;
    expect(Object.keys(body)).toEqual([
      "model", "input", "questions", "prompt_cache_key", "prompt_cache_options", "safety_identifier",
    ]);
    expect(body).toMatchObject({
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
        { role: "user", content: [{ type: "input_json", data: { ticket: "I was charged twice." } }] },
      ],
      questions: [{
        type: "choice",
        name: "queue",
        instructions: "Which queue should handle this ticket?",
        choices: [
          { value: "billing", description: "Payments, invoices, and refunds." },
          { value: "other", description: "Anything else." },
        ],
      }],
      prompt_cache_options: { mode: "explicit", ttl: "30m" },
    });
    expect(body.safety_identifier).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(body)).not.toContain(TEST_KEY);
    expect(result).toMatchObject({
      decisionId: "decision-1",
      version: 1,
      model: "gpt-6-luna",
      requestId: "req_test_1",
      response: { answers: [{ choice: "billing" }] },
      usage: {
        inputTokens: 1000,
        cachedTokens: 400,
        cacheWriteTokens: 100,
        regularUncachedTokens: 500,
        outputTokens: 7,
        reasoningTokens: 7,
        priceStatus: "estimated",
        estimatedCostUsd: 0.000067,
      },
    });
    expect((result as { response: object }).response).not.toHaveProperty("usage");
    expect(JSON.stringify(result)).not.toContain(TEST_KEY);
    expect(logs.join("\n")).not.toContain(TEST_KEY);
    expect(logs.join("\n")).not.toContain("Which queue");
  });

  it("refuses invalid input, credential arguments, and a missing key with zero requests", async () => {
    const service = makeService();
    service.register(CODEX, ROUTE_DEFINITION);
    for (const args of [
      { name: "route_support_ticket", input: { ticket: 5 } },
      { name: "route_support_ticket", input: { ticket: "x", extra: true } },
      { name: "route_support_ticket", input: { ticket: "x", apiKey: TEST_KEY } },
      { name: "route_support_ticket", input: { ticket: "x" }, apiKey: TEST_KEY },
      { name: "route_support_ticket", input: { ticket: "x" }, authorization: "Bearer y" },
      { name: "route_support_ticket" },
    ]) {
      const error = await captureError(() => service.invoke(CODEX, args));
      expect(error.code).toBe("invalid_input");
      expect(error.message).not.toContain(TEST_KEY);
    }
    expect((await captureError(() => service.register(CODEX, { ...ROUTE_DEFINITION, name: "x", apiKey: TEST_KEY })))
      .code).toBe("invalid_definition");
    secret = undefined;
    expect((await captureError(() => service.invoke(CODEX, {
      name: "route_support_ticket", input: { ticket: "ok" },
    }))).code).toBe("credential_missing");
    expect(server.requests).toHaveLength(0);
    expect(usageLines).toHaveLength(0);
  });

  it("maps a 401 that echoes the key to credential_rejected without leaking it", async () => {
    const service = makeService();
    service.register(CODEX, ROUTE_DEFINITION);
    server.responses.push({
      status: 401,
      headers: { "x-request-id": "req_denied" },
      body: { error: { type: "invalid_request_error", code: "invalid_api_key", message: `Incorrect API key provided: ${TEST_KEY}.` } },
    });
    const error = await captureError(() => service.invoke(CODEX, {
      name: "route_support_ticket", input: { ticket: "x" },
    }));
    expect(error.code).toBe("credential_rejected");
    expect(error.message).toContain("req_denied");
    expect(error.message).not.toContain(TEST_KEY);
    expect(JSON.stringify(error.data)).not.toContain(TEST_KEY);
    expect(logs.join("\n")).not.toContain(TEST_KEY);
    expect(server.requests).toHaveLength(1);
  });

  it("retries only 429 slow_down and 503 server_is_overloaded with a short Retry-After", async () => {
    const service = makeService();
    service.register(CODEX, ROUTE_DEFINITION);
    const invoke = async () => await service.invoke(CODEX, { name: "route_support_ticket", input: { ticket: "x" } });

    server.responses.push(
      { status: 429, headers: { "retry-after": "2" }, body: { error: { code: "slow_down" } } },
      { status: 503, headers: { "retry-after": "1" }, body: { error: { code: "server_is_overloaded" } } },
      successResponse(),
    );
    await invoke();
    expect(server.requests).toHaveLength(3);
    expect(sleeps).toEqual([2000, 1000]);

    server.requests.length = 0;
    server.responses.push(
      { status: 429, headers: { "retry-after": "1" }, body: { error: { code: "slow_down" } } },
      { status: 429, headers: { "retry-after": "1" }, body: { error: { code: "slow_down" } } },
      { status: 429, headers: { "retry-after": "1" }, body: { error: { code: "slow_down" } } },
    );
    expect((await captureError(invoke)).code).toBe("rate_limited");
    expect(server.requests).toHaveLength(3);

    for (const [response, code] of [
      [{ status: 429, body: { error: { code: "slow_down" } } }, "rate_limited"],
      [{ status: 429, headers: { "retry-after": "60" }, body: { error: { code: "slow_down" } } }, "rate_limited"],
      [{ status: 429, headers: { "retry-after": "1" }, body: { error: { code: "insufficient_quota" } } }, "rate_limited"],
      [{ status: 503, body: { error: { code: "server_is_overloaded" } } }, "overloaded"],
      [{ status: 400, body: { error: { code: "invalid_request" } } }, "upstream_error"],
      [{ status: 404, body: { error: { code: "model_not_found" } } }, "model_unavailable"],
      [{ status: 403, body: {} }, "credential_rejected"],
    ] as Array<[MockResponse, string]>) {
      server.requests.length = 0;
      server.responses.push(response);
      expect((await captureError(invoke)).code).toBe(code);
      expect(server.requests).toHaveLength(1);
    }
  });

  it("allows one request in flight and four waiters per decision, then answers busy", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const service = makeService({
      fetch: async (...args) => {
        calls += 1;
        await gate;
        return await globalThis.fetch(...args);
      },
    });
    service.register(CODEX, ROUTE_DEFINITION);
    const invoke = () => service.invoke(CODEX, { name: "route_support_ticket", input: { ticket: "x" } });
    const running = [invoke(), invoke(), invoke(), invoke(), invoke()];
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await captureError(invoke)).code).toBe("busy");
    release();
    await Promise.all(running);
    expect(calls).toBe(5);
  });

  it("records one usage line per attempt that returned usage, on the API project account", async () => {
    const service = makeService();
    service.register(CODEX, ROUTE_DEFINITION);
    server.responses.push(
      { status: 429, headers: { "retry-after": "1", "x-request-id": "req_slow" }, body: { error: { code: "slow_down" } } },
      successResponse(undefined, "req_ok"),
    );
    await service.invoke(CODEX, { name: "route_support_ticket", input: { ticket: "x" } });
    expect(usageLines).toHaveLength(1);
    const [line] = usageLines;
    expect(line).toMatchObject({
      provider: "openai_decisions",
      source: "openai_decisions",
      scope: "monitor",
      status: "finalized",
      backend: "codex",
      threadId: "thread-a",
      parentThreadId: "thread-a",
      sourceItemId: "decision-1:1:req_ok",
      model: "gpt-6-luna",
      inputTokens: 1000,
      cachedInputTokens: 400,
      cacheWriteInputTokens: 100,
      uncachedInputTokens: 600,
      outputTokens: 7,
      reasoningOutputTokens: 7,
      priceStatus: "priced",
      pricingBasis: "decisions-output-uncharged",
      uncachedInputCostMicros: 50,
      cachedInputCostMicros: 4,
      cacheWriteInputCostMicros: 13,
      outputCostMicros: 0,
      totalCostMicros: 67,
      accountKey: codexModelProviderAccountKey("https://api.openai.com", TEST_KEY),
    });
    expect(line!.turnId).toBeUndefined();
    expect(line!.reasoningEffort).toBeUndefined();
    expect(line!.serviceTier).toBeUndefined();
    expect(JSON.stringify(line)).not.toContain(TEST_KEY);

    usageLines.length = 0;
    server.responses.push(successResponse({
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 90, cache_write_tokens: 20 },
      output_tokens: 0,
    }, "req_bad"));
    const result = await service.invoke(CODEX, { name: "route_support_ticket", input: { ticket: "x" } });
    expect(result.usage).toMatchObject({ priceStatus: "unavailable" });
    expect(usageLines[0]).toMatchObject({
      priceStatus: "unpriced",
      priceUnavailableReason: "insufficient-token-breakdown",
      totalCostMicros: 0,
    });
  });
});

it("stores no key material in the registry rows", () => {
  const service = makeService();
  service.register(CODEX, ROUTE_DEFINITION);
  const rows = JSON.stringify(db.raw.prepare("SELECT * FROM openai_decision_versions").all());
  expect(rows).not.toContain(TEST_KEY);
  expect(rows).not.toMatch(/api_?key|authorization/i);
});
