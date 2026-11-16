import assert from "node:assert/strict";
import fc from "fast-check";
import { test } from "vitest";
import { startPortableCodeModeTransport } from "../apps/desktop/src/main/codex-app-server/portable-code-mode-transport.mjs";

function clock() {
  let now = 0;
  let arms = 0;
  const timers = new Map();
  const waiters = [];
  return {
    scheduleTimeout(callback, delay) {
      const id = ++arms;
      timers.set(id, { at: now + delay, callback });
      for (const waiter of waiters.splice(0)) waiter();
      return () => timers.delete(id);
    },
    async armed(count) {
      while (arms < count) await new Promise(resolve => waiters.push(resolve));
    },
    advance(ms) {
      now += ms;
      for (const [id, timer] of timers) if (timer.at <= now) {
        timers.delete(id);
        timer.callback();
      }
    },
    get pending() { return timers.size; },
  };
}

const request = { stream: true, tools: [{ type: "custom", name: "exec", format: { type: "grammar", syntax: "lark" } }] };
const post = (server, signal) => fetch(`http://127.0.0.1:${server.address().port}/v1/responses`, {
  method: "POST", body: JSON.stringify(request), signal,
});
const close = async server => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
};

test("progress resets the idle window across arbitrarily long active SSE and buffered responses", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.integer({ min: 1, max: 99 }), { minLength: 4, maxLength: 12 }), fc.boolean(), async (gaps, streaming) => {
    const time = clock();
    let body;
    let signal;
    let started;
    const sending = new Promise(resolve => { started = resolve; });
    const server = await startPortableCodeModeTransport({ idleTimeoutMs: 100, scheduleTimeout: time.scheduleTimeout,
      send: async (_body, upstreamSignal) => {
        signal = upstreamSignal;
        started();
        const stream = new ReadableStream({ start(controller) {
          body = controller;
          signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
        } });
        return new Response(stream, { headers: { "Content-Type": streaming ? "text/event-stream" : "application/json" } });
      },
    });
    try {
      const result = post(server).then(response => response.text());
      void result.catch(() => {});
      await sending;
      assert.equal(time.pending, 1, "a waiting upstream must have exactly one idle timer");
      await time.armed(2); // Waiting for response, then upstream headers.
      // Include a near-window prefill and force total duration beyond one window.
      for (const [i, gap] of [99, 99, ...gaps].entries()) {
        time.advance(gap);
        assert.equal(signal.aborted, false);
        body.enqueue(new TextEncoder().encode(streaming ? ": progress\n\n" : " "));
        await time.armed(3 + i);
        assert.equal(time.pending, 1);
      }
      body.enqueue(new TextEncoder().encode(streaming
        ? 'data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n'
        : '{"status":"completed","output":[]}'));
      body.close();
      assert.match(await result, /completed/);
      assert.equal(time.pending, 0);
    } finally { await close(server); }
  }), { numRuns: 10 });
});

test("idle expiry aborts before headers and mid-stream, and cancellation releases the timer", async () => {
  for (const phase of ["headers", "body", "cancel"]) {
    const time = clock();
    let signal;
    let started;
    const sending = new Promise(resolve => { started = resolve; });
    const server = await startPortableCodeModeTransport({ idleTimeoutMs: 100, scheduleTimeout: time.scheduleTimeout,
      send: (_body, upstreamSignal) => {
        signal = upstreamSignal;
        started();
        if (phase === "headers") return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
        return Promise.resolve(new Response(new ReadableStream({ start(controller) {
          signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
          controller.enqueue(new TextEncoder().encode(": initial\n\n"));
        } }), { headers: { "Content-Type": "text/event-stream" } }));
      },
    });
    try {
      const client = new AbortController();
      const result = post(server, client.signal).then(async response => ({ status: response.status, text: await response.text() }), () => ({ status: "closed" }))
        .catch(() => ({ status: "closed" }));
      await sending;
      assert.equal(time.pending, 1, "a waiting upstream must have exactly one idle timer");
      await time.armed(phase === "headers" ? 1 : 3);
      if (phase === "cancel") client.abort();
      else time.advance(100);
      const outcome = await result;
      if (phase === "headers") assert.equal(outcome.status, 504);
      else assert.equal(outcome.status, "closed");
      // Closing the client can arrive after its own fetch promise rejects.
      if (!signal.aborted) await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
      assert.equal(signal.aborted, true);
      assert.equal(time.pending, 0);
    } finally { await close(server); }
  }
});
