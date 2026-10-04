import type { ServerNotification } from "@pwrdrvr/codex-app-server-protocol";
import type { ThreadRealtimeStartParams, ThreadRealtimeAppendTextParams } from "@pwrdrvr/codex-app-server-protocol/v2";
import type { NativeVoiceAction } from "../../shared/native-voice";
import { codexVersionFromUserAgent } from "./protocol-compatibility";

export type NativeVoiceNotification = Extract<ServerNotification, {
  method: `thread/realtime/${string}`;
}>;
/** A dynamic tool call that settled on some Codex thread. */
export type NativeVoiceToolCall = {
  threadId: string;
  tool: string;
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
