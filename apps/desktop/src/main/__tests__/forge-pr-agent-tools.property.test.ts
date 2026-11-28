import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { buildForgePrToolDefinitions } from "../agent-tools/pwragent-forge-pr-agent-tools";
import { ForgePrToolService } from "../pr-status/forge-pr-tool-service";
import { ctx, harness, json, pull, repo } from "./github-pr-tool-test-fixture";

const nativeStack = (numbers: number[]) => ({
  number: 42, open: true, base: { ref: "main" },
  pull_requests: numbers.map((number, index) => pull(number, {
    head: { ref: `layer-${index}` },
    base: { ref: index ? `layer-${index - 1}` : "main" },
  })),
});

type StackReceipt = "complete" | "empty" | "server_error" | "disconnect";
type StackAttempt = { chain: "pair" | "longer"; receipt: StackReceipt };

async function replayStackRegistration(numbers: number[], attempts: readonly StackAttempt[]) {
  const chains = { pair: numbers.slice(0, 2), longer: numbers };
  // The fixture commits one of these overlapping chains at the forge, before
  // returning any response. A second write that overlaps it is rejected.
  let registered: number[] | undefined;
  const { calls, client } = harness((call) => {
    if (call.method === "GET") {
      expect(new URL(call.url).searchParams.get("pull_request")).toBe(String(numbers[0]));
      return json(registered ? [nativeStack(registered)] : []);
    }
    expect(call.method).toBe("POST");
    expect(call.body).toEqual({ pull_requests: chains[attempt.chain] });
    if (registered) return json({ message: "PRs already stacked" }, 422);
    registered = chains[attempt.chain];
    if (attempt.receipt === "empty") return new Response(null, { status: 201 });
    if (attempt.receipt === "server_error") return json({ message: "GitHub could not deliver the receipt" }, 500);
    if (attempt.receipt === "disconnect") throw new TypeError("connection closed before response");
    return json(nativeStack(registered), 201);
  });
  const definition = buildForgePrToolDefinitions((operation, args) => client.execute(operation, args, ctx()))
    .find((tool) => tool.name === "create_pull_request_stack")!;
  const winner = attempts[0]!;
  let attempt: StackAttempt;
  for (const [index, step] of attempts.entries()) {
    attempt = step;
    const before = calls.length;
    const result = await definition.dispatch({ pullRequests: chains[step.chain] }, { backend: "codex", threadId: "t", transport: "codex_dynamic_tool" });
    const context = { index, step, calls: calls.slice(before).map((call) => call.method), result };
    if (winner.receipt === "disconnect") {
      // The shared transport's cooldown stops all subsequent HTTP calls.
      expect(context).toMatchObject(index === 0 ? { calls: ["POST"], result: { ok: false, code: "provider_error" } }
        : { calls: [], result: { ok: false, code: "rate_limited" } });
    } else if (step.chain !== winner.chain) {
      expect(context).toMatchObject({ calls: ["POST", "GET"], result: { ok: false, code: "rejected" } });
    } else {
      const needsReadback = index !== 0 || step.receipt !== "complete";
      const created = index !== 0 ? false : step.receipt === "server_error" ? null : true;
      expect(context).toMatchObject({
        calls: needsReadback ? ["POST", "GET"] : ["POST"],
        result: { ok: true, data: { created, providerRequests: needsReadback ? 2 : 1, stack: { number: 42, pullRequests: chains[step.chain] } } },
      });
    }
  }
  expect(registered).toEqual(chains[winner.chain]);
}

