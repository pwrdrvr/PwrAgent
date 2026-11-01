import { sandboxerStub } from "./helpers/sandboxer-stub";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ElicitRequestParams } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpConnectionGatewayService } from "../mcp-connections/mcp-connection-gateway-service";
import { McpConnectionRegistry } from "../mcp-connections/mcp-connection-registry";
import { ConnectionRpcClient } from "../mcp-connections/mcp-connection-rpc-client";
import type { ElicitationRoute } from "../mcp-connections/mcp-elicitation-relay";
import type { McpGatewayTool } from "../mcp-connections/mcp-gateway-catalog";
import { McpStdioSecretVault } from "../mcp-connections/mcp-stdio-secret-vault";

/*
 * Upstream MCP elicitation, end to end through the gateway, against a local
 * command that behaves like a desktop app guarding a destructive tool: its
 * `remove` asks for a form confirmation mid-call, with a single-use nonce per
 * process, and removes only on an accepted `confirm: true`. The server writes
 * every message it saw to a log, so a test can assert what reached it and
 * what never did. Nothing here runs a real MCP server or launches an app.
 */
const FAKE_SERVER = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const crypto = require("node:crypto");
const log = (entry) => fs.appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({ pid: process.pid, ...entry }) + "\n");
const nonce = crypto.randomUUID();
const waiting = new Map();
let nextForm = 1;
let buffer = "";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));
function result(id, body, isError) {
  send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(body) }], ...(isError ? { isError: true } : {}) } });
}
function handle(message) {
  if (message.method === undefined) {
    const form = waiting.get(message.id);
    waiting.delete(message.id);
    log({ event: "answer", formId: message.id, nonce: form && form.nonce, result: message.result, error: message.error });
    if (!form) return;
    const answer = message.result;
    const removed = Boolean(answer && answer.action === "accept" && answer.content && answer.content.confirm === true);
    result(form.callId, { removed, nonce: form.nonce }, !removed);
    return;
  }
  if (message.id === undefined) {
    if (message.method === "notifications/cancelled") log({ event: "cancelled", requestId: message.params.requestId });
    return;
  }
  if (message.method === "initialize") {
    log({ event: "initialize", capabilities: message.params.capabilities });
    send({ jsonrpc: "2.0", id: message.id, result: {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "fixture-disk", version: "1.0.0" },
    } });
  } else if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools: [
      { name: "remove", inputSchema: { type: "object", properties: { path: { type: "string" }, meta: { type: "object" } }, required: ["path"] },
        annotations: { destructiveHint: true } },
      { name: "hold", inputSchema: { type: "object", properties: { ms: { type: "number" } } }, annotations: { readOnlyHint: true } },
    ] } });
  } else if (message.method === "tools/call") {
    const args = message.params.arguments || {};
    log({ event: "call", name: message.params.name });
    if (message.params.name === "hold") {
      setTimeout(() => result(message.id, { held: true }), args.ms);
      return;
    }
    const formId = "fixture-form-" + nextForm++;
    waiting.set(formId, { callId: message.id, nonce });
    log({ event: "ask", formId, nonce });
    send({ jsonrpc: "2.0", id: formId, method: "elicitation/create", params: {
      message: "Remove " + args.path + "? This cannot be undone.",
      requestedSchema: {
        type: "object",
        properties: {
          confirm: { type: "boolean", title: "Remove permanently" },
          reason: { type: "string", pattern: "^[a-z ]+$", "x-fixture-hint": "kept verbatim" },
        },
        required: ["confirm"],
      },
      _meta: { "fixture/confirmation": nonce, persist: ["session"], ...(args.meta || {}) },
    } });
  } else {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "no such method" } });
  }
}
`;

type LogEntry = {
  pid: number;
  event: "initialize" | "call" | "ask" | "answer" | "cancelled";
  capabilities?: Record<string, unknown>;
  formId?: string;
  nonce?: string;
  name?: string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
};

type Fixture = { root: string; binDir: string; log: string };

const services: McpConnectionGatewayService[] = [];
const temporaryDirectories: string[] = [];

function makeFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-mcp-elicit-"));
  temporaryDirectories.push(root);
  const binDir = path.join(root, "bin");
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, "fixture-disk-mcp"), FAKE_SERVER, { mode: 0o755 });
  return { root, binDir, log: path.join(root, "server.jsonl") };
}

function readLog(fixture: Fixture): LogEntry[] {
  if (!fs.existsSync(fixture.log)) return [];
  return fs.readFileSync(fixture.log, "utf8").trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as LogEntry);
}

async function createService(fixture: Fixture, selection: { ids: string[] } = { ids: [] }) {
  const service = new McpConnectionGatewayService({
    sandboxer: sandboxerStub(),
    bridgeEntryPath: "/test/mcp-connection-bridge.js",
    gatewayEnabled: () => true,
    leaseManager: null,
    readGatewaySelection: async () => selection.ids,
    registry: new McpConnectionRegistry({ configPath: path.join(fixture.root, "config.toml") }),
    settings: {
      clearMcpConnectionCredentials: vi.fn(async () => undefined),
      clearPwrSnapMcpCredential: vi.fn(async () => undefined),
      clearPwrGitMcpCredential: vi.fn(async () => undefined),
      resolveMcpConnectionCredentials: vi.fn(async () => undefined),
      resolvePwrSnapMcpCredential: vi.fn(async () => undefined),
      resolvePwrGitMcpCredential: vi.fn(async () => undefined),
      saveMcpConnectionCredentials: vi.fn(async () => undefined),
      savePwrSnapMcpCredential: vi.fn(async () => undefined),
    },
    resolveStdioSearchEnv: async () => ({ PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH ?? ""}` }),
    stdioSecrets: new McpStdioSecretVault({ settings: {
      resolveMcpStdioConnectionSecrets: vi.fn(async () => undefined),
      saveMcpStdioConnectionSecrets: vi.fn(async () => undefined),
      clearMcpStdioConnectionSecrets: vi.fn(async () => undefined),
    } }),
  });
  services.push(service);
  const connection = await service.createConnection({
    displayName: "Fixture Disk",
    stdio: {
      command: "fixture-disk-mcp",
      args: [],
      cwd: fixture.root,
      env: [{ name: "FIXTURE_LOG", secret: false, value: fixture.log }],
    },
  });
  selection.ids.push(connection.id);
  return { service, connectionId: connection.id, selection };
}

