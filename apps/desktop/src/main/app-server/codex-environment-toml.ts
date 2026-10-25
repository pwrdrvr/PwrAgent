/**
 * The subset of TOML that `.codex/environments/*.toml` files use, read with
 * line positions so the environment editor can change one value without
 * touching the rest of the file.
 *
 * Supported: bare keys, `[table]` and `[[array]]` headers, basic and literal
 * strings (single and multi-line), integers, decimals, and booleans. Anything
 * else is an error carrying its 1-based line, so a caller can refuse to edit a
 * file it cannot reproduce.
 */

export type CodexTomlScalar = string | number | boolean;

export type CodexTomlEntry = {
  key: string;
  value: CodexTomlScalar;
  /** 0-based line of the key. */
  startLine: number;
  /** 0-based line after the value's last line. */
  endLine: number;
  /** Text after a single-line value, such as ` # comment`. */
  trailing: string;
};

export type CodexTomlHeader = {
  kind: "table" | "array";
  name: string;
  line: number;
};

export type CodexTomlBlock = {
  /** Absent for the top-level keys before the first header. */
  header?: CodexTomlHeader;
  /** First line, including comment lines directly above the header. */
  start: number;
  /** Line after the block, including its trailing blank and comment lines. */
  end: number;
  entries: CodexTomlEntry[];
};

export type CodexTomlDocument = {
  /** Lines without their line endings. A final "" marks a trailing newline. */
  lines: string[];
  eol: "\n" | "\r\n";
  bom: boolean;
  blocks: CodexTomlBlock[];
};

export class CodexEnvironmentTomlError extends Error {
  readonly line: number;
  /** The message without the file path, for display. */
  readonly reason: string;

  constructor(reason: string, line: number, filePath: string) {
    super(`${reason} on line ${line} in ${filePath}`);
    this.name = "CodexEnvironmentTomlError";
    this.line = line;
    this.reason = reason;
  }
}

const KEY_LINE = /^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.*)$/;
const SECTION_LINE = /^\s*\[\s*([^[\]]+?)\s*\]\s*(?:#.*)?$/;
const ARRAY_SECTION_LINE = /^\s*\[\[\s*([^[\]]+?)\s*\]\]\s*(?:#.*)?$/;
const NUMBER = /^-?\d+(?:\.\d+)?$/;

export function tokenizeCodexEnvironmentToml(
  source: string,
  filePath = "<inline>",
): CodexTomlDocument {
  const bom = source.startsWith("﻿");
  const body = bom ? source.slice(1) : source;
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  const lines = body.split(/\r?\n/);
  const blocks: CodexTomlBlock[] = [];
  let current: CodexTomlBlock = { start: 0, end: 0, entries: [] };
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    if (!stripComment(line).trim()) {
      i += 1;
      continue;
    }

    const arraySection = ARRAY_SECTION_LINE.exec(line);
    const section = arraySection ? undefined : SECTION_LINE.exec(line);
    if (arraySection || section) {
      const floor = Math.max(
        current.header ? current.header.line + 1 : 0,
        current.entries.at(-1)?.endLine ?? 0,
      );
      let start = i;
      while (start - 1 >= floor && isCommentLine(lines[start - 1]!)) {
        start -= 1;
      }
      current.end = start;
      blocks.push(current);
      current = {
        header: {
          kind: arraySection ? "array" : "table",
          name: (arraySection ?? section)![1]!.trim(),
          line: i,
        },
        start,
        end: start,
        entries: [],
      };
      i += 1;
      continue;
    }

    const keyMatch = KEY_LINE.exec(line);
    if (!keyMatch) {
      throw new CodexEnvironmentTomlError("Invalid Codex environment TOML", i + 1, filePath);
    }
    const parsed = parseValue(lines, i, line.length - keyMatch[2]!.length, filePath);
    current.entries.push({
      key: keyMatch[1]!,
      value: parsed.value,
      startLine: i,
      endLine: parsed.nextLine,
      trailing: parsed.trailing,
    });
    i = parsed.nextLine;
  }

  current.end = lines.length;
  blocks.push(current);
  return { lines, eol, bom, blocks };
}

function parseValue(
  lines: string[],
  startLine: number,
  valueColumn: number,
  filePath: string,
): { value: CodexTomlScalar; nextLine: number; trailing: string } {
  const line = lines[startLine]!;
  const raw = line.slice(valueColumn);
  const leading = raw.length - raw.trimStart().length;
  const column = valueColumn + leading;
  const value = raw.trimStart();
  const unsupported = () =>
    new CodexEnvironmentTomlError(
      "Unsupported Codex environment TOML value",
      startLine + 1,
      filePath,
    );

  if (value.startsWith("'''") || value.startsWith('"""')) {
    return parseMultilineString(lines, startLine, column, filePath);
  }

  if (value.startsWith('"')) {
    const end = findBasicStringEnd(value, 1);
    if (end < 0) throw unsupported();
    const trailing = value.slice(end + 1);
    assertOnlyComment(trailing, unsupported);
    return {
      value: decodeBasicString(value.slice(1, end), false, unsupported),
      nextLine: startLine + 1,
      trailing,
    };
  }

  if (value.startsWith("'")) {
    const end = value.indexOf("'", 1);
    if (end < 0) throw unsupported();
    const trailing = value.slice(end + 1);
    assertOnlyComment(trailing, unsupported);
    return { value: value.slice(1, end), nextLine: startLine + 1, trailing };
  }

  const stripped = stripComment(value).trimEnd();
  const trailing = value.slice(stripped.length);
  if (stripped === "true" || stripped === "false") {
    return { value: stripped === "true", nextLine: startLine + 1, trailing };
  }
  if (NUMBER.test(stripped)) {
    return { value: Number(stripped), nextLine: startLine + 1, trailing };
  }
  throw unsupported();
}

function parseMultilineString(
  lines: string[],
  startLine: number,
  column: number,
  filePath: string,
): { value: string; nextLine: number; trailing: string } {
  const delimiter = lines[startLine]!.slice(column, column + 3) as "'''" | '"""';
  const literal = delimiter === "'''";
  const unsupported = () =>
    new CodexEnvironmentTomlError(
      "Unsupported Codex environment TOML value",
      startLine + 1,
      filePath,
    );
  const parts: string[] = [];
  let text = lines[startLine]!.slice(column + 3);
  for (let i = startLine; i < lines.length; i += 1) {
    if (i > startLine) text = lines[i]!;
    const end = literal ? findLiteralMultilineEnd(text) : findBasicMultilineEnd(text);
    if (end < 0) {
      parts.push(text);
      continue;
    }
    parts.push(text.slice(0, end));
    const trailing = text.slice(end + 3);
    assertOnlyComment(trailing, unsupported);
    // A newline right after the opening delimiter is not part of the value.
    const rawValue = parts.join("\n").replace(/^\n/, "");
    return {
      value: literal ? rawValue : decodeBasicString(rawValue, true, unsupported),
      nextLine: i + 1,
      trailing,
    };
  }
  throw new CodexEnvironmentTomlError(
    "Unterminated Codex environment TOML multiline string",
    startLine + 1,
    filePath,
  );
}

/** Index of the closing `'''`. Up to two quotes before it belong to the value. */
function findLiteralMultilineEnd(text: string): number {
  const at = text.indexOf("'''");
  if (at < 0) return -1;
  let end = at;
  while (end - at < 2 && text[end + 3] === "'") end += 1;
  return end;
}

function findBasicMultilineEnd(text: string): number {
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\\") {
      i += 1;
      continue;
    }
    if (text.startsWith('"""', i)) {
      let end = i;
      while (end - i < 2 && text[end + 3] === '"') end += 1;
      return end;
    }
  }
  return -1;
}

