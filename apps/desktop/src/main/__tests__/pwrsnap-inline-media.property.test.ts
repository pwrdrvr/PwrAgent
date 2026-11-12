import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";
import fc from "fast-check";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentEvent } from "@pwragent/shared";
import { ConnectionRpcClient } from "../mcp-connections/mcp-connection-rpc-client";
import { readPwrSnapImageContents, readPwrSnapImageLinks } from "../mcp-connections/pwrsnap-media-links";
import { materializeTranscriptImageEventForRenderer } from "../transcript-images";
import { buildLiveToolDetails } from "../../renderer/src/features/thread-detail/live-transcript-activity";
import { buildMcpGatewayToolDefinitions } from "../agent-tools/pwragent-mcp-gateway-tools";
import type { McpGatewayToolService } from "../mcp-connections/mcp-gateway-tool-service";

const uri = "pwrsnap://capture/synthetic/composite";
const link = { type: "resource_link", uri, name: "Generated pixels", mimeType: "image/png" };
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Generated PNG and its uncompressed pixels are independent byte/decoding oracles. */
function png(seed: number): { bytes: Buffer; pixels: Buffer } {
  const width = 320;
  const height = 320;
  const pixels = Buffer.alloc((width * 3 + 1) * height);
  let state = seed || 1;
  for (let i = 0; i < pixels.length; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    pixels[i] = i % (width * 3 + 1) === 0 ? 0 : state & 255;
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([size, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return { pixels, bytes: Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0)),
  ]) };
}

