import { truncateRendererPayloadString } from "@pwragent/shared";

const TOOL_ACTIVITY_TITLE_MAX_CHARS = 160;

export function formatToolActivityTitle(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > TOOL_ACTIVITY_TITLE_MAX_CHARS
    ? `${normalized.slice(0, TOOL_ACTIVITY_TITLE_MAX_CHARS - 3)}...`
    : normalized;
}

export function formatToolIdentifier(
  serverName: string | undefined,
  toolName: string,
): string {
  return serverName ? `${serverName}/${toolName}` : toolName;
}

export function formatToolInvocation(
  identifier: string,
  args: Record<string, unknown> | undefined,
): string {
  if (!args || Object.keys(args).length === 0) {
    return identifier;
  }
  try {
    return truncateRendererPayloadString(
      `${identifier}\n${JSON.stringify(args, null, 2)}`,
      `${identifier} invocation`,
    );
  } catch {
    return identifier;
  }
}

export function formatMcpToolOutput(params: {
  error: unknown;
  result: unknown;
}): string | undefined {
  const parts: string[] = [];
  const error = formatResultValue(params.error);
  if (error) {
    parts.push(`Error\n${error}`);
  }

  const result = asRecord(params.result);
  const structuredContent = formatResultValue(
    result?.structuredContent ?? result?.structured_content,
  );
  if (structuredContent) {
    parts.push(`Structured result\n${structuredContent}`);
  }

  const content = Array.isArray(result?.content) ? result.content : [];
  for (const value of content) {
    const block = asRecord(value);
    const blockType = readString(block, "type")?.replace(/[-_\s]/g, "").toLowerCase();
    if (blockType === "image" || blockType === "audio") {
      const mimeType = readString(block, "mimeType") ?? readString(block, "mime_type");
      parts.push(`[${mimeType ?? blockType} ${blockType} result]`);
      continue;
    }
    const text = readString(block, "text");
    const formatted = text ?? formatResultValue(value);
    if (formatted) {
      parts.push(formatted);
    }
  }

  if (parts.length === 0 && result) {
    const fallback = formatResultValue(result);
    if (fallback) {
      parts.push(fallback);
    }
  }

  const output = parts.join("\n\n");
  return output
    ? truncateRendererPayloadString(output, "MCP tool output")
    : undefined;
}

export function formatDynamicToolOutput(contentItems: unknown): string | undefined {
  if (!Array.isArray(contentItems)) {
    return undefined;
  }
  const parts: string[] = [];
  for (const value of contentItems) {
    const item = asRecord(value);
    const itemType = readString(item, "type")?.replace(/[-_\s]/g, "").toLowerCase();
    if (itemType === "inputimage") {
      parts.push("[image result]");
      continue;
    }
    const text = readString(item, "text");
    const formatted = text ?? formatResultValue(value);
    if (formatted) {
      parts.push(formatted);
    }
  }
  const output = parts.join("\n\n");
  return output
    ? truncateRendererPayloadString(output, "dynamic tool output")
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readString(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function formatResultValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.trim() || undefined;
  }
  if (value === null || value === undefined) {
    return undefined;
  }
  try {
    const serialized = JSON.stringify(value, null, 2);
    return serialized && serialized !== "{}" && serialized !== "[]"
      ? serialized
      : undefined;
  } catch {
    return undefined;
  }
}
