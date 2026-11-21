import { once, EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import {
  JsonRpcConnection,
  type JsonRpcObserver,
} from "@pwrdrvr/agent-transport";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import { codexAuthState } from "../codex-auth-state";
import { StdioJsonRpcTransport } from "../codex-app-server/stdio-transport";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(),
  spawn: spawnMock,
}));
vi.mock("../log", () => ({
  getMainLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
}));

class FixtureChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly sent: string[] = [];
  readonly stdin = new Writable({
    write: (chunk, _encoding, done) => {
      this.sent.push(chunk.toString());
      this.emit("wrote");
      done();
    },
  });

  kill() {
    this.emit("close");
    return true;
  }
}

const methods = ["account/read", "model/list", "thread/read", "turn/start", "mcpServer/oauth/login"] as const;
const authError = { code: -32603, message: "Your access token could not be refreshed. Please log out and sign in again." };
const cases = [
  "transcript", "error-with-thread", "error-without-thread", "turn-completed", "turn-failed",
  "mcp-error", "malformed", "null", "array", "server-request", "response", "response-error",
] as const;

function operation(kind: typeof cases[number], index: number, payload: string) {
  const id = `rpc-${index + 1}`;
  const params = { threadId: "thread-a", turnId: "turn-a", delta: payload };
  const encode = (envelope: object) => JSON.stringify({ jsonrpc: "2.0", ...envelope });
  switch (kind) {
    case "transcript":
      return [encode({ method: "item/agentMessage/delta", params: { ...params, delta: authError.message } })];
    case "error-with-thread":
      return [encode({ method: "error", params: { ...params, error: authError } })];
    case "error-without-thread":
      return [encode({ method: "error", params: { error: authError } })];
    case "turn-completed":
    case "turn-failed":
      return [encode({ method: kind === "turn-completed" ? "turn/completed" : "turn/failed", params: {
        ...params, turn: { id: "turn-a", status: "failed", error: authError },
      } })];
    case "mcp-error":
      return [encode({ method: "turn/completed", params: { turn: { error: { message: `MCP: ${authError.message}` } } } })];
    case "malformed":
      return ['{"bad":'];
    case "null":
      return ["null"];
    case "array":
      return ["[]"];
    case "server-request":
      return [encode({ method: "item/commandExecution/requestApproval", id: `server-${index}`, params })];
    case "response":
      // A late second response must not inherit the method of the first.
      return [encode({ id, result: { payload } }), encode({ id, error: authError })];
    case "response-error":
      return [encode({ id, error: authError }), encode({ id, error: authError })];
  }
}

