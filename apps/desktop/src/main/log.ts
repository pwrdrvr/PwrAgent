import electronLog from "electron-log/main.js";

let initialized = false;
const MAX_COMPACT_STRING_LENGTH = 320;
const MAX_COMPACT_FIELDS = 24;
const MAX_COMPACT_DEPTH = 2;

export function initializeMainLogger(): void {
  if (initialized) {
    return;
  }

  initialized = true;
  electronLog.initialize();
  electronLog.scope.labelPadding = false;
  electronLog.hooks.push((message) => ({
    ...message,
    data: compactStructuredLogData(message.data),
  }));
}

export function getMainLogger(scope: string) {
  return electronLog.scope(scope);
}

type CompactField = {
  key: string;
  value: string;
};

export function compactStructuredLogData(data: unknown[]): unknown[] {
  if (data.length < 2 || typeof data[0] !== "string") {
    return data;
  }

  const compacted: string[] = [];
  const passthrough: unknown[] = [];
  let hadStructuredPayload = false;
  for (const item of data.slice(1)) {
    if (isPlainObject(item)) {
      hadStructuredPayload = true;
      const compactedFields = compactObjectFields(item);
      if (compactedFields) {
        compacted.push(compactedFields);
      }
    } else {
      passthrough.push(item);
    }
  }

  return compacted.length > 0
    ? [`${data[0]} ${compacted.filter(Boolean).join(" ")}`, ...passthrough]
    : hadStructuredPayload
      ? [data[0], ...passthrough]
    : data;
}

function compactObjectFields(value: Record<string, unknown>): string {
  const fields: CompactField[] = [];
  collectCompactFields(value, "", fields, 0);
  const suffix = fields.length >= MAX_COMPACT_FIELDS ? " ..." : "";
  return `${fields.slice(0, MAX_COMPACT_FIELDS).map((field) => `${field.key}=${field.value}`).join(" ")}${suffix}`;
}

function collectCompactFields(
  value: Record<string, unknown>,
  prefix: string,
  fields: CompactField[],
  depth: number,
): void {
  if (fields.length >= MAX_COMPACT_FIELDS) {
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    if (fields.length >= MAX_COMPACT_FIELDS) {
      return;
    }
    if (child === undefined) {
      continue;
    }
    const fieldKey = prefix ? `${prefix}.${key}` : key;
    if (
      isPlainObject(child) &&
      depth < MAX_COMPACT_DEPTH &&
      Object.keys(child).length <= 8
    ) {
      collectCompactFields(child, fieldKey, fields, depth + 1);
      continue;
    }
    fields.push({
      key: fieldKey,
      value: compactLogValue(child),
    });
  }
}

function compactLogValue(value: unknown): string {
  if (typeof value === "string") {
    return quoteIfNeeded(value);
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return String(value);
  }
  if (value === undefined) {
    return "undefined";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => compactLogValue(item)).join(",")}]`;
  }
  if (value instanceof Error) {
    return quoteIfNeeded(value.stack ?? value.message);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return quoteIfNeeded(JSON.stringify(value) ?? String(value));
}

function quoteIfNeeded(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  const truncated =
    compact.length > MAX_COMPACT_STRING_LENGTH
      ? `${compact.slice(0, MAX_COMPACT_STRING_LENGTH - 3)}...`
      : compact;
  if (/^[A-Za-z0-9_./:@+-]+$/.test(truncated)) {
    return truncated;
  }
  return JSON.stringify(truncated);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
