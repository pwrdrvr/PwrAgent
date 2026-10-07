import type {
  DesktopLogsContextLines,
  DesktopLogsSearchMode,
} from "@pwragent/shared";
import type { AppLogEntry } from "../../../../shared/app-metadata";

export const MAX_RENDERED_LOG_ENTRIES = 5000;

export type LogLevel = "error" | "warn" | "info" | "debug" | "trace" | "verbose";
export type LogLevelFilter = "error" | "warn" | "info" | "debug";

export type LogLinePartTone =
  | "timestamp"
  | "level-debug"
  | "level-error"
  | "level-info"
  | "level-warn"
  | "scope";

export type LogSearchTokenKind = "scope" | "thread";

/** A `scope:` or `thread:` filter chip in the search field. */
export type LogSearchToken = {
  kind: LogSearchTokenKind;
  value: string;
};

export type LogSearch = {
  text: string;
  tokens: LogSearchToken[];
};

export type LogLinePart = {
  text: string;
  tone?: LogLinePartTone;
  /** Clicking this part adds the token to the search. */
  token?: LogSearchToken;
  /** A text match for the current search. */
  match?: boolean;
};

export type LogDisplayRow =
  | {
      kind: "line";
      entry: AppLogEntry;
      /** Matches every search criterion. */
      match: boolean;
      /** Shown only as context around a match, or from an expanded gap. */
      context: boolean;
    }
  | {
      kind: "gap";
      key: string;
      hiddenCount: number;
    }
  | { kind: "mark" };

export type LogMark = {
  /** The newest sequence when the mark was dropped; the mark sits after it. */
  afterSequence: number;
  at: number;
};

export type LogLineSelection = {
  anchor: number;
  focus: number;
  /** The selection keeps growing as new lines arrive. */
  followsTail: boolean;
  sinceMark: boolean;
};

// ---------------------------------------------------------------------------
// Ring buffer
// ---------------------------------------------------------------------------

export type RenderedLogEntryBuffer = {
  slots: Array<AppLogEntry | undefined>;
  oldestEntryIndex: number;
  entryCount: number;
};

export function appendRenderedLogEntry(
  buffer: RenderedLogEntryBuffer,
  entry: AppLogEntry,
): boolean {
  if (buffer.entryCount < MAX_RENDERED_LOG_ENTRIES) {
    const writeIndex =
      (buffer.oldestEntryIndex + buffer.entryCount) % buffer.slots.length;
    buffer.slots[writeIndex] = entry;
    buffer.entryCount += 1;
    return false;
  }

  buffer.slots[buffer.oldestEntryIndex] = entry;
  buffer.oldestEntryIndex = (buffer.oldestEntryIndex + 1) % buffer.slots.length;
  return true;
}

export function createRenderedLogEntryBuffer(
  entries: AppLogEntry[] = [],
): RenderedLogEntryBuffer {
  const buffer: RenderedLogEntryBuffer = {
    slots: new Array<AppLogEntry | undefined>(MAX_RENDERED_LOG_ENTRIES),
    oldestEntryIndex: 0,
    entryCount: 0,
  };
  for (const entry of entries.slice(-MAX_RENDERED_LOG_ENTRIES)) {
    appendRenderedLogEntry(buffer, entry);
  }
  return buffer;
}

export function orderedRenderedLogEntries(
  buffer: RenderedLogEntryBuffer,
): AppLogEntry[] {
  const ordered: AppLogEntry[] = [];
  for (let offset = 0; offset < buffer.entryCount; offset += 1) {
    const entry =
      buffer.slots[(buffer.oldestEntryIndex + offset) % buffer.slots.length];
    if (entry) {
      ordered.push(entry);
    }
  }
  return ordered;
}

// ---------------------------------------------------------------------------
// Levels
// ---------------------------------------------------------------------------

export function normalizeLogLevel(levelToken: string): LogLevel | undefined {
  const value = levelToken.replace(/[[\]\s]/g, "").toLowerCase();
  if (
    value === "error"
    || value === "warn"
    || value === "info"
    || value === "debug"
    || value === "trace"
    || value === "verbose"
  ) {
    return value;
  }
  return undefined;
}