async function bridgeFor(service: McpConnectionGatewayService, connectionId: string, threadId: string) {
  const registration = await service.registerBridge(connectionId, threadId);
  const env = registration.server.env;
  return new ConnectionRpcClient(env.PWRAGENT_MCP_CONNECTION_SOCKET, env.PWRAGENT_MCP_CONNECTION_TOKEN);
}

type RemoveOutcome = { removed: boolean; nonce: string };

async function remove(
  rpc: ConnectionRpcClient,
  options: { onElicit?: ElicitationRoute; signal?: AbortSignal; meta?: Record<string, unknown> } = {},
): Promise<RemoveOutcome> {
  const result = await rpc.request(
    "tools/call",
    { name: "remove", arguments: { path: "/fixture/old", ...(options.meta ? { meta: options.meta } : {}) } },
    options.signal,
    undefined,
    undefined,
    undefined,
    options.onElicit,
  ) as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0]!.text) as RemoveOutcome;
}

/** A person who has not answered yet, and answers when told to. */
function pendingPerson() {
  const asked: Array<{ params: ElicitRequestParams; signal: AbortSignal; answer: (value: unknown) => void }> = [];
  const onElicit: ElicitationRoute = async (params, signal) =>
    await new Promise((resolve) => { asked.push({ params, signal, answer: resolve }); });
  return { asked, onElicit };
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function answers(fixture: Fixture): LogEntry[] {
  return readLog(fixture).filter((entry) => entry.event === "answer");
}

afterEach(async () => {
  await Promise.all(services.splice(0).map(async (service) => await service.close()));
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe.skipIf(process.platform === "win32")("upstream MCP elicitation through managed connections", () => {
  it("declares form elicitation on thread sessions only", async () => {
    const fixture = makeFixture();
    const { service, connectionId } = await createService(fixture);
    const rpc = await bridgeFor(service, connectionId, "thread-a");

    await remove(rpc, { onElicit: async () => ({ action: "decline" }) });
    await service.listConnectionTools({ connectionId, refresh: true });

    const capabilities = readLog(fixture)
      .filter((entry) => entry.event === "initialize")
      .map((entry) => entry.capabilities);
    // The thread's session, then the Settings listing.
    expect(capabilities).toEqual([{ elicitation: { form: {} } }, {}]);
  });

  it("forwards the server's form exactly and returns the person's accept exactly", async () => {
    const fixture = makeFixture();
    const { service, connectionId } = await createService(fixture);
    const rpc = await bridgeFor(service, connectionId, "thread-a");
    const seen: ElicitRequestParams[] = [];

    const outcome = await remove(rpc, {
      onElicit: async (params) => {
        seen.push(params);
        return { action: "accept", content: { confirm: true, reason: "old backup" }, _meta: { "client/approval": "kept" } };
      },
    });

    const [ask] = readLog(fixture).filter((entry) => entry.event === "ask");
    expect(seen).toEqual([{
      message: "Remove /fixture/old? This cannot be undone.",
      requestedSchema: {
        type: "object",
        properties: {
          confirm: { type: "boolean", title: "Remove permanently" },
          reason: { type: "string", pattern: "^[a-z ]+$", "x-fixture-hint": "kept verbatim" },
        },
        required: ["confirm"],
      },
      _meta: { "fixture/confirmation": ask!.nonce, persist: ["session"] },
    }]);
    expect(answers(fixture).map((entry) => entry.result)).toEqual([
      { action: "accept", content: { confirm: true, reason: "old backup" }, _meta: { "client/approval": "kept" } },
    ]);
    expect(outcome).toEqual({ removed: true, nonce: ask!.nonce });
  });

  it.each(["decline", "cancel"] as const)("returns %s without content", async (action) => {
    const fixture = makeFixture();
    const { service, connectionId } = await createService(fixture);
    const rpc = await bridgeFor(service, connectionId, "thread-a");

    await expect(remove(rpc, { onElicit: async () => ({ action, content: { confirm: true } }) }))
      .resolves.toMatchObject({ removed: false });

    expect(answers(fixture).map((entry) => entry.result)).toEqual([{ action }]);
  });

  it.each([
    ["no content", { action: "accept" }],
    ["an empty form", { action: "accept", content: {} }],
    ["content outside the schema", { action: "accept", content: { confirm: true, reason: "NOT ALLOWED" } }],
    ["no action", { content: { confirm: true } }],
  ])("refuses an answer with %s instead of passing it on as an acceptance", async (_label, answer) => {
    const fixture = makeFixture();
    const { service, connectionId } = await createService(fixture);
    const rpc = await bridgeFor(service, connectionId, "thread-a");

    await expect(remove(rpc, { onElicit: async () => answer })).resolves.toMatchObject({ removed: false });

    const [entry] = answers(fixture);
    expect(entry?.result).toBeUndefined();
    expect(entry?.error?.code).toBe(-32602);
  });

  it("fails closed for a caller that cannot show forms, exactly as before", async () => {
    const fixture = makeFixture();
    const { service, connectionId } = await createService(fixture);
    const rpc = await bridgeFor(service, connectionId, "thread-a");

    await expect(remove(rpc)).resolves.toMatchObject({ removed: false });

    const [entry] = answers(fixture);
    expect(entry?.result).toBeUndefined();
    expect(entry?.error?.code).toBe(-32601);
  });

  it.each(["codex_approval_kind", "pwragent_approval_kind"])(
    "refuses a form whose _meta claims %s instead of forwarding or rewriting it",
    async (key) => {
      const fixture = makeFixture();
      const { service, connectionId } = await createService(fixture);
      const rpc = await bridgeFor(service, connectionId, "thread-a");
      const onElicit = vi.fn(async () => ({ action: "accept", content: { confirm: true } }));

      await expect(remove(rpc, { onElicit, meta: { [key]: "mcp_tool_call" } }))
        .resolves.toMatchObject({ removed: false });

      expect(onElicit).not.toHaveBeenCalled();
      expect(answers(fixture)[0]?.error?.code).toBe(-32602);
    },
  );

  it("withdraws the form when the caller disconnects and never delivers the late answer", async () => {
    const fixture = makeFixture();
    const { service, connectionId } = await createService(fixture);
    const rpc = await bridgeFor(service, connectionId, "thread-a");
    const person = pendingPerson();
    const caller = new AbortController();

    const call = remove(rpc, { onElicit: person.onElicit, signal: caller.signal });
    await waitFor(() => person.asked.length === 1, "the form");
    caller.abort();
    await expect(call).rejects.toThrow("cancelled");
    await waitFor(() => answers(fixture).length === 1, "the server to hear back");
    person.asked[0]!.answer({ action: "accept", content: { confirm: true } });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(person.asked[0]!.signal.aborted).toBe(true);
    expect(answers(fixture).map((entry) => entry.result)).toEqual([{ action: "cancel" }]);
  });

  it("asks only the caller whose request the form belongs to, per thread", async () => {
    const fixture = makeFixture();
    const { service, connectionId } = await createService(fixture);
    const first = await bridgeFor(service, connectionId, "thread-a");
    const second = await bridgeFor(service, connectionId, "thread-b");
    const firstPerson = pendingPerson();
    const secondPerson = pendingPerson();

    const firstCall = remove(first, { onElicit: firstPerson.onElicit });
    const secondCall = remove(second, { onElicit: secondPerson.onElicit });
    await waitFor(() => firstPerson.asked.length === 1 && secondPerson.asked.length === 1, "both forms");
    firstPerson.asked[0]!.answer({ action: "accept", content: { confirm: true } });
    secondPerson.asked[0]!.answer({ action: "decline" });

    const firstOutcome = await firstCall;
    await expect(secondCall).resolves.toMatchObject({ removed: false });
    // Each thread has its own process, and so its own confirmation.
    expect(firstPerson.asked[0]!.params._meta?.["fixture/confirmation"]).toBe(firstOutcome.nonce);
    expect(secondPerson.asked[0]!.params._meta?.["fixture/confirmation"]).not.toBe(firstOutcome.nonce);
    expect(firstOutcome.removed).toBe(true);
  });

  it("fails closed when several requests share the session that asks", async () => {
    const fixture = makeFixture();
    const { service, connectionId } = await createService(fixture);
    const rpc = await bridgeFor(service, connectionId, "thread-a");
    const holding = vi.fn(async () => ({ action: "accept", content: { confirm: true } }));
    const removing = vi.fn(async () => ({ action: "accept", content: { confirm: true } }));

    const hold = rpc.request("tools/call", { name: "hold", arguments: { ms: 1_500 } },
      undefined, undefined, undefined, undefined, holding);
    await waitFor(() => readLog(fixture).some((entry) => entry.event === "call" && entry.name === "hold"), "the first call");
    await expect(remove(rpc, { onElicit: removing })).resolves.toMatchObject({ removed: false });
    await hold;

    expect(holding).not.toHaveBeenCalled();
    expect(removing).not.toHaveBeenCalled();
    expect(answers(fixture)[0]?.error?.code).toBe(-32601);
  });

  it("settles a pending form when the server exits, and never answers its replacement with it", async () => {
    const fixture = makeFixture();
    const { service, connectionId } = await createService(fixture);
    const rpc = await bridgeFor(service, connectionId, "thread-a");
    const stale = pendingPerson();

    const firstCall = remove(rpc, { onElicit: stale.onElicit });
    await waitFor(() => stale.asked.length === 1, "the first form");
    const [firstAsk] = readLog(fixture).filter((entry) => entry.event === "ask");
    process.kill(firstAsk!.pid, "SIGTERM");
    await expect(firstCall).rejects.toThrow();
    expect(stale.asked[0]!.signal.aborted).toBe(true);
    // The person answers the old card after the server has gone.
    stale.asked[0]!.answer({ action: "accept", content: { confirm: true } });

    const fresh = pendingPerson();
    const secondCall = remove(rpc, { onElicit: fresh.onElicit });
    await waitFor(() => fresh.asked.length === 1, "the replacement form");
    const secondAsk = readLog(fixture).filter((entry) => entry.event === "ask")[1]!;
    expect(secondAsk.pid).not.toBe(firstAsk!.pid);
    expect(fresh.asked[0]!.params._meta?.["fixture/confirmation"]).toBe(secondAsk.nonce);
    expect(secondAsk.nonce).not.toBe(firstAsk!.nonce);
    await new Promise((resolve) => setTimeout(resolve, 100));
    // The stale acceptance reached neither server.
    expect(answers(fixture)).toEqual([]);

    fresh.asked[0]!.answer({ action: "accept", content: { confirm: true } });
    await expect(secondCall).resolves.toEqual({ removed: true, nonce: secondAsk.nonce });
    expect(answers(fixture).map((entry) => [entry.pid, entry.nonce])).toEqual([[secondAsk.pid, secondAsk.nonce]]);
  });

  it("settles a pending form when the thread stops selecting the connection", async () => {
    const fixture = makeFixture();
    const { service, connectionId } = await createService(fixture);
    const rpc = await bridgeFor(service, connectionId, "thread-a");
    const person = pendingPerson();

    const call = remove(rpc, { onElicit: person.onElicit });
    await waitFor(() => person.asked.length === 1, "the form");
    await service.closeThreadSessions("thread-a", [connectionId]);

    await expect(call).rejects.toThrow();
    expect(person.asked[0]!.signal.aborted).toBe(true);
  });

  describe("fixed gateway tools", () => {
    const scopeKey = JSON.stringify(["gateway", "codex", "thread-g"]);

    async function gatewayRemove(
      service: McpConnectionGatewayService,
      connectionId: string,
      elicit?: ElicitationRoute,
    ): Promise<RemoveOutcome> {
      const signal = new AbortController().signal;
      const tools = await service.requestGatewayToolOperation({
        connectionId, scopeKey, operation: "gateway/tools/list", signal,
      }) as McpGatewayTool[];
      const tool = tools.find((entry) => entry.toolName === "remove")!;
      const result = await service.requestGatewayToolOperation({
        connectionId,
        scopeKey,
        operation: "gateway/tools/call",
        signal,
        invocation: {
          connectionId,
          serverName: tool.serverName,
          toolName: tool.toolName,
          schemaRevision: tool.schemaRevision,
          arguments: { path: "/fixture/old" },
        },
        ...(elicit ? { elicit } : {}),
      }) as { content: Array<{ text: string }> };
      return JSON.parse(result.content[0]!.text) as RemoveOutcome;
    }

    it("shows the form to the host and returns the person's answer", async () => {
      const fixture = makeFixture();
      const { service, connectionId } = await createService(fixture);
      const seen: ElicitRequestParams[] = [];

      const result = await gatewayRemove(service, connectionId, async (params) => {
        seen.push(params);
        return { action: "accept", content: { confirm: true } };
      });

      expect(seen[0]?.message).toBe("Remove /fixture/old? This cannot be undone.");
      expect(result.removed).toBe(true);
      expect(answers(fixture).map((entry) => entry.result)).toEqual([{ action: "accept", content: { confirm: true } }]);
    });

    it("fails closed when the host offers no one to ask", async () => {
      const fixture = makeFixture();
      const { service, connectionId } = await createService(fixture);

      const result = await gatewayRemove(service, connectionId);

      expect(result.removed).toBe(false);
      expect(answers(fixture)[0]?.error?.code).toBe(-32601);
    });

    it("cancels instead of delivering an answer given after the selection was revoked", async () => {
      const fixture = makeFixture();
      const { service, connectionId, selection } = await createService(fixture);
      const person = pendingPerson();

      const call = gatewayRemove(service, connectionId, person.onElicit);
      await waitFor(() => person.asked.length === 1, "the form");
      selection.ids = [];
      person.asked[0]!.answer({ action: "accept", content: { confirm: true } });

      await expect(call).resolves.toMatchObject({ removed: false });
      expect(answers(fixture).map((entry) => entry.result)).toEqual([{ action: "cancel" }]);
    });
  });
});
