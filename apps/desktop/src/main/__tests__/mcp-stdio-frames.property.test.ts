import fc from "fast-check";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import {
  McpStdioFrameReader,
  scanOversizedMessageEnvelope,
  type McpStdioFrame,
} from "../mcp-connections/mcp-stdio-frames";
import { McpStdioMessageTooLargeError } from "../mcp-connections/mcp-stdio-launch";
import { FakeMcpStdioChild, startFakeStdioTransport } from "./helpers/fake-mcp-stdio-child";

/*
 * Rule: whatever a local MCP server writes, reading its stdout never throws
 * into the main process. Every message within the limit is delivered intact
 * and in order; every message over it is skipped to its newline, and a
 * response among them fails exactly the request it answered, naming the
 * limit, while the connection stays up.
 */

const LIMIT = 256;
/** Past the reader's 4 KB ends, so ids are found across window edges too. */
const sizes = fc.oneof(fc.integer({ min: 0, max: LIMIT * 2 }), fc.integer({ min: 8 * 1024, max: 12 * 1024 }));
/** Text a blob or log line can hold, including what JSON escapes. */
const filler = (length: number): fc.Arbitrary<string> => fc
  .array(fc.constantFrom("A", "z", "9", "\"", "\\", "}", "{", ",", ":", "é", "\n", "\u0000"), {
    minLength: length,
    maxLength: length,
  })
  .map((chars) => chars.join(""));
const ids = fc.oneof(fc.integer({ min: -1000, max: 1_000_000 }), fc.string({ maxLength: 12 }));

/** Split bytes at the given fractions, as a pipe delivers them. */
function cut(bytes: Buffer, fractions: number[]): Buffer[] {
  const points = [...new Set(fractions.map((fraction) => Math.floor(fraction * bytes.length)))]
    .filter((point) => point > 0 && point < bytes.length)
    .sort((a, b) => a - b);
  const chunks: Buffer[] = [];
  let start = 0;
  for (const point of [...points, bytes.length]) {
    chunks.push(bytes.subarray(start, point));
    start = point;
  }
  return chunks;
}

const fractions = fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { maxLength: 30 });

describe("McpStdioFrameReader", () => {
  it("matches splitting on newlines, skips each line over the limit, and holds no more than the limit", () => {
    fc.assert(fc.property(
      fc.array(sizes.chain((size) => fc.string({ minLength: size, maxLength: size, unit: "grapheme" })
        .map((text) => text.replaceAll("\n", " "))), { minLength: 1, maxLength: 8 }),
      fractions,
      (lines, splits) => {
        const reader = new McpStdioFrameReader(LIMIT);
        const frames: McpStdioFrame[] = [];
        for (const chunk of cut(Buffer.from(lines.map((line) => `${line}\n`).join("")), splits)) {
          frames.push(...reader.push(chunk));
          expect(reader.bufferedBytes).toBeLessThanOrEqual(LIMIT);
        }
        expect(frames).toHaveLength(lines.length);
        frames.forEach((frame, index) => {
          const bytes = Buffer.byteLength(lines[index]!);
          if (bytes <= LIMIT) {
            expect(frame).toEqual({ kind: "line", text: lines[index]!.replace(/\r$/, "") });
          } else {
            expect(frame.kind).toBe("oversized");
            expect((frame as { bytes: number }).bytes).toBe(bytes);
          }
        });
      },
    ));
  });
});

describe("scanOversizedMessageEnvelope", () => {
  it("finds the top-level id at either end and never one the message does not have", () => {
    fc.assert(fc.property(
      fc.option(ids, { nil: undefined }),
      fc.boolean(),
      fc.integer({ min: 9 * 1024, max: 20 * 1024 }).chain(filler),
      ids,
      (id, idFirst, blob, nestedId) => {
        // A nested id sits right where a top-level one would be read.
        const result = { contents: [{ id: nestedId, blob }], id: nestedId };
        const message = id === undefined
          ? { result, jsonrpc: "2.0", nested: { id: nestedId } }
          : idFirst ? { jsonrpc: "2.0", id, result } : { result, jsonrpc: "2.0", id };
        const bytes = Buffer.from(JSON.stringify(message));
        const envelope = scanOversizedMessageEnvelope(
          bytes.subarray(0, 4096),
          bytes.subarray(bytes.length - 4096),
        );
        expect(envelope).toEqual(id === undefined ? { hasMethod: false } : { id, hasMethod: false });
      },
    ));
  });
});

