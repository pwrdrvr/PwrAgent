/**
 * Newline-delimited MCP stdio framing with a per-message size limit.
 *
 * The SDK's `ReadBuffer` throws from `append` once its buffer passes its
 * limit, and a throw from a stream `data` listener is an uncaught exception
 * in the Electron main process: a modal error and a frozen app. This reader
 * never throws. A line over the limit is skipped up to its newline, so the
 * stream stays framed, and is reported with its size and the two ends of it
 * that name its JSON-RPC id.
 */

/**
 * The largest single message PwrAgent reads from a local MCP server.
 *
 * This is the MCP TypeScript SDK's stdio default, kept on purpose. An agent
 * reads PwrAgent's bridge over stdio as well, and one using that SDK has the
 * same limit; a larger message would not reach it, and there it would close
 * the agent's whole PwrAgent connection instead of failing one request.
 */
export const MCP_STDIO_MAX_MESSAGE_BYTES = 10 * 1024 * 1024;

/** How much of each end of an oversized line is kept to find its id. */
const ENVELOPE_WINDOW_BYTES = 4 * 1024;

export type McpStdioFrame =
  | { kind: "line"; text: string }
  | { kind: "oversized"; bytes: number; head: Buffer; tail: Buffer };

export class McpStdioFrameReader {
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  /** Set while skipping a line that is already over the limit. */
  private oversized?: { bytes: number; head: Buffer; tail: Buffer };

  constructor(readonly maxMessageBytes = MCP_STDIO_MAX_MESSAGE_BYTES) {}

  /** Bytes held for the line still being read; never above the limit. */
  get bufferedBytes(): number {
    return this.pendingBytes;
  }

  /** Every line the chunk completes, in order. */
  push(chunk: Buffer): McpStdioFrame[] {
    const frames: McpStdioFrame[] = [];
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(0x0a, start);
      this.take(chunk.subarray(start, newline === -1 ? chunk.length : newline));
      if (newline === -1) break;
      frames.push(this.endLine());
      start = newline + 1;
    }
    return frames;
  }

  clear(): void {
    this.pending = [];
    this.pendingBytes = 0;
    this.oversized = undefined;
  }

  private take(piece: Buffer): void {
    if (piece.length === 0) return;
    if (this.oversized) {
      this.oversized.bytes += piece.length;
      this.oversized.tail = lastBytes([this.oversized.tail, piece]);
      return;
    }
    if (this.pendingBytes + piece.length <= this.maxMessageBytes) {
      this.pending.push(piece);
      this.pendingBytes += piece.length;
      return;
    }
    const parts = [...this.pending, piece];
    const bytes = this.pendingBytes + piece.length;
    this.oversized = {
      bytes,
      head: Buffer.concat(parts, Math.min(bytes, ENVELOPE_WINDOW_BYTES)),
      tail: lastBytes(parts),
    };
    this.pending = [];
    this.pendingBytes = 0;
  }

  private endLine(): McpStdioFrame {
    const oversized = this.oversized;
    if (oversized) {
      this.oversized = undefined;
      return { kind: "oversized", ...oversized };
    }
    const text = Buffer.concat(this.pending, this.pendingBytes).toString("utf8").replace(/\r$/, "");
    this.pending = [];
    this.pendingBytes = 0;
    return { kind: "line", text };
  }
}

/** A copy of the last window of bytes across `parts`, so no chunk is retained. */
function lastBytes(parts: Buffer[]): Buffer {
  const kept: Buffer[] = [];
  let length = 0;
  for (let index = parts.length - 1; index >= 0 && length < ENVELOPE_WINDOW_BYTES; index -= 1) {
    const part = parts[index]!;
    const take = Math.min(part.length, ENVELOPE_WINDOW_BYTES - length);
    kept.unshift(part.subarray(part.length - take));
    length += take;
  }
  return Buffer.concat(kept, length);
}

export type OversizedMessageEnvelope = {
  /** The top-level JSON-RPC id, when one of the kept ends shows it. */
  id?: string | number;
  /** A top-level `method` was seen: a request or notification, not a response. */
  hasMethod: boolean;
};

/**
 * The top-level members of an oversized JSON-RPC message that its two kept
 * ends show. Servers put the id first (`{"jsonrpc","id","result"}`) or, as
 * the TypeScript SDK does, last (`{"result",...,"jsonrpc","id"}`); the large
 * value sits between. Anything that does not scan cleanly is left unknown.
 */
export function scanOversizedMessageEnvelope(head: Buffer, tail: Buffer): OversizedMessageEnvelope {
  const members = [
    ...scanLeadingMembers(head.toString("utf8")),
    ...scanTrailingMembers(tail.toString("utf8")),
  ];
  let id: string | number | undefined;
  let hasMethod = false;
  for (const [key, value] of members) {
    if (key === "method") hasMethod = true;
    if (key === "id" && (typeof value === "string" || (typeof value === "number" && Number.isFinite(value)))) {
      id = value;
    }
  }
  return { ...(id === undefined ? {} : { id }), hasMethod };
}