export function shouldShowLogEntry(
  entry: AppLogEntry,
  selectedLevels: readonly LogLevelFilter[],
): boolean {
  const level = normalizeLogLevel(entry.level);
  if (!level) {
    return selectedLevels.includes("info");
  }
  if (level === "trace" || level === "verbose") {
    return selectedLevels.includes("debug");
  }
  return selectedLevels.includes(level);
}

export function countLogLevels(
  entries: readonly AppLogEntry[],
): { error: number; warn: number } {
  let error = 0;
  let warn = 0;
  for (const entry of entries) {
    const level = normalizeLogLevel(entry.level);
    if (level === "error") error += 1;
    else if (level === "warn") warn += 1;
  }
  return { error, warn };
}

function toneForLogLevel(level: LogLevel | undefined): LogLinePartTone | undefined {
  if (level === "error") return "level-error";
  if (level === "warn") return "level-warn";
  if (level === "info") return "level-info";
  if (level === "debug" || level === "trace" || level === "verbose") {
    return "level-debug";
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Tokenizing
// ---------------------------------------------------------------------------

const LOG_PREFIX_PATTERN =
  /^(\[[^\]]+\])(\s+)(\[[^\]]+\])(\s+)(\([^)]+\))(\s*)([\s\S]*)$/;
const THREAD_ID_PATTERN = /threadId=([A-Za-z0-9_-]+)/g;

/** `(pwragent:codex-client)` → `codex-client`. */
export function scopeTokenValue(scope: string): string {
  return scope
    .replace(/^\(|\)$/g, "")
    .replace(/^pwragent:/, "")
    .trim();
}

export function tokenizeLogLine(line: string): {
  level?: LogLevel;
  scope?: string;
  parts: LogLinePart[];
} {
  const match = line.match(LOG_PREFIX_PATTERN);
  if (!match) {
    return { parts: tokenizeMessage(line) };
  }

  const level = normalizeLogLevel(match[3]);
  const scope = scopeTokenValue(match[5]);
  const parts: LogLinePart[] = [
    { text: match[1], tone: "timestamp" },
    { text: match[2] },
    { text: match[3], tone: toneForLogLevel(level) },
    { text: match[4] },
    {
      text: match[5],
      tone: "scope",
      ...(scope ? { token: { kind: "scope", value: scope } } : {}),
    },
    { text: match[6] },
    ...tokenizeMessage(match[7]),
  ];
  return {
    level,
    scope,
    parts: parts.filter((part) => part.text.length > 0),
  };
}

/** Split `threadId=<id>` values out of a message so they can be clicked. */
function tokenizeMessage(message: string): LogLinePart[] {
  const parts: LogLinePart[] = [];
  let cursor = 0;
  for (const found of message.matchAll(THREAD_ID_PATTERN)) {
    const valueStart = (found.index ?? 0) + "threadId=".length;
    if (valueStart > cursor) {
      parts.push({ text: message.slice(cursor, valueStart) });
    }
    parts.push({
      text: found[1],
      token: { kind: "thread", value: found[1] },
    });
    cursor = valueStart + found[1].length;
  }
  if (cursor < message.length || parts.length === 0) {
    parts.push({ text: message.slice(cursor) });
  }
  return parts;
}

const tokenizedLineCache = new WeakMap<
  AppLogEntry,
  ReturnType<typeof tokenizeLogLine>
>();

/** Tokenize once per entry; entries are immutable once received. */
export function tokenizedLogEntry(
  entry: AppLogEntry,
): ReturnType<typeof tokenizeLogLine> {
  let tokenized = tokenizedLineCache.get(entry);
  if (!tokenized) {
    tokenized = tokenizeLogLine(entry.line);
    tokenizedLineCache.set(entry, tokenized);
  }
  return tokenized;
}

