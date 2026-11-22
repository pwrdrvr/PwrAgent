import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpError, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { MCP_STDIO_MAX_MESSAGE_BYTES } from "../mcp-connections/mcp-stdio-frames";
import { McpStdioMessageTooLargeError, type OwnedStdioClientTransport } from "../mcp-connections/mcp-stdio-launch";
import { createFakeStdioTransport, FakeMcpStdioChild } from "./helpers/fake-mcp-stdio-child";

/*
 * 2026-11-22: a PwrSnap full-render video, a ~14 MB MP4 returned as one
 * resources/read blob over the `pwrsnap-mcp` stdio relay, passed the SDK
 * ReadBuffer's 10 MB limit. Its throw escaped the stdout `data` listener as
 * an uncaught main-process exception and froze PwrAgent behind a modal.
 */

const RESOURCE_URI = "pwrsnap://sizzle/demo/full/1";
const CHUNK_BYTES = 64 * 1024;

type Pending = { id: string | number; method: string };

/** A server that answers the handshake and pings, and holds every other request. */
function fakeServer(): { child: FakeMcpStdioChild; held: Pending[] } {
  const held: Pending[] = [];
  const child = new FakeMcpStdioChild((message) => {
    if (!("method" in message) || !("id" in message)) return;
    const { id, method } = message;
    if (method === "initialize") {
      const params = message.params as { protocolVersion: string };
      queueMicrotask(() => child.reply({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params.protocolVersion,
          capabilities: { resources: {} },
          serverInfo: { name: "fixture-media", version: "1.0.0" },
        },
      }));
    } else if (method === "ping") {
      queueMicrotask(() => child.reply({ jsonrpc: "2.0", id, result: {} }));
    } else {
      held.push({ id, method });
    }
  });
  return { child, held };
}

/** A video read result `bytes` long, members in the given order, split as a pipe would. */
function videoResponse(id: string | number, bytes: number, order: "id-last" | "id-first" | "id-hidden"): Buffer[] {
  const result = { contents: [{ uri: RESOURCE_URI, mimeType: "video/mp4", blob: "A".repeat(bytes) }] };
  const message = order === "id-last"
    ? { result, jsonrpc: "2.0", id }
    : order === "id-first"
      ? { jsonrpc: "2.0", id, result }
      // Nothing after the blob is a top-level scalar, so neither end shows the id.
      : { result, id, _meta: { trace: { span: 1 } } };
  return split(Buffer.from(`${JSON.stringify(message)}\n`));
}

function split(bytes: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  for (let at = 0; at < bytes.length; at += CHUNK_BYTES) chunks.push(bytes.subarray(at, at + CHUNK_BYTES));
  return chunks;
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

const open: Array<{ client: Client; transport: OwnedStdioClientTransport }> = [];

async function connect(): Promise<{
  client: Client;
  transport: OwnedStdioClientTransport;
  child: FakeMcpStdioChild;
  held: Pending[];
  errors: Error[];
  closed: () => boolean;
}> {
  const { child, held } = fakeServer();
  const transport = createFakeStdioTransport(child);
  const client = new Client({ name: "oversized-test", version: "1.0.0" });
  await client.connect(transport);
  const errors: Error[] = [];
  let closed = false;
  client.onerror = (error) => errors.push(error);
  client.onclose = () => { closed = true; };
  open.push({ client, transport });
  return { client, transport, child, held, errors, closed: () => closed };
}

async function heldRequest(held: Pending[], method: string): Promise<Pending> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const found = held.find((request) => request.method === method && !(request as { taken?: boolean }).taken);
    if (found) {
      (found as { taken?: boolean }).taken = true;
      return found;
    }
    await settle();
  }
  throw new Error(`The server never received ${method}.`);
}

afterEach(async () => {
  for (const { client } of open.splice(0)) await client.close().catch(() => undefined);
});

