import type { ServerNotification } from "@pwrdrvr/codex-app-server-protocol";
import type { ThreadRealtimeStartParams, ThreadRealtimeAppendTextParams } from "@pwrdrvr/codex-app-server-protocol/v2";
import type { NativeVoiceAction } from "../../shared/native-voice";
import { formatDynamicToolOutput } from "../../shared/tool-activity";
import { codexVersionFromUserAgent } from "./protocol-compatibility";

export type NativeVoiceNotification = Extract<ServerNotification, {
  method: `thread/realtime/${string}`;
}>;
/** A dynamic tool call that settled on some Codex thread. */
export type NativeVoiceToolCall = {
  threadId: string;
  tool: string;
  namespace?: string;
  /** The arguments Codex passed to the tool. */
  arguments?: unknown;
  /** The `DynamicToolCallResponse` returned to Codex. */
  response: unknown;
};
/** The lease keeps the selected App Server alive and its tool catalog attached. */
export type NativeVoiceBackend = {
  start: (params: ThreadRealtimeStartParams) => Promise<void>;
  stop: (threadId: string) => Promise<void>;
  text: (threadId: string, text: string, role?: ThreadRealtimeAppendTextParams["role"]) => Promise<void>;
  onEvent: (listener: (event: NativeVoiceNotification) => void) => () => void;
  onDisconnect: (listener: () => void) => () => void;
  onToolCall?: (listener: (call: NativeVoiceToolCall) => void) => () => void;
  release: () => void;
};

/**
 * Live voice needs Codex 0.159 or newer. The App Server's user agent leads
 * with the CLIENT's name, then Codex's version (`pwragent-desktop/0.159.0-
 * pwragent.1 ...`), so read the version the way the protocol gate does rather
 * than looking for a "codex" token. A build suffix is the same upstream
 * version and counts as it.
 */
export function supportsNativeVoice(userAgent?: string): boolean {
  const match = codexVersionFromUserAgent(userAgent)?.match(/^(\d+)\.(\d+)\./);
  return Boolean(match && (Number(match[1]) > 0 || Number(match[2]) >= 159));
}

const MARKDOWN_LINK_TITLE = /^\[([^\]]{1,200})\]\(/;
/**
 * A receipt carries the call's arguments and result so the panel can expand
 * it the way a thread's tool row expands. The panel keeps 20 receipts in
 * memory, so these bounds hold a session's receipts under a million characters.
 */
const RECEIPT_ARGUMENTS_MAX_CHARS = 4_000;
const RECEIPT_OUTPUT_MAX_CHARS = 48_000;

/**
 * Reduce a settled tool call to a receipt the operator can read at a glance.
 *
 * Reads only fields PwrAgent's own tools return (`threadLink`, `title`,
 * `disposition`, `queueStatus`, `instanceId`). A result it cannot parse still
 * yields the tool name and whether it succeeded, so the receipt never claims
 * more than the tool reported.
 */
export function describeNativeVoiceAction(call: NativeVoiceToolCall): NativeVoiceAction {
  const response = call.response as { success?: unknown; contentItems?: unknown } | undefined;
  const ok = response?.success === true;
  const action: NativeVoiceAction = { tool: call.tool, ok };
  if (call.namespace) action.namespace = call.namespace.slice(0, 80);
  const args = boundedArguments(call.arguments);
  if (args) action.arguments = args;
  const output = formatDynamicToolOutput(response?.contentItems);
  if (output) action.output = boundedOutput(output);
  const data = readJsonPayload(response?.contentItems);
  if (!data) return action;
  const link = typeof data.threadLink === "string" ? MARKDOWN_LINK_TITLE.exec(data.threadLink)?.[1] : undefined;
  const title = typeof data.title === "string" ? data.title : undefined;
  const target = link ?? title;
  if (target) action.target = target.slice(0, 120);
  if (typeof data.instanceId === "string") action.instance = data.instanceId.slice(0, 80);
  const outcome = typeof data.disposition === "string"
    ? data.disposition
    : data.queueStatus === "queued" ? "queued" : undefined;
  if (outcome) action.outcome = outcome.slice(0, 40);
  return action;
}

function boundedOutput(output: string): string {
  if (output.length <= RECEIPT_OUTPUT_MAX_CHARS) return output;
  return shrinkJsonOutput(output)
    ?? `${output.slice(0, RECEIPT_OUTPUT_MAX_CHARS)}\n… ${(output.length - RECEIPT_OUTPUT_MAX_CHARS).toLocaleString("en-US")} more characters`;
}

/**
 * An over-bound JSON result keeps its shape: the oldest items of its largest
 * list go first. A thread read keeps its title, link and newest messages and
 * still parses, so the panel can name the thread it read.
 */
function shrinkJsonOutput(text: string): string | undefined {
  let data: unknown;
  try { data = JSON.parse(text); } catch { return undefined; }
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const result = data as Record<string, unknown>;
  let omitted = 0;
  for (let pass = 0; pass < 32; pass++) {
    const serialized = JSON.stringify(omitted ? { ...result, receiptOmittedItems: omitted } : result);
    if (serialized.length <= RECEIPT_OUTPUT_MAX_CHARS) return serialized;
    const largest = largestArray(result, 0);
    if (!largest) return undefined;
    const excess = serialized.length - RECEIPT_OUTPUT_MAX_CHARS;
    const drop = Math.min(largest.array.length, Math.max(1, Math.ceil(largest.array.length * excess / largest.size)));
    largest.array.splice(0, drop);
    omitted += drop;
  }
  return undefined;
}

function largestArray(value: unknown, depth: number): { array: unknown[]; size: number } | undefined {
  if (depth > 4 || !value || typeof value !== "object") return undefined;
  let best: { array: unknown[]; size: number } | undefined;
  if (Array.isArray(value) && value.length) best = { array: value, size: JSON.stringify(value).length };
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const found = largestArray(child, depth + 1);
    if (found && (!best || found.size > best.size)) best = found;
  }
  return best;
}

/** Arguments are kept whole or not at all: a cut object would misstate the call. */
function boundedArguments(value: unknown): Record<string, unknown> | undefined {
  try {
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    if (!serialized || serialized.length > RECEIPT_ARGUMENTS_MAX_CHARS) return undefined;
    const parsed: unknown = JSON.parse(serialized);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function readJsonPayload(contentItems: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(contentItems)) return undefined;
  const first = contentItems[0] as { type?: unknown; text?: unknown } | undefined;
  if (first?.type !== "inputText" || typeof first.text !== "string" || first.text.length > 200_000) return undefined;
  try {
    const parsed: unknown = JSON.parse(first.text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}
