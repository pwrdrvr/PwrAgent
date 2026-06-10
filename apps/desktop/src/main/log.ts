import electronLog from "electron-log/main.js";
import { appendAppLogEntry } from "./app-logs";
import type { ProfileBootDecision } from "./profile";

let initialized = false;
let stdioErrorHandlersInstalled = false;
let debugCollectionEnabled = false;
const MAX_COMPACT_STRING_LENGTH = 320;
const MAX_COMPACT_FIELDS = 24;
const MAX_COMPACT_DEPTH = 2;

type ElectronLogHook = (typeof electronLog.hooks)[number];
type ElectronLogMessage = Parameters<ElectronLogHook>[0];
type StdioError = Error & {
  code?: unknown;
};

const electronLogConsoleTransport = electronLog.transports?.console;

if (process.env.VITEST === "true" && electronLogConsoleTransport) {
  electronLogConsoleTransport.level = false;
}

function isClosedStdioError(error: unknown): error is StdioError {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const code = (error as StdioError).code;
  return code === "EPIPE" || code === "ERR_STREAM_DESTROYED";
}

function disableConsoleTransport(): void {
  electronLog.transports.console.level = false;
}

function rethrowUnexpectedStdioError(error: unknown): void {
  queueMicrotask(() => {
    throw error;
  });
}

function handleStdioError(error: unknown): void {
  if (isClosedStdioError(error)) {
    disableConsoleTransport();
    return;
  }

  rethrowUnexpectedStdioError(error);
}

function installStdioErrorHandlers(): void {
  if (stdioErrorHandlersInstalled) {
    return;
  }

  stdioErrorHandlersInstalled = true;
  process.stdout.on("error", handleStdioError);
  process.stderr.on("error", handleStdioError);
}

function guardConsoleTransport(): void {
  const transport = electronLog.transports.console;
  const writeFn = transport.writeFn;

  transport.writeFn = (options) => {
    if (transport.level === false) {
      return;
    }

    try {
      writeFn(options);
    } catch (error) {
      if (isClosedStdioError(error)) {
        disableConsoleTransport();
        return;
      }

      throw error;
    }
  };
}

export function initializeMainLogger(options?: { profileName?: string }): void {
  if (initialized) {
    return;
  }

  initialized = true;
  installStdioErrorHandlers();
  guardConsoleTransport();
  if (options?.profileName) {
    electronLog.transports.file.fileName = resolveMainLogFileNameForProfile(
      options.profileName,
    );
  }
  electronLog.transports.file.level = debugCollectionEnabled ? "debug" : "info";
  electronLog.initialize();
  electronLog.scope.labelPadding = false;
  electronLog.hooks.push((
    message: ElectronLogMessage,
    _transport: Parameters<ElectronLogHook>[1],
    transportName: Parameters<ElectronLogHook>[2],
  ) => {
    const compacted: ElectronLogMessage = {
      ...message,
      data: compactStructuredLogData(message.data),
    };
    if (transportName === "file") {
      appendAppLogEntry({
        timestamp: message.date.getTime(),
        level: String(message.level),
        scope: message.scope,
        line: formatAppLogLine(compacted),
      });
    }
    return compacted;
  });
}

export function getMainLogger(scope: string) {
  return electronLog.scope(scope);
}

export function resolveMainLogProfileName(
  decision: ProfileBootDecision,
): string {
  switch (decision.kind) {
    case "open":
      return decision.profileName;
    case "missing-named-profile":
      return decision.requestedName;
    case "missing-default-profile":
      return decision.configuredName;
    case "no-profile-configured":
      return "bootstrap";
  }
}

export function resolveMainLogFileNameForProfile(profileName: string): string {
  return `profile-${profileName}.main.log`;
}

export function getMainLogFilePath(): string | undefined {
  try {
    return electronLog.transports?.file?.getFile().path;
  } catch {
    return undefined;
  }
}

export function isMainLogDebugCollectionEnabled(): boolean {
  return debugCollectionEnabled;
}

export function setMainLogDebugCollectionEnabled(enabled: boolean): void {
  debugCollectionEnabled = enabled;
  electronLog.transports.file.level = enabled ? "debug" : "info";
}

type CompactField = {
  key: string;
  value: string;
};

export function formatAppLogLine(message: ElectronLogMessage): string {
  const timestamp = formatLogTimestamp(message.date);
  const level = String(message.level).padEnd(5, " ");
  const scope = message.scope ? ` (${message.scope})` : "";
  const text = message.data.map(formatLogTextPart).join(" ");
  return `[${timestamp}] [${level}]${scope} ${text}`.trimEnd();
}

function formatLogTimestamp(date: Date): string {
  const pad = (value: number, width = 2): string =>
    String(value).padStart(width, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

function formatLogTextPart(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Error) {
    return value.stack ?? value.message;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return String(value);
  }
  if (value === undefined) {
    return "undefined";
  }
  return JSON.stringify(value) ?? String(value);
}

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