describe("scanOversizedMessageEnvelope at the window edge", () => {
  it("never reads an id the 4 KB head window cut short", () => {
    fc.assert(fc.property(
      fc.integer({ min: 10_000, max: 99_999_999 }),
      fc.integer({ min: 0, max: 12 }),
      (id, shift) => {
        // Pad so the head window ends `shift` characters into `"id":<id>`.
        const prefix = "{\"jsonrpc\":\"2.0\",\"_meta\":{\"pad\":\"";
        const before = "\"},\"id\":";
        const pad = "x".repeat(4096 - prefix.length - before.length - shift);
        const bytes = Buffer.from(`${prefix}${pad}${before}${id},"result":{"blob":"${"A".repeat(9000)}"}}`);
        const envelope = scanOversizedMessageEnvelope(
          bytes.subarray(0, 4096),
          bytes.subarray(bytes.length - 4096),
        );
        expect([undefined, id]).toContain(envelope.id);
      },
    ));
  });
});

type ServerLine =
  | { kind: "response"; id: number; size: number; idFirst: boolean }
  | { kind: "notification"; size: number };

describe("OwnedStdioClientTransport over a misbehaving server (model)", () => {
  it("delivers what fits, fails exactly the oversized responses' requests, and never throws", async () => {
    await fc.assert(fc.asyncProperty(
      fc.integer({ min: 1, max: 6 }).chain((requests) => fc.tuple(
        fc.constant(requests),
        fc.shuffledSubarray([...Array(requests).keys()].map((index) => index + 1)),
        fc.array(sizes, { minLength: requests, maxLength: requests }),
        fc.array(fc.boolean(), { minLength: requests, maxLength: requests }),
        fc.array(sizes, { maxLength: 3 }),
      )),
      fractions,
      async ([requests, answered, responseSizes, idFirst, notificationSizes], splits) => {
        const child = new FakeMcpStdioChild();
        const transport = await startFakeStdioTransport(child, { maxMessageBytes: LIMIT });
        const delivered: JSONRPCMessage[] = [];
        const errors: Error[] = [];
        let closed = false;
        transport.onmessage = (message) => delivered.push(message);
        transport.onerror = (error) => errors.push(error);
        transport.onclose = () => { closed = true; };
        for (let id = 1; id <= requests; id += 1) {
          await transport.send({ jsonrpc: "2.0", id, method: "resources/read", params: { uri: `fixture://${id}` } });
        }

        // The server's lines, notifications interleaved with the answers.
        const script: ServerLine[] = answered.map((id) => ({
          kind: "response" as const, id, size: responseSizes[id - 1]!, idFirst: idFirst[id - 1]!,
        }));
        notificationSizes.forEach((size, index) => {
          script.splice((index * 2) % (script.length + 1), 0, { kind: "notification", size });
        });
        const written = script.map((line) => {
          const padding = "A".repeat(line.size);
          const message = line.kind === "notification"
            ? { jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: padding } }
            : line.idFirst
              ? { jsonrpc: "2.0", id: line.id, result: { contents: [{ uri: `fixture://${line.id}`, blob: padding }] } }
              : { result: { contents: [{ uri: `fixture://${line.id}`, blob: padding }] }, jsonrpc: "2.0", id: line.id };
          return { line, json: JSON.stringify(message) };
        });

        const bytes = Buffer.from(written.map(({ json }) => `${json}\n`).join(""));
        expect(() => child.emitStdout(...cut(bytes, splits))).not.toThrow();

        // The model: each line in order, delivered whole or settled by its size.
        const expected: JSONRPCMessage[] = [];
        let oversizedNotifications = 0;
        for (const { line, json } of written) {
          const fits = Buffer.byteLength(json) <= LIMIT;
          if (fits) expected.push(JSON.parse(json) as JSONRPCMessage);
          else if (line.kind === "notification") oversizedNotifications += 1;
          else {
            expected.push({
              jsonrpc: "2.0",
              id: line.id,
              error: expect.objectContaining({
                code: -32603,
                message: expect.stringContaining("limit for one message"),
                data: expect.objectContaining({ reason: "message_too_large", limitBytes: LIMIT }),
              }),
            } as unknown as JSONRPCMessage);
          }
        }
        expect(delivered).toEqual(expected);
        expect(errors.filter((error) => error instanceof McpStdioMessageTooLargeError)).toHaveLength(oversizedNotifications);
        expect(closed).toBe(false);
        await transport.close();
      },
    ), { numRuns: 60 });
  });
});
