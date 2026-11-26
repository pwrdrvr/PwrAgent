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

const MAX_ACP_CONTENT_UNWRAP_DEPTH = 8;

function unwrapAcpContentBlocks(value: unknown): unknown[] {
  if (!value) {
    return [];
  }
  const stack: Array<{ value: unknown; depth: number }> = [];
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      stack.push({ value: value[index], depth: 0 });
    }
  } else {
    stack.push({ value, depth: 0 });
  }
  const blocks: unknown[] = [];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const record = asRecord(current.value);
    if (
      record?.type === "content"
      && record.content !== undefined
      && current.depth < MAX_ACP_CONTENT_UNWRAP_DEPTH
    ) {
      const nextDepth = current.depth + 1;
      if (Array.isArray(record.content)) {
        for (let index = record.content.length - 1; index >= 0; index -= 1) {
          stack.push({ value: record.content[index], depth: nextDepth });
        }
      } else {
        stack.push({ value: record.content, depth: nextDepth });
      }
      continue;
    }
    blocks.push(current.value);
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
  // Hot path: streaming ACP text deltas arrive as a single `{ type: "text", text }`
  // record. Skip allocation unless the text could hold a PwrSnap media link.
  if (content !== null && typeof content === "object" && !Array.isArray(content)) {
    const record = content as Record<string, unknown>;
    if (
      record.type === "text"
      && typeof record.text === "string"
      && !record.text.includes("pwrsnap:")
      && !record.text.includes("127.0.0.1:51729")
    ) {
      return [];
    }
  }
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
  } else if (Array.isArray(rawOutput)) {
    pushAll(extractAcpContentImageParts(rawOutput, fallbackAlt));
  } else {
    const rawRecord = asRecord(rawOutput);
    if (rawRecord) {
      pushAll(extractAcpContentImageParts(rawRecord.content ?? rawRecord, fallbackAlt));
    }
  }

  return parts;
}