describe("an oversized message from a local MCP server", () => {
  it("fails the read it answered with the limit named, without throwing into the main process", async () => {
    const { client, child, held, closed } = await connect();
    const read = client.readResource({ uri: RESOURCE_URI });
    const request = await heldRequest(held, "resources/read");

    // The incident: the SDK's TypeScript servers write the id after the result.
    expect(() => child.emitStdout(...videoResponse(request.id, 14 * 1024 * 1024, "id-last"))).not.toThrow();

    const error = await read.then(() => undefined, (rejection: unknown) => rejection);
    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe(-32603);
    expect((error as McpError).message).toContain("over PwrAgent's 10 MB limit for one message");
    expect((error as McpError).message).toContain("Ask the server for a smaller response");
    expect((error as McpError).data).toMatchObject({
      reason: "message_too_large",
      limitBytes: MCP_STDIO_MAX_MESSAGE_BYTES,
    });
    // The connection is still framed and still up.
    await expect(client.ping()).resolves.toEqual({});
    expect(closed()).toBe(false);
  });

  it("fails only the request it answered when the id comes first", async () => {
    const { client, child, held } = await connect();
    const big = client.readResource({ uri: RESOURCE_URI });
    const small = client.readResource({ uri: "pwrsnap://capture/1" });
    const bigRequest = await heldRequest(held, "resources/read");
    const smallRequest = await heldRequest(held, "resources/read");

    child.emitStdout(...videoResponse(bigRequest.id, MCP_STDIO_MAX_MESSAGE_BYTES + 1, "id-first"));
    child.reply({
      jsonrpc: "2.0",
      id: smallRequest.id,
      result: { contents: [{ uri: "pwrsnap://capture/1", text: "ok" }] },
    });

    await expect(big).rejects.toThrow(/limit for one message/);
    await expect(small).resolves.toEqual({ contents: [{ uri: "pwrsnap://capture/1", text: "ok" }] });
  });

  it("reads a message exactly at the limit", async () => {
    const { client, child, held } = await connect();
    const read = client.readResource({ uri: RESOURCE_URI });
    const request = await heldRequest(held, "resources/read");
    const envelope = JSON.stringify({ result: { contents: [{ uri: RESOURCE_URI, mimeType: "video/mp4", blob: "" }] }, jsonrpc: "2.0", id: request.id });

    child.emitStdout(...videoResponse(request.id, MCP_STDIO_MAX_MESSAGE_BYTES - Buffer.byteLength(envelope), "id-last"));

    const result = await read;
    expect((result.contents[0] as { blob: string }).blob).toHaveLength(MCP_STDIO_MAX_MESSAGE_BYTES - Buffer.byteLength(envelope));
  });

  it("fails every waiting request and closes the connection when the id cannot be read", async () => {
    const { client, child, held, errors, closed } = await connect();
    const first = client.readResource({ uri: RESOURCE_URI });
    const second = client.readResource({ uri: "pwrsnap://capture/1" });
    const firstRequest = await heldRequest(held, "resources/read");
    await heldRequest(held, "resources/read");

    expect(() => child.emitStdout(...videoResponse(firstRequest.id, MCP_STDIO_MAX_MESSAGE_BYTES + 1, "id-hidden"))).not.toThrow();

    await expect(first).rejects.toThrow(/limit for one message/);
    await expect(second).rejects.toThrow(/limit for one message/);
    expect(errors.some((error) => error instanceof McpStdioMessageTooLargeError)).toBe(true);
    await settle();
    expect(closed()).toBe(true);
  });

  it("drops an oversized notification, reports it, and keeps waiting requests", async () => {
    const { client, child, held, errors, closed } = await connect();
    const read = client.readResource({ uri: "pwrsnap://capture/1" });
    const request = await heldRequest(held, "resources/read");

    child.emitStdout(...split(Buffer.from(`${JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/message",
      params: { level: "info", data: "x".repeat(MCP_STDIO_MAX_MESSAGE_BYTES) },
    })}\n`)));
    child.reply({ jsonrpc: "2.0", id: request.id, result: { contents: [] } });

    await expect(read).resolves.toEqual({ contents: [] });
    const reported = errors.find((error) => error instanceof McpStdioMessageTooLargeError);
    expect(reported?.message).toMatch(/^The MCP server sent a 10\.0 MB message, over PwrAgent's 10 MB limit/);
    expect(closed()).toBe(false);
  });

  it("keeps reading after a line that is not JSON-RPC", async () => {
    const { client, child, held, errors } = await connect();
    const read = client.readResource({ uri: "pwrsnap://capture/1" });
    const request = await heldRequest(held, "resources/read");

    expect(() => child.emitStdout(Buffer.from("not json\n{\"jsonrpc\":\"1.0\"}\n"))).not.toThrow();
    child.reply({ jsonrpc: "2.0", id: request.id, result: { contents: [] } } satisfies JSONRPCMessage);

    await expect(read).resolves.toEqual({ contents: [] });
    expect(errors).toHaveLength(2);
  });
});
