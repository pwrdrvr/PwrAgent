import { pwrSnapResourceLinkImageParts } from "@pwragent/shared/transcript-image-sources";
import type { AppServerThreadImagePart } from "@pwragent/shared/contracts/normalized-app-server";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function unwrapAcpContentBlocks(value: unknown): unknown[] {
  if (!value) {
    return [];
  }
  const items = Array.isArray(value) ? value : [value];
  const blocks: unknown[] = [];
  for (const item of items) {
    const record = asRecord(item);
    if (record?.type === "content" && record.content !== undefined) {
      if (Array.isArray(record.content)) {
        blocks.push(...record.content);
      } else {
        blocks.push(record.content);
      }
      continue;
    }
    blocks.push(item);
  }
  return blocks;
}

function imagePartFromAcpBlock(
  value: unknown,
  fallbackAlt?: string,
): AppServerThreadImagePart | undefined {
  const block = asRecord(value);
  if (!block || block.type !== "image") {
    return undefined;
  }
  const mimeType = readString(block, "mimeType") ?? readString(block, "mime_type");
  const data = typeof block.data === "string" ? block.data.trim() : undefined;
  const alt = readString(block, "alt") ?? readString(block, "name") ?? fallbackAlt;
  if (mimeType?.toLowerCase().startsWith("image/") && data) {
    return {
      type: "image",
      url: `data:${mimeType};base64,${data}`,
      ...(alt ? { alt } : {}),
    };
  }
  const uri = readString(block, "uri") ?? readString(block, "url");
  if (uri && /^(?:data:image\/|https?:\/\/)/iu.test(uri)) {
    return {
      type: "image",
      url: uri,
      ...(alt ? { alt } : {}),
    };
  }
  return undefined;
}

/**
 * Extract image parts from an ACP content block or block list (direct image
 * blocks and PwrSnap MCP resource links / JSON envelopes).
 */
export function extractAcpContentImageParts(
  content: unknown,
  fallbackAlt?: string,
): AppServerThreadImagePart[] {
  const blocks = unwrapAcpContentBlocks(content);
  if (blocks.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  const parts: AppServerThreadImagePart[] = [];
  const push = (part: AppServerThreadImagePart): void => {
    if (seen.has(part.url)) {
      return;
    }
    seen.add(part.url);
    parts.push(part);
  };

  for (const part of pwrSnapResourceLinkImageParts({ content: blocks })) {
    push(part);
  }
  for (const block of blocks) {
    const image = imagePartFromAcpBlock(block, fallbackAlt);
    if (image) {
      push(image);
    }
  }
  return parts;
}

/**
 * Extract image parts returned by an ACP tool call or tool call update,
 * checking `content` and `rawOutput`.
 */
export function extractAcpToolImageParts(
  update: Record<string, unknown>,
  fallbackAlt?: string,
): AppServerThreadImagePart[] {
  const seen = new Set<string>();
  const parts: AppServerThreadImagePart[] = [];
  const pushAll = (incoming: readonly AppServerThreadImagePart[]): void => {
    for (const part of incoming) {
      if (seen.has(part.url)) {
        continue;
      }
      seen.add(part.url);
      parts.push(part);
    }
  };

  pushAll(extractAcpContentImageParts(update.content, fallbackAlt));

  const rawOutput = update.rawOutput;
  if (typeof rawOutput === "string") {
    pushAll(pwrSnapResourceLinkImageParts({ content: [{ type: "text", text: rawOutput }] }));
  } else {
    const rawRecord = asRecord(rawOutput);
    if (rawRecord) {
      pushAll(extractAcpContentImageParts(rawRecord.content ?? rawRecord, fallbackAlt));
    }
  }

  return parts;
}