type Member = [key: string, value: unknown];
const SCALAR = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/;
const SCALAR_END = /(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)$/;

/** Members read forward from the opening brace until the text runs out. */
function scanLeadingMembers(text: string): Member[] {
  const members: Member[] = [];
  let at = skipSpace(text, 0);
  if (text[at] !== "{") return members;
  at += 1;
  for (;;) {
    at = skipSpace(text, at);
    const keyEnd = stringEnd(text, at);
    if (keyEnd === undefined) return members;
    const key = parseJson(text.slice(at, keyEnd));
    at = skipSpace(text, keyEnd);
    if (typeof key !== "string" || text[at] !== ":") return members;
    at = skipSpace(text, at + 1);
    const valueEnd = valueEndAt(text, at);
    if (valueEnd === undefined) return members;
    members.push([key, parseJson(text.slice(at, valueEnd))]);
    at = skipSpace(text, valueEnd);
    if (text[at] !== ",") return members;
    at += 1;
  }
}

/** Members read backward from the closing brace; only scalar values. */
function scanTrailingMembers(text: string): Member[] {
  const members: Member[] = [];
  let at = skipSpaceBack(text, text.length);
  if (text[at - 1] !== "}") return members;
  at -= 1;
  for (;;) {
    at = skipSpaceBack(text, at);
    const valueStart = scalarStartBefore(text, at);
    if (valueStart === undefined) return members;
    const value = parseJson(text.slice(valueStart, at));
    at = skipSpaceBack(text, valueStart);
    if (text[at - 1] !== ":") return members;
    at = skipSpaceBack(text, at - 1);
    const keyStart = stringStartBefore(text, at);
    if (keyStart === undefined) return members;
    const key = parseJson(text.slice(keyStart, at));
    if (typeof key !== "string") return members;
    members.push([key, value]);
    at = skipSpaceBack(text, keyStart);
    if (text[at - 1] !== ",") return members;
    at -= 1;
  }
}

function skipSpace(text: string, at: number): number {
  while (at < text.length && /\s/.test(text[at]!)) at += 1;
  return at;
}

function skipSpaceBack(text: string, at: number): number {
  while (at > 0 && /\s/.test(text[at - 1]!)) at -= 1;
  return at;
}

/** The index after the string that starts at `at`. */
function stringEnd(text: string, at: number): number | undefined {
  if (text[at] !== "\"") return undefined;
  for (let index = at + 1; index < text.length; index += 1) {
    if (text[index] === "\\") index += 1;
    else if (text[index] === "\"") return index + 1;
  }
  return undefined;
}

/** The start of the string that ends just before `at`, if its quote is not escaped. */
function stringStartBefore(text: string, at: number): number | undefined {
  if (text[at - 1] !== "\"") return undefined;
  for (let index = at - 2; index >= 0; index -= 1) {
    if (text[index] !== "\"") continue;
    let slashes = 0;
    while (index - slashes - 1 >= 0 && text[index - slashes - 1] === "\\") slashes += 1;
    // A run reaching the start of the window could be longer than it shows.
    if (index - slashes === 0 && slashes > 0) return undefined;
    if (slashes % 2 === 0) return index;
  }
  return undefined;
}

function scalarStartBefore(text: string, at: number): number | undefined {
  const quoted = stringStartBefore(text, at);
  if (quoted !== undefined) return quoted;
  const match = SCALAR_END.exec(text.slice(Math.max(0, at - 64), at));
  return match ? at - match[0].length : undefined;
}

/** The index after the JSON value that starts at `at`, if it ends in the text. */
function valueEndAt(text: string, at: number): number | undefined {
  if (text[at] === "\"") return stringEnd(text, at);
  if (text[at] !== "{" && text[at] !== "[") {
    const match = SCALAR.exec(text.slice(at, at + 64));
    return match ? at + match[0].length : undefined;
  }
  let depth = 0;
  for (let index = at; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\"") {
      const end = stringEnd(text, index);
      if (end === undefined) return undefined;
      index = end - 1;
    } else if (char === "{" || char === "[") {
      depth += 1;
    } else if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** The operator- and agent-facing reason an oversized message was dropped. */
export function describeOversizedMcpMessage(bytes: number, limitBytes: number): string {
  return `The MCP server sent a ${formatMegabytes(bytes)} message, over PwrAgent's `
    + `${formatMegabytes(limitBytes)} limit for one message. Ask the server for a smaller response.`;
}

function formatMegabytes(bytes: number): string {
  const megabytes = bytes / (1024 * 1024);
  if (megabytes >= 1) return `${Number.isInteger(megabytes) ? megabytes : megabytes.toFixed(1)} MB`;
  return `${bytes} byte${bytes === 1 ? "" : "s"}`;
}
