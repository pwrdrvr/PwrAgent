import type { AppServerThreadImagePart } from "./contracts/normalized-app-server";

// This package compiles without DOM or Node types. Every runtime it ships to
// (Electron main, renderer, Node tests) has the WHATWG URL global.
type ParsedUrl = {
  protocol: string;
  host: string;
  origin: string;
  pathname: string;
  username: string;
  password: string;
};
declare const URL: new (input: string) => ParsedUrl;

/** The largest transcript image PwrAgent copies, decoded. */
export const MAX_TRANSCRIPT_IMAGE_BYTES = 64 * 1024 * 1024;

const PWRSNAP_RESOURCE_SCHEME = "pwrsnap:";
const MAX_PWRSNAP_RESOURCE_URI_LENGTH = 2048;
const LEGACY_PWRSNAP_MEDIA_ORIGIN = "http://127.0.0.1:51729";
const PWRSNAP_IMAGE_UNAVAILABLE = "PwrSnap image unavailable.";

/**
 * Presentation hints from an MCP result, never authority to read a resource.
 * Code Mode can print a CallToolResult as one JSON text block; the gateway's
 * text result instead wraps it in { source, result }. Accept those two known
 * shapes at one level only. Do not scan arbitrary prose or recurse through
 * model-authored objects. The owner still requires the originating live grant.
 */
export function pwrSnapResourceLinkImageParts(result: unknown): AppServerThreadImagePart[] {
  const record = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown> : undefined;
  const content = record(result)?.content;
  if (!Array.isArray(content)) return [];
  const parts = new Map<string, AppServerThreadImagePart>();
  const readLink = (value: unknown): void => {
    const block = record(value);
    if (block?.type !== "resource_link" || typeof block.uri !== "string"
      || typeof block.mimeType !== "string" || !block.mimeType.toLowerCase().startsWith("image/")
      || !(isPwrSnapResourceUri(block.uri) || isLegacyPwrSnapMediaUrl(block.uri))) return;
    const alt = typeof block.name === "string" ? block.name
      : typeof block.title === "string" ? block.title : undefined;
    if (!parts.has(block.uri)) parts.set(block.uri, { type: "image", url: block.uri, ...(alt ? { alt } : {}) });
  };
  for (const value of content) {
    readLink(value);
    const block = record(value);
    if (block?.type !== "text" || typeof block.text !== "string" || block.text.length > 1024 * 1024) continue;
    let parsed: Record<string, unknown> | undefined;
    try { parsed = record(JSON.parse(block.text)); } catch { continue; }
    const source = record(parsed?.source);
    const nested = source?.connectionId === "pwrsnap" ? record(parsed?.result) : parsed;
    if (Array.isArray(nested?.content)) nested.content.forEach(readLink);
  }
  return [...parts.values()];
}

/** Native MCP and PwrAgent's actual dynamic call_mcp_tool text envelope. */
export function pwrSnapToolImageParts(item: Record<string, unknown>): AppServerThreadImagePart[] {
  if (item.type === "mcpToolCall") return pwrSnapResourceLinkImageParts(item.result);
  if (item.type !== "dynamicToolCall") return [];
  const content = item.contentItems ?? item.content_items;
  if (!Array.isArray(content)) return [];
  return pwrSnapResourceLinkImageParts({ content: content.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const block = value as Record<string, unknown>;
    return block.type === "inputText" ? [{ type: "text", text: block.text }] : [];
  }) });
}

/**
 * PwrSnap 1.3 returns media as canonical `pwrsnap://` MCP resource links.
 * Their bytes come only from `resources/read` on the live session that
 * returned them, so this check says only what a link claims to be. Whether
 * PwrAgent may read it is the MCP gateway's decision.
 */
export function isPwrSnapResourceUri(value: string): boolean {
  if (value.length > MAX_PWRSNAP_RESOURCE_URI_LENGTH) return false;
  let parsed: ParsedUrl;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === PWRSNAP_RESOURCE_SCHEME
    && Boolean(parsed.host)
    && !parsed.username
    && !parsed.password;
}

/**
 * PwrSnap before 1.3 served signed media from a fixed loopback port. That
 * listener no longer exists, so these URLs are never requested: transcripts
 * that hold one show the image as unavailable.
 */
export function isLegacyPwrSnapMediaUrl(value: string): boolean {
  let parsed: ParsedUrl;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.origin === LEGACY_PWRSNAP_MEDIA_ORIGIN && parsed.pathname === "/media";
}

/**
 * Why an image part must not be loaded, if it must not. The owner sets a
 * reason when it could not obtain the bytes. A PwrSnap link that reaches a
 * renderer without one, such as from an older federation peer, is never
 * loadable there either: only the owner's MCP session can read it, and the
 * loopback listener is gone.
 */
export function transcriptImageUnavailableReason(
  image: Pick<AppServerThreadImagePart, "url" | "unavailableReason">,
): string | undefined {
  if (image.unavailableReason) return image.unavailableReason;
  return isPwrSnapResourceUri(image.url) || isLegacyPwrSnapMediaUrl(image.url)
    ? PWRSNAP_IMAGE_UNAVAILABLE
    : undefined;
}