/** Split each part around case-insensitive matches of `query`. */
export function highlightLogLineParts(
  parts: readonly LogLinePart[],
  query: string,
): LogLinePart[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return [...parts];
  }
  const highlighted: LogLinePart[] = [];
  for (const part of parts) {
    const lower = part.text.toLowerCase();
    let cursor = 0;
    let foundAt = lower.indexOf(normalizedQuery, cursor);
    if (foundAt === -1) {
      highlighted.push(part);
      continue;
    }
    while (foundAt !== -1) {
      if (foundAt > cursor) {
        highlighted.push({ ...part, text: part.text.slice(cursor, foundAt) });
      }
      const end = foundAt + normalizedQuery.length;
      highlighted.push({ ...part, text: part.text.slice(foundAt, end), match: true });
      cursor = end;
      foundAt = lower.indexOf(normalizedQuery, cursor);
    }
    if (cursor < part.text.length) {
      highlighted.push({ ...part, text: part.text.slice(cursor) });
    }
  }
  return highlighted;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export function hasLogSearchCriteria(search: LogSearch): boolean {
  return search.text.trim().length > 0 || search.tokens.length > 0;
}

export function logSearchTokenLabel(token: LogSearchToken): string {
  return token.kind === "thread" ? shortThreadId(token.value) : token.value;
}

function shortThreadId(value: string): string {
  return value.length > 12 ? value.slice(0, 8) : value;
}

export function addLogSearchToken(
  tokens: readonly LogSearchToken[],
  token: LogSearchToken,
): LogSearchToken[] {
  const exists = tokens.some(
    (existing) => existing.kind === token.kind && existing.value === token.value,
  );
  return exists ? [...tokens] : [...tokens, token];
}

/**
 * `scope:codex-client ` typed into the field becomes a token once a space
 * follows it. Returns the remaining text and the token, or undefined.
 */
export function extractTypedLogSearchToken(
  input: string,
): { text: string; token: LogSearchToken } | undefined {
  const match = input.match(/(^|\s)(scope|thread):(\S+)\s$/);
  if (!match || match.index === undefined) {
    return undefined;
  }
  const kind = match[2] as LogSearchTokenKind;
  const value = kind === "scope" ? scopeTokenValue(match[3]) : match[3];
  if (!value) {
    return undefined;
  }
  return {
    text: input.slice(0, match.index + match[1].length),
    token: { kind, value },
  };
}

export function logEntryMatchesSearch(
  entry: AppLogEntry,
  search: LogSearch,
): boolean {
  const text = search.text.trim().toLowerCase();
  if (text && !entry.line.toLowerCase().includes(text)) {
    return false;
  }
  if (search.tokens.length === 0) {
    return true;
  }
  const tokenized = tokenizedLogEntry(entry);
  const scope = entry.scope ? scopeTokenValue(entry.scope) : tokenized.scope;
  return search.tokens.every((token) => {
    if (token.kind === "scope") {
      return scope?.toLowerCase() === token.value.toLowerCase();
    }
    return entry.line.includes(`threadId=${token.value}`);
  });
}

// ---------------------------------------------------------------------------
// Display rows
// ---------------------------------------------------------------------------

export function logGapKey(firstHiddenSequence: number): string {
  return `gap-${firstHiddenSequence}`;
}

/**
 * The rows the viewport shows, in order. With search criteria in Filter mode,
 * only matches (plus `contextLines` around each) stay; the lines between
 * become a gap row unless that gap has been expanded. A mark becomes its own
 * row after the line it was dropped on.
 */
export function buildLogDisplayRows(params: {
  entries: readonly AppLogEntry[];
  search: LogSearch;
  mode: DesktopLogsSearchMode;
  contextLines: DesktopLogsContextLines;
  expandedGaps: ReadonlySet<string>;
  mark?: LogMark;
}): { rows: LogDisplayRow[]; matchSequences: number[] } {
  const { entries, search } = params;
  const searching = hasLogSearchCriteria(search);
  const matches = entries.map((entry) =>
    searching ? logEntryMatchesSearch(entry, search) : false,
  );
  const matchSequences = entries
    .filter((_, index) => matches[index])
    .map((entry) => entry.sequence);

  const lineRows: LogDisplayRow[] = [];
  if (!searching || params.mode === "highlight") {
    entries.forEach((entry, index) => {
      lineRows.push({ kind: "line", entry, match: matches[index], context: false });
    });
  } else {
    const keep = new Array<boolean>(entries.length).fill(false);
    matches.forEach((matched, index) => {
      if (!matched) return;
      const from = Math.max(0, index - params.contextLines);
      const to = Math.min(entries.length - 1, index + params.contextLines);
      for (let cursor = from; cursor <= to; cursor += 1) {
        keep[cursor] = true;
      }
    });
    let index = 0;
    while (index < entries.length) {
      if (keep[index]) {
        lineRows.push({
          kind: "line",
          entry: entries[index],
          match: matches[index],
          context: !matches[index],
        });
        index += 1;
        continue;
      }
      const start = index;
      while (index < entries.length && !keep[index]) {
        index += 1;
      }
      const key = logGapKey(entries[start].sequence);
      if (params.expandedGaps.has(key)) {
        for (let cursor = start; cursor < index; cursor += 1) {
          lineRows.push({
            kind: "line",
            entry: entries[cursor],
            match: false,
            context: true,
          });
        }
      } else {
        lineRows.push({ kind: "gap", key, hiddenCount: index - start });
      }
    }
  }

  return {
    rows: params.mark ? insertMarkRow(lineRows, params.mark) : lineRows,
    matchSequences,
  };
}