async function runTraffic({
  canonical, frames, requests = [], chunkSizes, crlf = false, finalLf = true,
  closeOnRejection = false, observerFails = false, noObserver = false,
}: {
  canonical: boolean;
  frames: string[];
  requests?: Array<{ method: string; params?: unknown }>;
  chunkSizes: number[];
  crlf?: boolean;
  finalLf?: boolean;
  closeOnRejection?: boolean;
  observerFails?: boolean;
  noObserver?: boolean;
}) {
  const home = "/fixture/codex-stdio-property";
  const child = new FixtureChild();
  const events: unknown[] = [];
  let closing: Promise<void> | undefined;
  const transport = new StdioJsonRpcTransport({
    command: "fixture",
    env: { CODEX_HOME: home },
    resolveCommand: async ({ command }) => ({ command, source: "path" }),
    onAuthenticationRejected: () => {
      events.push(["auth"]);
      if (closeOnRejection) closing = connection.close();
    },
  });
  const observer: JsonRpcObserver = {
    onMessage: async ({ direction, envelope, raw }) => {
      if (direction === "inbound") {
        events.push(["observe", envelope, raw, codexAuthState.isBlocked(home)]);
        if (observerFails) throw new Error("fixture observer failure");
      }
    },
  };
  const observed = canonical ? transport.wrapConnectionObserver(observer) : noObserver ? undefined : observer;
  const connection = new JsonRpcConnection(transport, 10_000, observed, {
    logger: {
      info() {}, debug() {},
      error: (message, fields) => { events.push(["error", message, fields]); },
      warn: (message, fields) => { events.push(["warn", message, fields]); },
    },
  });
  connection.setNotificationHandler((method, params) => {
    events.push(["notification", method, params]);
  });
  connection.setRequestHandler(async (method, params, id) => {
    events.push(["server request", method, params, id]);
    return { decision: "accept" };
  });
  spawnMock.mockReturnValue(child);
  await connection.connect();

  const pending = requests.map(({ method, params }) =>
    connection.request(method, params).then(
      (value) => { events.push(["resolved", method, value]); },
      (error: Error) => { events.push(["rejected", method, error.message]); },
    ),
  );
  // All requests must reach the pipe before the fixture responds.
  await new Promise<void>((resolve) => setImmediate(resolve));

  const delimiter = crlf ? "\r\n" : "\n";
  const wire = Buffer.from(frames.join(delimiter) + (finalLf ? delimiter : ""));
  const inputs = new Set(frames);
  let parseAttempts = 0;
  let materializations = 0;
  let parsedCodeUnits = 0;
  const parse = JSON.parse;
  JSON.parse = (...args: Parameters<typeof JSON.parse>) => {
    const inbound = inputs.has(args[0]);
    if (inbound) {
      parseAttempts += 1;
      parsedCodeUnits += args[0].length;
    }
    const value = parse(...args);
    if (inbound && value !== null && typeof value === "object") materializations += 1;
    return value;
  };
  try {
    expect(child.sent).toHaveLength(requests.length);
    // Record the dispatch relative to microtask checkpoints for the same writes.
    let tick = 0;
    const checkpoint = () => {
      events.push(["microtask", ++tick]);
      if (tick < 8) queueMicrotask(checkpoint);
    };
    queueMicrotask(checkpoint);
    for (let offset = 0, i = 0; offset < wire.length; i++) {
      const end = offset + chunkSizes[i % chunkSizes.length]!;
      child.stdout.write(wire.subarray(offset, end));
      offset = end;
    }
    events.push(["write returned"]);
    const ended = once(child.stdout, "end");
    child.stdout.end();
    await ended;
    // Let replies and handlers driven by EOF finish before simulating disconnect.
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    JSON.parse = parse;
    if (closing) await closing;
    else if (!closeOnRejection) child.emit("close", 0, null);
    await connection.close();
    await Promise.all(pending);
    codexAuthState.verified(home);
  }
  return {
    events, sent: child.sent, parseAttempts, materializations, parsedCodeUnits,
  };
}

it("materializes each delivered notification envelope only once", async () => {
  const line = '{"method":"item/agentMessage/delta","params":{"delta":"é🛰️"}}';
  const outcome = await runTraffic({ canonical: true, frames: [line], chunkSizes: [1] });
  expect(outcome.events).toContainEqual(["notification", "item/agentMessage/delta", { delta: "é🛰️" }]);
  expect(outcome.materializations).toBe(1);
  expect(outcome.parseAttempts).toBe(1);
});

it("uses the canonical parse through the desktop client's normal connection setup", async () => {
  const { CodexAppServerClient } = await import("../codex-app-server/desktop-client");
  const child = new FixtureChild();
  spawnMock.mockReturnValue(child);
  const client = new CodexAppServerClient({
    command: "fixture",
    env: { CODEX_HOME: "/fixture/codex-stdio-client" },
    resolveCommand: async ({ command }) => ({ command, source: "path" }),
    connectionObserver: { onMessage() {} },
  });
  const result = {
    userAgent: "fixture", codexHome: "/fixture/codex-stdio-client",
    platformFamily: "unix", platformOs: "fixture",
  };
  const wrote = once(child, "wrote");
  const initialized = client.getInitializeResult();
  const parse = vi.spyOn(JSON, "parse");
  try {
    await wrote;
    const { id, method } = JSON.parse(child.sent[0]!);
    expect(method).toBe("initialize");
    const response = JSON.stringify({ jsonrpc: "2.0", id, result });
    child.stdout.write(response + "\n");
    expect(await initialized).toEqual(result);
    expect(parse.mock.calls.filter(([raw]) => raw === response)).toHaveLength(1);
  } finally {
    parse.mockRestore();
    await client.close();
  }
});

