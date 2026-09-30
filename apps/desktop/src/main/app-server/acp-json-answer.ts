/**
 * The JSON object in an ACP agent's answer. ACP cannot constrain a reply to
 * a schema, so an answer can arrive fenced, wrapped in a sentence, or with
 * raw newlines inside its strings. `undefined` when no JSON is there; the
 * caller validates the shape.
 */
export function parseAcpJsonAnswer(text: string): unknown | undefined {
  const trimmed = stripMarkdownFence(text.trim());
  if (!trimmed) {
    return undefined;
  }

  const jsonObject = extractJsonObject(trimmed);
  const parsed =
    tryParseJson(trimmed) ??
    tryParseJson(escapeNewlinesInsideJsonStrings(trimmed)) ??
    tryParseJson(jsonObject) ??
    tryParseJson(escapeNewlinesInsideJsonStrings(jsonObject));
  return parsed ? parsed : undefined;
}

function stripMarkdownFence(text: string): string {
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fence ? fence[1]?.trim() ?? "" : text;
}

function extractJsonObject(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return "";
  }
  return text.slice(start, end + 1);
}

function tryParseJson(text: string): unknown | undefined {
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function escapeNewlinesInsideJsonStrings(text: string): string {
  let escaped = "";
  let inString = false;
  let escapedPrevious = false;

  for (const char of text) {
    if (inString && (char === "\n" || char === "\r")) {
      if (!escaped.endsWith(" ")) {
        escaped += " ";
      }
      escapedPrevious = false;
      continue;
    }
    escaped += char;
    if (escapedPrevious) {
      escapedPrevious = false;
      continue;
    }
    if (char === "\\") {
      escapedPrevious = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
    }
  }

  return escaped;
}