function findBasicStringEnd(text: string, from: number): number {
  for (let i = from; i < text.length; i += 1) {
    if (text[i] === "\\") {
      i += 1;
      continue;
    }
    if (text[i] === '"') return i;
  }
  return -1;
}

const SIMPLE_ESCAPES: Record<string, string> = {
  b: "\b",
  t: "\t",
  n: "\n",
  f: "\f",
  r: "\r",
  e: "\u001b",
  '"': '"',
  "\\": "\\",
};

function decodeBasicString(
  raw: string,
  multiline: boolean,
  unsupported: () => Error,
): string {
  let out = "";
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i]!;
    if (char !== "\\") {
      out += char;
      continue;
    }
    const next = raw[i + 1];
    if (next === undefined) throw unsupported();
    if (next in SIMPLE_ESCAPES) {
      out += SIMPLE_ESCAPES[next];
      i += 1;
      continue;
    }
    if (next === "u" || next === "U") {
      const length = next === "u" ? 4 : 8;
      const hex = raw.slice(i + 2, i + 2 + length);
      if (!new RegExp(`^[0-9A-Fa-f]{${length}}$`).test(hex)) throw unsupported();
      out += String.fromCodePoint(Number.parseInt(hex, 16));
      i += 1 + length;
      continue;
    }
    // A backslash ending a line in a multi-line string trims the line break
    // and the whitespace after it.
    if (multiline && /^[ \t]*\n/.test(raw.slice(i + 1))) {
      i += 1;
      while (i < raw.length && /\s/.test(raw[i]!)) i += 1;
      i -= 1;
      continue;
    }
    throw unsupported();
  }
  return out;
}

function assertOnlyComment(text: string, unsupported: () => Error): void {
  const rest = text.trimStart();
  if (rest && !rest.startsWith("#")) throw unsupported();
}

function isCommentLine(line: string): boolean {
  return line.trimStart().startsWith("#");
}

export function stripComment(value: string): string {
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (quote === '"' && char === "\\") {
      i += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = quote === char ? undefined : quote ?? char;
      continue;
    }
    if (char === "#" && !quote) {
      return value.slice(0, i);
    }
  }
  return value;
}

/** A TOML string for `value`, in the shape Codex's editor writes. */
export function formatCodexTomlString(value: string): string {
  const text = value.replace(/\r\n?/g, "\n");
  if (!text.includes("\n")) {
    return JSON.stringify(text);
  }
  const literalSafe = !text.includes("'''")
    && !text.endsWith("'")
    && !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text);
  if (literalSafe) {
    return `'''\n${text}'''`;
  }
  const escaped = text
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, (char) =>
      `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return `"""\n${escaped}"""`;
}

export function formatCodexTomlValue(value: CodexTomlScalar): string {
  return typeof value === "string" ? formatCodexTomlString(value) : String(value);
}