it("agrees with raw-line authentication and RPC dispatch across interleaved stdio events", async () => {
  await fc.assert(fc.asyncProperty(
    fc.array(fc.constantFrom(...cases), { minLength: methods.length, maxLength: 24 }),
    fc.array(fc.integer({ min: 1, max: 128 }), { minLength: 1, maxLength: 10 }),
    fc.string({ maxLength: 60 }), fc.boolean(), fc.boolean(),
    async (kinds, chunkSizes, text, crlf, finalLf) => {
      const frames = kinds.flatMap((kind, index) => operation(kind, index, `${text}é🛰️\u2028\u2029`));
      const fixture = {
        frames, chunkSizes, crlf, finalLf,
        requests: kinds.map((_, index) => ({ method: methods[index % methods.length]! })),
      };
      const baseline = await runTraffic({ ...fixture, canonical: false });
      const actual = await runTraffic({ ...fixture, canonical: true });
      expect(actual.events).toEqual(baseline.events);
      expect(actual.sent).toEqual(baseline.sent);
      const authEvents = kinds.filter((kind, index) =>
        kind === "error-with-thread" || kind === "turn-completed" || kind === "turn-failed"
        || (kind === "response-error" && fixture.requests[index]?.method !== "mcpServer/oauth/login"));
      expect(actual.events.filter((event) => Array.isArray(event) && event[0] === "auth")).toHaveLength(authEvents.length);
      expect(actual.parseAttempts).toBe(frames.length);
      expect(actual.parsedCodeUnits).toBe(frames.reduce((sum, line) => sum + line.length, 0));
      expect(actual.materializations).toBe(frames.filter((line) => line.startsWith('{"jsonrpc":') || line === "[]").length);
    },
  ), { numRuns: 40 });
});

it.each([
  ["account/read", true],
  ["model/list", false],
  ["thread/read", false],
  ["turn/start", false],
  ["mcpServer/oauth/login", false],
] as const)("correlates a credential-only error for %s before dispatch", async (method, blocks) => {
  const frames = [JSON.stringify({ id: "rpc-1", error: { message: "invalid_refresh_token" } })];
  const outcome = await runTraffic({ canonical: true, frames, requests: [{ method }], chunkSizes: [256] });
  expect(outcome.events.filter((event) => Array.isArray(event) && event[0] === "auth")).toHaveLength(Number(blocks));
  expect(outcome.events).toContainEqual(["observe", JSON.parse(frames[0]!), frames[0], blocks]);
  expect(outcome.events).toContainEqual(["rejected", method, "json-rpc error (unknown): invalid_refresh_token"]);
});

it.each([1_024, 65_536, 131_072])("parses each of 16 replies once at %i payload code units", async (size) => {
  const payload = "x".repeat(size);
  const frames = Array.from({ length: 16 }, (_, index) => operation("response", index, payload)[0]!);
  const requests = frames.map(() => ({ method: "thread/list" }));
  const outcome = await runTraffic({ canonical: true, frames, requests, chunkSizes: [65_536, 17] });
  expect(outcome.events.filter((event) => Array.isArray(event) && event[0] === "resolved")).toHaveLength(16);
  expect(outcome.parseAttempts).toBe(16);
  expect(outcome.materializations).toBe(16);
  expect(outcome.parsedCodeUnits).toBe(frames.reduce((sum, line) => sum + line.length, 0));
});

it("latches auth and cancels pending RPCs before observers and dispatch can accept a response", async () => {
  const frames = operation("response-error", 0, "");
  const fixture = {
    frames, requests: [{ method: "account/read" }], chunkSizes: [8], closeOnRejection: true,
  };
  const baseline = await runTraffic({ ...fixture, canonical: false });
  const actual = await runTraffic({ ...fixture, canonical: true });
  expect(actual.events).toEqual(baseline.events);
  expect(actual.events[0]).toEqual(["auth"]);
  expect(actual.events.filter((event) => Array.isArray(event) && event[0] === "auth")).toHaveLength(1);
  expect(actual.events).toContainEqual(["rejected", "account/read", "json-rpc transport closed"]);
});

it("lets JSON-RPC report a diagnostic observer failure and continue dispatch", async () => {
  const fixture = {
    frames: operation("transcript", 0, ""), chunkSizes: [256], observerFails: true,
  };
  const outcome = await runTraffic({ ...fixture, canonical: true });
  expect(outcome.events).toEqual((await runTraffic({ ...fixture, canonical: false })).events);
  expect(outcome.events).toContainEqual(["error", "json-rpc observer failed", {
    direction: "inbound", message: "item/agentMessage/delta", error: "fixture observer failure",
  }]);
  expect(outcome.events).toContainEqual(["notification", "item/agentMessage/delta", {
    threadId: "thread-a", turnId: "turn-a", delta: authError.message,
  }]);
});

it("keeps standalone authentication synchronous and dispatch on its original microtask", async () => {
  const frames = operation("error-with-thread", 0, "");
  const outcome = await runTraffic({ canonical: false, noObserver: true, frames, chunkSizes: [256] });
  expect(outcome.events.slice(0, 5)).toEqual([
    ["auth"], ["write returned"], ["microtask", 1],
    ["notification", "error", JSON.parse(frames[0]!).params], ["microtask", 2],
  ]);
});