function insertMarkRow(rows: LogDisplayRow[], mark: LogMark): LogDisplayRow[] {
  const at = rows.findIndex(
    (row) => row.kind === "line" && row.entry.sequence > mark.afterSequence,
  );
  const withMark = [...rows];
  withMark.splice(at === -1 ? rows.length : at, 0, { kind: "mark" });
  return withMark;
}

export function displayedLogEntries(rows: readonly LogDisplayRow[]): AppLogEntry[] {
  const entries: AppLogEntry[] = [];
  for (const row of rows) {
    if (row.kind === "line") entries.push(row.entry);
  }
  return entries;
}

/** The displayed entries a selection covers, oldest first. */
export function selectedLogEntries(
  rows: readonly LogDisplayRow[],
  selection: LogLineSelection | undefined,
): AppLogEntry[] {
  if (!selection) return [];
  const low = Math.min(selection.anchor, selection.focus);
  const high = selection.followsTail
    ? Number.POSITIVE_INFINITY
    : Math.max(selection.anchor, selection.focus);
  return displayedLogEntries(rows).filter(
    (entry) => entry.sequence >= low && entry.sequence <= high,
  );
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

const LEVEL_LABELS: Record<LogLevelFilter, string> = {
  error: "Error",
  warn: "Warning",
  info: "Info",
  debug: "Debug",
};

export function formatLogCount(count: number): string {
  return count.toLocaleString("en-US");
}

/**
 * What the selection bar copies. Without diagnostics it is the lines alone.
 * With them, the troubleshooting block Copy Diagnostics Info writes comes
 * first, then this instance, the line range and the filters in force.
 */
export function buildLogCopyText(params: {
  entries: readonly AppLogEntry[];
  totalLoaded: number;
  levels: readonly LogLevelFilter[];
  search: LogSearch;
  mode: DesktopLogsSearchMode;
  contextLines: DesktopLogsContextLines;
  diagnostics?: string;
  instanceReference?: string;
}): string {
  const lines = params.entries.map((entry) => entry.line).join("\n");
  if (params.diagnostics === undefined) {
    return lines;
  }
  const first = params.entries[0]?.sequence;
  const last = params.entries.at(-1)?.sequence;
  const range = first === last ? `${first}` : `${first}–${last}`;
  const levels = (Object.keys(LEVEL_LABELS) as LogLevelFilter[])
    .filter((level) => params.levels.includes(level))
    .map((level) => LEVEL_LABELS[level])
    .join(", ");
  const header = [
    params.diagnostics,
    ...(params.instanceReference
      ? [`PwrAgent instance: ${params.instanceReference}`]
      : []),
    `Log lines: ${range} (${formatLogCount(params.entries.length)} of ${formatLogCount(params.totalLoaded)} loaded; levels: ${levels || "none"})`,
  ];
  if (hasLogSearchCriteria(params.search)) {
    const criteria = [
      ...(params.search.text.trim() ? [`"${params.search.text.trim()}"`] : []),
      ...params.search.tokens.map((token) => `${token.kind}:${token.value}`),
    ].join(" ");
    const context = params.mode === "filter" && params.contextLines > 0
      ? `, context ±${params.contextLines}`
      : "";
    header.push(`Log search: ${criteria} (${params.mode}${context})`);
  }
  return `${header.join("\n")}\n\n${lines}`;
}
