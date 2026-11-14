import { expect, it } from "vitest";
import { buildOpenAIDecisionsRequestBody } from "@pwragent/shared/openai-decisions";
import { postOpenAIDecision } from "../openai-decisions/openai-decisions-client";

const TEST_KEY = "sk-test-openai-decisions-client-0123456789";
const body = buildOpenAIDecisionsRequestBody({
  questions: [{ type: "predicate", instructions: "Is it urgent?" }],
  input: "Server down",
  promptCacheKey: "a".repeat(64),
  safetyIdentifier: "b".repeat(64),
});

it("reports a cancellation during the Retry-After wait as cancelled, not as a rate limit", async () => {
  const controller = new AbortController();
  const result = await postOpenAIDecision({
    body,
    apiKey: TEST_KEY,
    signal: controller.signal,
    fetch: async () => new Response(JSON.stringify({ error: { code: "slow_down" } }), {
      status: 429,
      headers: { "retry-after": "5" },
    }),
    sleep: async () => {
      controller.abort();
      throw new Error("aborted");
    },
  });
  expect(result).toMatchObject({ ok: false, code: "upstream_error", detail: "The request was cancelled." });
});

it("reports a body that stalls past the timeout as a timeout, not as malformed JSON", async () => {
  const result = await postOpenAIDecision({
    body,
    apiKey: TEST_KEY,
    timeoutMs: 20,
    fetch: async (_url, init) => {
      const signal = init!.signal!;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{\"model\":"));
          signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
        },
      });
      return new Response(stream, { status: 200, headers: { "x-request-id": "req_slow_body" } });
    },
  });
  expect(result).toMatchObject({ ok: false, code: "upstream_error", detail: "The request timed out.", requestId: "req_slow_body" });
  expect(JSON.stringify(result)).not.toContain(TEST_KEY);
});