function assertPng(actual: Buffer, expected: ReturnType<typeof png>): void {
  expect(actual.byteLength).toBe(expected.bytes.byteLength);
  expect(createHash("sha256").update(actual).digest("hex"))
    .toBe(createHash("sha256").update(expected.bytes).digest("hex"));
  expect(actual.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  const compressed: Buffer[] = [];
  for (let offset = 8; offset < actual.length;) {
    const length = actual.readUInt32BE(offset);
    const body = actual.subarray(offset + 4, offset + 8 + length);
    expect(actual.readUInt32BE(offset + 8 + length)).toBe(crc32(body));
    if (body.subarray(0, 4).toString() === "IDAT") compressed.push(body.subarray(4));
    offset += length + 12;
  }
  expect(inflateSync(Buffer.concat(compressed))).toEqual(expected.pixels);
}

it("preserves generated PNG bytes through resources/read over native socket or Windows pipe", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pa-media-"));
  directories.push(dir);
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\pa-media-${randomUUID()}` : path.join(dir, "m.sock");
  const image = png(12345);
  expect(image.bytes.byteLength).toBeGreaterThan(265777);
  const blob = image.bytes.toString("base64");
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    socket.once("data", (request: string) => {
      expect(JSON.parse(request)).toMatchObject({ token: "synthetic-grant", op: "resources/read", params: { uri } });
      const response = JSON.stringify({ ok: true, result: { contents: [{ uri, mimeType: "image/png", blob }] } }) + "\n";
      // Split inside the blob, as real native stream frames may arrive.
      socket.write(response.slice(0, 431));
      socket.end(response.slice(431));
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(endpoint, resolve); });
  try {
    const result = await new ConnectionRpcClient(endpoint, "synthetic-grant").request("resources/read", { uri });
    const read = readPwrSnapImageContents(result, uri);
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error("Resource read failed");
    expect(read.dataBase64).toBe(blob);
    assertPng(Buffer.from(read.dataBase64, "base64"), image);
    console.info("Synthetic native resources/read oracle", JSON.stringify({
      bytes: image.bytes.byteLength, base64Chars: blob.length,
      sha256: createHash("sha256").update(image.bytes).digest("hex"),
    }));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

it("preserves resource link identity across an MCP text wrapper and duplicate blocks", () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 6 }), (copies) => {
    const wrapped = { content: [{ type: "text", text: JSON.stringify({ content: Array(copies).fill(link) }) }] };
    expect([...new Set(readPwrSnapImageLinks(wrapped))]).toEqual([uri]);
    const details = buildLiveToolDetails({ type: "mcpToolCall", id: "capture", tool: "capture_resource", result: wrapped });
    expect(details[0]?.images).toEqual([{ type: "image", url: uri, alt: link.name }]);
  }));
});

it("projects a fresh direct resource_link into the live activity row", () => {
  const details = buildLiveToolDetails({ type: "mcpToolCall", id: "capture", tool: "capture_resource", result: { content: [link, link] } });
  expect(details[0]?.images).toEqual([{ type: "image", url: uri, alt: link.name }]);
});

it("uses the actual call_mcp_tool text envelope without returning a provider image input", async () => {
  const call = vi.fn(async () => ({
    source: { connectionId: "pwrsnap", serverName: "PwrSnap", toolName: "capture_resource", schemaRevision: "fixture" },
    result: { content: [link] },
  }));
  const definition = buildMcpGatewayToolDefinitions({ call } as unknown as McpGatewayToolService)
    .find((tool) => tool.name === "call_mcp_tool")!;
  const dispatched = await definition.dispatch({
    connectionId: "pwrsnap", toolName: "capture_resource", schemaRevision: "fixture", arguments: {},
  }, { backend: "codex", threadId: "synthetic-thread", turnId: "turn", transport: "codex_dynamic_tool" });
  expect(dispatched.ok).toBe(true);
  expect(dispatched.contentItems?.map((item) => item.type)).toEqual(["inputText"]);
  expect(dispatched.mcpResult?.content).toEqual([link]);
  const item = { type: "dynamicToolCall", id: "gateway-call", tool: "call_mcp_tool", contentItems: dispatched.contentItems };
  expect(buildLiveToolDetails(item)[0]?.images).toEqual([{ type: "image", url: uri, alt: link.name }]);
  const dir = await mkdtemp(path.join(os.tmpdir(), "pa-gateway-"));
  directories.push(dir);
  const image = png(101);
  const readPwrSnapMedia = vi.fn(async () => ({ ok: true as const, mimeType: "image/png", dataBase64: image.bytes.toString("base64") }));
  const event: AgentEvent = { backend: "codex", notification: { method: "item/completed", params: {
    threadId: "synthetic-thread", turnId: "turn", item,
  } } };
  const materialized = await materializeTranscriptImageEventForRenderer(event, { readPwrSnapMedia, resolveRoot: () => dir });
  expect(materialized.rendererImageParts).toHaveLength(1);
  expect(materialized.notification).toBe(event.notification);
  expect(dispatched.contentItems?.map((input) => input.type)).toEqual(["inputText"]);
  expect(readPwrSnapMedia).toHaveBeenCalledExactlyOnceWith({ backend: "codex", threadId: "synthetic-thread", uri });
  // Code Mode's text(await tools.call_mcp_tool(...)) retains the MCP result
  // inside one text block. Use the real dispatch result, not a guessed schema.
  expect(readPwrSnapImageLinks({ content: [{ type: "text", text: JSON.stringify(dispatched.mcpResult) }] })).toEqual([uri]);
});

it("does not infer authority from prose, deep JSON, foreign gateway sources or model messages", async () => {
  const text = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
  for (const result of [
    text(text({ content: [link] })),
    text({ source: { connectionId: "other-server" }, result: { content: [link] } }),
    { content: [{ type: "text", text: "Image: " + JSON.stringify({ content: [link] }) }] },
    { content: [{ ...link, uri: "file:///tmp/untrusted.png" }, { ...link, uri: "https://example.test/picture.png" }] },
  ]) {
    expect(readPwrSnapImageLinks(result)).toEqual([]);
  }
  const readPwrSnapMedia = vi.fn();
  const event: AgentEvent = { backend: "codex", notification: { method: "item/completed", params: {
    threadId: "synthetic-thread", turnId: "turn", item: { type: "agentMessage", id: "model", text: JSON.stringify({ content: [link] }) },
  } } };
  await materializeTranscriptImageEventForRenderer(event, { readPwrSnapMedia });
  expect(readPwrSnapMedia).not.toHaveBeenCalled();
});

it("preserves canonical binary resources for generated bytes and refuses malformed base64", () => {
  fc.assert(fc.property(fc.uint8Array({ minLength: 1, maxLength: 512 }), (bytes) => {
    const blob = Buffer.from(bytes).toString("base64");
    const read = readPwrSnapImageContents({ contents: [{ uri, mimeType: "image/png", blob }] }, uri);
    expect(read.ok).toBe(true);
    if (read.ok) expect(Buffer.from(read.dataBase64, "base64")).toEqual(Buffer.from(bytes));
  }));
  for (const blob of ["A", "AA", "AAA", "AB==", "AAB=", "AAAA====", "AA==\n", "AA … AA=="]) {
    expect(readPwrSnapImageContents({ contents: [{ uri, mimeType: "image/png", blob }] }, uri).ok).toBe(false);
  }
});

it("materializes fresh direct and wrapped MCP links once without adding model image inputs", async () => {
  const image = png(42);
  for (const wrap of [false, true]) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pa-inline-"));
    directories.push(dir);
    const result = { content: [link, link] };
    const event: AgentEvent = { backend: "codex", notification: { method: "item/completed", params: {
      threadId: "synthetic-thread", turnId: "synthetic-turn", item: {
        type: "mcpToolCall", id: "capture", tool: "capture_resource",
        result: wrap ? { content: [{ type: "text", text: JSON.stringify(result) }] } : result,
      },
    } } };
    const readPwrSnapMedia = vi.fn(async () => ({ ok: true as const, mimeType: "image/png", dataBase64: image.bytes.toString("base64") }));
    const deps = { readPwrSnapMedia, resolveRoot: () => dir };
    const materialized = await materializeTranscriptImageEventForRenderer(event, deps);
    expect(materialized.rendererImageParts).toHaveLength(1);
    const url = new URL(materialized.rendererImageParts![0]!.url);
    const localPath = fileURLToPath(decodeURIComponent(url.pathname.slice(1)));
    assertPng(await readFile(localPath), image);
    expect(materialized.notification).toBe(event.notification);
    expect(readPwrSnapMedia).toHaveBeenCalledOnce();
    const repeated = await materializeTranscriptImageEventForRenderer(event, deps);
    expect(repeated.rendererImageParts).toEqual(materialized.rendererImageParts);
    expect(readPwrSnapMedia).toHaveBeenCalledOnce();
  }
});

it("rejects text-clipped binary resources rather than caching plausible corrupt images", () => {
  const blob = png(37).bytes.toString("base64");
  fc.assert(fc.property(fc.integer({ min: 20, max: blob.length - 20 }), (offset) => {
    const clipped = blob.slice(0, offset) + " … " + blob.slice(offset + 10);
    expect(readPwrSnapImageContents({ contents: [{ uri, mimeType: "image/png", blob: clipped }] }, uri).ok).toBe(false);
  }), { numRuns: 10 });
});