describe("GitHub stack registration", () => {
  async function expectNativeRegistration(numbers: number[]) {
    const { calls, client } = harness((call) => call.method === "POST" && call.url.endsWith("/repos/fixture/project/stacks")
      ? json(nativeStack(numbers), 201)
      : json({ message: "Unexpected route" }, 500));
    const service = new ForgePrToolService({
      enabled: () => true, clients: { github: client, gitlab: { execute: vi.fn() } }, defaultMergeMethod: () => "squash",
    });
    const scope = { remotes: [repo], attached: [], directories: [], privateRoots: [] };
    const definition = buildForgePrToolDefinitions(async (operation, args) => {
      const prepared = await service.prepare(operation, args, scope);
      return await service.execute(operation, { ...prepared.args, repository: prepared.repository }, scope);
    }).find((entry) => entry.name === "create_pull_request_stack");
    expect(definition, "A chain of published PRs needs a native GitHub registration tool").toBeDefined();
    const result = await definition!.dispatch({ pullRequests: numbers }, { backend: "codex", threadId: "t", transport: "codex_dynamic_tool" });
    expect(result).toMatchObject({ ok: true, data: { created: true, providerRequests: 1, stack: { number: 42, base: "main", pullRequests: numbers } } });
    expect(calls).toEqual([{ url: "https://api.github.com/repos/fixture/project/stacks", method: "POST", body: { pull_requests: numbers }, accept: "application/vnd.github+json" }]);
  }

  it("registers the terminal layout PR above its fix PR on GitHub", () => expectNativeRegistration([4658, 4665]));

  it("preserves the requested bottom-first order at a fixed provider request count", async () => {
    await fc.assert(fc.asyncProperty(fc.uniqueArray(fc.integer({ min: 1, max: 10000 }), { minLength: 2, maxLength: 16 }), expectNativeRegistration), { numRuns: 5 });
    for (const size of [8, 16, 32]) {
      await expectNativeRegistration(Array.from({ length: size }, (_, index) => size - index));
    }
  });

  it("reads membership after GitHub creates the stack with an empty receipt", () =>
    replayStackRegistration([4658, 4665, 4680], [{ chain: "pair", receipt: "empty" }]));

  it("confirms membership after a server error without claiming which write created it", () =>
    replayStackRegistration([1, 2, 3], [
      { chain: "pair", receipt: "server_error" },
      { chain: "pair", receipt: "complete" },
      { chain: "longer", receipt: "complete" },
    ]));

  it("matches GitHub membership across failed receipts, repeat calls and overlapping chains", async () => {
    const step = fc.record({
      chain: fc.constantFrom("pair", "longer"),
      receipt: fc.constantFrom("complete", "empty", "server_error", "disconnect"),
    });
    await fc.assert(fc.asyncProperty(
      fc.uniqueArray(fc.integer({ min: 1, max: 10000 }), { minLength: 3, maxLength: 3 }),
      fc.array(step, { minLength: 1, maxLength: 8, size: "max" }),
      replayStackRegistration,
    ), { numRuns: Number(process.env.MBT_RUNS ?? 5) });
  });

  it.each([false, true])("settles racing registrations while the winning receipt is pending (same chain %s)", async (sameChain) => {
    const firstCommitted = Promise.withResolvers<void>();
    const firstReceipt = Promise.withResolvers<Response>();
    const pair = [4658, 4665];
    const { calls, client } = harness((call) => {
      if (call.method === "GET") return json([nativeStack(pair)]);
      if (calls.length > 1) return json({ message: "PRs already stacked" }, 422);
      firstCommitted.resolve();
      return firstReceipt.promise;
    });
    const create = (pullRequests: number[]) => client.execute("create_pull_request_stack", { pullRequests }, ctx());
    const winner = create(pair);
    try {
      await firstCommitted.promise;
      if (sameChain) {
        await expect(create(pair)).resolves.toMatchObject({ created: false, stack: { number: 42, pullRequests: pair } });
      } else {
        await expect(create([...pair, 4680])).rejects.toMatchObject({ code: "rejected" });
      }
    } finally {
      firstReceipt.resolve(new Response(null, { status: 201 }));
    }
    await expect(winner).resolves.toMatchObject({ created: true, stack: { number: 42, pullRequests: pair } });
    expect(calls.map((call) => call.method)).toEqual(["POST", "POST", "GET", "GET"]);
  });

  it("confirms an already registered chain after GitHub rejects a repeat", async () => {
    const { calls, client } = harness((call) => call.method === "POST"
      ? json({ message: "PRs already stacked" }, 422)
      : json([nativeStack([4658, 4665])]));
    await expect(client.execute("create_pull_request_stack", { pullRequests: [4658, 4665] }, ctx())).resolves.toMatchObject({
      created: false, providerRequests: 2, stack: { number: 42, base: "main", pullRequests: [4658, 4665] },
    });
    expect(calls.map((call) => [call.method, new URL(call.url).search])).toEqual([["POST", ""], ["GET", "?pull_request=4658"]]);
  });

  it("preserves the rejection when GitHub has different members", async () => {
    const { calls, client } = harness((call) => call.method === "POST"
      ? json({ message: "PRs already stacked" }, 422)
      : json([nativeStack([4658, 4665, 4680])]));
    await expect(client.execute("create_pull_request_stack", { pullRequests: [4658, 4665] }, ctx()))
      .rejects.toMatchObject({ code: "rejected", message: expect.stringContaining("PRs already stacked") });
    expect(calls.map((call) => call.method)).toEqual(["POST", "GET"]);
  });

  it("reports GitHub write permission failures after one request", async () => {
    const { calls, client } = harness(() => json({ message: "Resource not accessible by integration" }, 403));
    await expect(client.execute("create_pull_request_stack", { pullRequests: [4658, 4665] }, ctx()))
      .rejects.toMatchObject({ code: "forbidden", message: expect.stringContaining("Pull requests write access") });
    expect(calls.map((call) => call.method)).toEqual(["POST"]);
  });

  it("requires GitHub to confirm the ordered members before reporting creation", async () => {
    const reversed = nativeStack([4665, 4658]);
    const { calls, client } = harness((call) => call.method === "POST" ? json(reversed, 201) : json([reversed]));
    await expect(client.execute("create_pull_request_stack", { pullRequests: [4658, 4665] }, ctx()))
      .rejects.toMatchObject({ code: "invalid_response" });
    expect(calls.map((call) => call.method)).toEqual(["POST", "GET"]);
  });

  it("points an uncertain stack write with no checkout to the live GitHub PR", async () => {
    const { calls, client } = harness(() => { throw new TypeError("connection closed before response"); });
    const attached = [{ number: 4665, headRefName: "test/thread-terminal-layout-ci" }];
    await expect(client.execute("create_pull_request_stack", { pullRequests: [4658, 4665] }, ctx({ attached })))
      .rejects.toMatchObject({
        code: "provider_error",
        message: expect.stringContaining("Check the PR on GitHub for the native stack before retrying. https://github.com/fixture/project/pull/4658"),
      });
    expect(calls.map((call) => call.method)).toEqual(["POST"]);
  });
});
