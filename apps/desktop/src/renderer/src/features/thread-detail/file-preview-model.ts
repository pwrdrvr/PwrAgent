import type { FilePreviewKind } from "@pwragent/shared";

export type FilePreviewTokenKind =
  | "key"
  | "string"
  | "number"
  | "literal"
  | "punctuation"
  | "comment"
  | "section";

export type FilePreviewToken = { text: string; kind?: FilePreviewTokenKind };

export type FilePreviewNotice = {
  tone: "danger" | "neutral";
  title: string;
  detail?: string;
};

export type FilePreviewText = {
  /** The text the view shows: the file as written, or formatted JSON. */
  text: string;
  /** One token list per line. Absent once the file passes the row bound. */
  lines?: FilePreviewToken[][];
  /** True when line numbers no longer match the file. */
  formatted?: boolean;
  errorLines?: number[];
  notice?: FilePreviewNotice;
};

export type FilePreviewTable = {
  header: string[];
  rows: string[][];
  numericColumns: boolean[];
  totalRows: number;
};

// Bound React's work. A 2 MiB file can hold tens of thousands of lines; past
// these limits the view drops colors first, then the per-line gutter.
export const MAX_PREVIEW_ROWS = 20000;
export const MAX_PREVIEW_TOKENS = 20000;
export const MAX_PREVIEW_TABLE_ROWS = 1000;
const MAX_FORMATTED_JSON_LENGTH = 4 * 1024 * 1024;

export function buildFilePreviewText(
  content: string,
  kind: Exclude<FilePreviewKind, "markdown" | "csv" | "tsv">,
): FilePreviewText {
  switch (kind) {
    case "json":
      return finish(analyzeJson(content));
    case "jsonl":
      return finish(analyzeJsonLines(content));
    case "yaml":
      return finish({ text: content, tokens: tokenizeYaml(content) });
    case "toml":
      return finish({ text: content, tokens: tokenizeToml(content) });
    case "text":
      return finish({ text: content });
  }
}

type Analysis = Omit<FilePreviewText, "lines"> & { tokens?: FilePreviewToken[] };

function finish(analysis: Analysis): FilePreviewText {
  const { tokens, ...result } = analysis;
  const lineCount = countLines(result.text);
  if (lineCount > MAX_PREVIEW_ROWS) {
    return result;
  }
  const highlighted = tokens && countHighlighted(tokens) <= MAX_PREVIEW_TOKENS
    ? tokens
    : [{ text: result.text }];
  const lines = splitTokenLines(highlighted);
  // A final newline ends the last line; it does not start an empty one.
  if (lines.length > 1 && !lines[lines.length - 1].length && /\n$/.test(result.text)) {
    lines.pop();
  }
  return { ...result, lines };
}

function countHighlighted(tokens: FilePreviewToken[]): number {
  let count = 0;
  for (const token of tokens) {
    if (token.kind) count++;
  }
  return count;
}

function countLines(text: string): number {
  let count = 1;
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    count++;
  }
  return count;
}

function splitTokenLines(tokens: FilePreviewToken[]): FilePreviewToken[][] {
  const lines: FilePreviewToken[][] = [[]];
  for (const token of tokens) {
    const parts = token.text.split(/\r?\n/);
    parts.forEach((part, index) => {
      if (index > 0) lines.push([]);
      if (part) lines[lines.length - 1].push(token.kind ? { text: part, kind: token.kind } : { text: part });
    });
  }
  return lines;
}

// ---------------------------------------------------------------- JSON

// Every character lands in exactly one alternative, so the tokens always
// concatenate back to the original text.
const JSON_TOKEN_PATTERN =
  /(\s+)|(\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|("(?:\\.|[^"\\\n])*"?)|([{}[\],:])|([^\s{}[\],:"/]+|\/)/g;

type RawJsonToken = { text: string; type: "space" | "comment" | "string" | "punctuation" | "word" };

function scanJson(text: string): RawJsonToken[] {
  const tokens: RawJsonToken[] = [];
  for (const match of text.matchAll(JSON_TOKEN_PATTERN)) {
    const type = match[1] !== undefined ? "space"
      : match[2] !== undefined ? "comment"
      : match[3] !== undefined ? "string"
      : match[4] !== undefined ? "punctuation"
      : "word";
    tokens.push({ text: match[0], type });
  }
  return tokens;
}

export function tokenizeJson(text: string): FilePreviewToken[] {
  return classifyJsonTokens(scanJson(text));
}

function classifyJsonTokens(raw: RawJsonToken[]): FilePreviewToken[] {
  return raw.map((token, index) => {
    switch (token.type) {
      case "space":
        return { text: token.text };
      case "comment":
        return { text: token.text, kind: "comment" };
      case "punctuation":
        return { text: token.text, kind: "punctuation" };
      case "string":
        return { text: token.text, kind: nextSignificant(raw, index)?.text === ":" ? "key" : "string" };
      case "word":
        return /^(?:true|false|null)$/.test(token.text) ? { text: token.text, kind: "literal" }
          : /^[-+]?(?:\d|\.\d|Infinity|NaN)/.test(token.text) ? { text: token.text, kind: "number" }
          : { text: token.text };
    }
  });
}

function nextSignificant(tokens: RawJsonToken[], index: number): RawJsonToken | undefined {
  for (let next = index + 1; next < tokens.length; next++) {
    if (tokens[next].type !== "space" && tokens[next].type !== "comment") return tokens[next];
  }
  return undefined;
}

function analyzeJson(content: string): Analysis {
  // Validate without serializing the parsed value: large integers, duplicate
  // keys and the original number/string spellings must survive the preview.
  let parseError: unknown;
  try {
    JSON.parse(content);
  } catch (error) {
    parseError = error;
  }
  // A file that fails strict parsing is scanned once, for both the
  // JSON-with-comments check and the colors.
  const raw = parseError === undefined ? undefined : scanJson(content);
  if (raw && !parsesAsJsonWithComments(raw)) {
    const location = jsonErrorLocation(parseError, content);
    const detail = jsonErrorDetail(parseError);
    return {
      text: content,
      tokens: classifyJsonTokens(raw),
      errorLines: location ? [location.line] : undefined,
      notice: {
        tone: "danger",
        title: location
          ? `Invalid JSON at line ${location.line}, column ${location.column}.`
          : "Invalid JSON.",
        detail,
      },
    };
  }

  // Line numbers should match the editor, so the file is shown as written.
  // Only a file on one line is formatted, because it cannot be read as is.
  const trimmed = content.trim();
  if (parseError === undefined && /^[[{]/.test(trimmed) && !trimmed.includes("\n")) {
    const formatted = formatJson(trimmed);
    if (formatted !== undefined && formatted !== trimmed) {
      return {
        text: formatted,
        tokens: tokenizeJson(formatted),
        formatted: true,
        notice: { tone: "neutral", title: "Formatted for reading. The file is a single line." },
      };
    }
  }
  return { text: content, tokens: raw ? classifyJsonTokens(raw) : tokenizeJson(content) };
}

/** JSON with comments, as tsconfig.json and VS Code settings use it. */
function parsesAsJsonWithComments(raw: RawJsonToken[]): boolean {
  const significant = raw.filter((token) =>
    token.type !== "space" && token.type !== "comment");
  if (!significant.length) return false;
  const kept = significant.filter((token, index) =>
    !(token.text === "," && (significant[index + 1]?.text === "}" || significant[index + 1]?.text === "]")));
  try {
    JSON.parse(kept.map((token) => token.text).join(" "));
    return true;
  } catch {
    return false;
  }
}

function jsonErrorLocation(
  error: unknown,
  content: string,
): { line: number; column: number } | undefined {
  const message = error instanceof Error ? error.message : "";
  const lineColumn = /\(line (\d+) column (\d+)\)/.exec(message);
  if (lineColumn) {
    return { line: Number(lineColumn[1]), column: Number(lineColumn[2]) };
  }
  const position = /at position (\d+)/.exec(message);
  const offset = position ? Number(position[1])
    // Point at the last character, not past a trailing newline.
    : /Unexpected end of JSON input/.test(message) && content.trim() ? content.trimEnd().length
    : undefined;
  if (offset === undefined) return undefined;
  const before = content.slice(0, offset);
  const line = countLines(before);
  return { line, column: offset - before.lastIndexOf("\n") };
}

function jsonErrorDetail(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : "";
  // V8 quotes the surrounding source in some messages. The view already shows
  // it, so keep only the short structural messages.
  const detail = message.replace(/\s+in JSON at position \d+.*$/s, "").trim();
  if (!detail || detail.length > 120 || /is not valid JSON/.test(detail)) return undefined;
  return /[.!?]$/.test(detail) ? detail : `${detail}.`;
}

function formatJson(content: string): string | undefined {
  const tokens = content.match(/"(?:\\.|[^"\\])*"|[{}[\],:]|[^\s{}[\],:]+/g) ?? [];
  const parts: string[] = [];
  let depth = 0;
  let length = 0;
  const newline = () => `\n${"  ".repeat(Math.min(depth, 40))}`;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    let part = token;
    if (token === "{" || token === "[") {
      depth++;
      if (tokens[index + 1] !== "}" && tokens[index + 1] !== "]") part += newline();
    } else if (token === "}" || token === "]") {
      depth--;
      if (tokens[index - 1] !== "{" && tokens[index - 1] !== "[") part = newline() + token;
    } else if (token === ",") {
      part += newline();
    } else if (token === ":") {
      part += " ";
    }
    length += part.length;
    // Keep highly nested or large documents from expanding without a bound.
    if (length > MAX_FORMATTED_JSON_LENGTH) return undefined;
    parts.push(part);
  }
  return parts.join("");
}

function analyzeJsonLines(content: string): Analysis {
  const errorLines: number[] = [];
  content.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    try {
      JSON.parse(line);
    } catch {
      errorLines.push(index + 1);
    }
  });
  const analysis: Analysis = { text: content, tokens: tokenizeJson(content) };
  if (!errorLines.length) return analysis;
  const listed = errorLines.slice(0, 5).join(", ");
  const more = errorLines.length > 5 ? `, and ${errorLines.length - 5} more` : "";
  return {
    ...analysis,
    errorLines,
    notice: {
      tone: "danger",
      title: errorLines.length === 1
        ? `Line ${errorLines[0]} is not valid JSON.`
        : `${errorLines.length} lines are not valid JSON: ${listed}${more}.`,
    },
  };
}

// ---------------------------------------------------------------- YAML

// Approximate by design: the file is always shown as written, so a missed
// color never hides content. No YAML parser ships with the app.
export function tokenizeYaml(text: string): FilePreviewToken[] {
  const tokens: FilePreviewToken[] = [];
  let blockIndent: number | undefined;
  text.split("\n").forEach((line, index) => {
    if (index > 0) tokens.push({ text: "\n" });
    const indent = /^ */.exec(line)![0].length;
    if (blockIndent !== undefined) {
      if (!line.trim() || indent > blockIndent) {
        tokens.push({ text: line, kind: "string" });
        return;
      }
      blockIndent = undefined;
    }
    tokens.push(...tokenizeYamlLine(line, (scalarIndent) => {
      blockIndent = scalarIndent;
    }));
  });
  return tokens;
}

const YAML_KEY_PATTERN =
  /^("(?:\\.|[^"\\])*"|'(?:''|[^'])*'|[^\s#'"[\]{},:&*!|>%@`-][^#]*?|-[^\s#][^#]*?)(\s*:)(?=\s|$)/;

function tokenizeYamlLine(line: string, startBlock: (indent: number) => void): FilePreviewToken[] {
  const tokens: FilePreviewToken[] = [];
  if (/^(?:---|\.\.\.)(?:\s|$)/.test(line)) {
    tokens.push({ text: line.slice(0, 3), kind: "punctuation" });
    tokens.push(...tokenizeYamlValue(line.slice(3)));
    return tokens;
  }
  const lead = /^(\s*)((?:-(?:\s+|$))*)/.exec(line)!;
  if (lead[1]) tokens.push({ text: lead[1] });
  if (lead[2]) tokens.push({ text: lead[2], kind: "punctuation" });
  let rest = line.slice(lead[0].length);
  const key = YAML_KEY_PATTERN.exec(rest);
  if (key) {
    tokens.push({ text: key[1], kind: "key" }, { text: key[2], kind: "punctuation" });
    rest = rest.slice(key[0].length);
  }
  const value = tokenizeYamlValue(rest);
  const scalar = value.find((token) => token.text.trim());
  if (scalar?.kind === "punctuation" && /^[|>]/.test(scalar.text)) {
    startBlock(lead[1].length + (lead[2] ? lead[2].length : 0));
  }
  tokens.push(...value);
  return tokens;
}

function tokenizeYamlValue(text: string): FilePreviewToken[] {
  const comment = findYamlComment(text);
  const body = comment === undefined ? text : text.slice(0, comment);
  const tokens: FilePreviewToken[] = [];
  const space = /^\s*/.exec(body)![0];
  if (space) tokens.push({ text: space });
  const value = body.slice(space.length);
  const trailing = /\s*$/.exec(value)![0];
  const scalar = value.slice(0, value.length - trailing.length);
  if (scalar) tokens.push({ text: scalar, kind: yamlScalarKind(scalar) });
  if (trailing) tokens.push({ text: trailing });
  if (comment !== undefined) tokens.push({ text: text.slice(comment), kind: "comment" });
  return tokens;
}

function findYamlComment(text: string): number | undefined {
  let quote: string | undefined;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quote) {
      if (char === "\\" && quote === '"') index++;
      else if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") {
      if (index === 0 || /[\s[{,:]/.test(text[index - 1])) quote = char;
    } else if (char === "#" && (index === 0 || /\s/.test(text[index - 1]))) {
      return index;
    }
  }
  return undefined;
}

function yamlScalarKind(scalar: string): FilePreviewTokenKind | undefined {
  if (/^["']/.test(scalar)) return "string";
  if (/^[|>][-+0-9]*$/.test(scalar)) return "punctuation";
  if (/^(?:true|false|yes|no|on|off|null|~)$/i.test(scalar)) return "literal";
  if (/^[-+]?(?:\d[\d_]*(?:\.\d*)?(?:[eE][-+]?\d+)?|\.\d+|0x[\da-fA-F]+|0o[0-7]+|\.inf|\.nan)$/i.test(scalar)) return "number";
  if (/^[&*!]\S*$/.test(scalar)) return "literal";
  return undefined;
}

// ---------------------------------------------------------------- TOML

const TOML_KEY = String.raw`(?:"(?:\\.|[^"\\])*"|'[^']*'|[A-Za-z0-9_-]+)`;
const TOML_KEY_LINE = new RegExp(String.raw`^(\s*)(${TOML_KEY}(?:\s*\.\s*${TOML_KEY})*)(\s*=)`);
const TOML_VALUE_PATTERN = new RegExp([
  String.raw`(\s+)`,
  String.raw`(#.*)`,
  String.raw`("""|''')`,
  String.raw`("(?:\\.|[^"\\])*"?|'[^']*'?)`,
  String.raw`(\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?|\d{2}:\d{2}:\d{2}(?:\.\d+)?)`,
  String.raw`([+-]?(?:0x[\da-fA-F_]+|0o[0-7_]+|0b[01_]+|inf|nan|\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?))(?![\w-])`,
  String.raw`(true|false)(?![\w-])`,
  String.raw`([{}[\],=.])`,
  String.raw`([^\s{}[\],=.#"']+)`,
].join("|"), "g");

export function tokenizeToml(text: string): FilePreviewToken[] {
  const tokens: FilePreviewToken[] = [];
  let openString: string | undefined;
  // Inside a multi-line array, a line that starts with `[` is a nested
  // array, not a table header.
  let arrayDepth = 0;
  text.split("\n").forEach((line, index) => {
    if (index > 0) tokens.push({ text: "\n" });
    const lineStart = tokens.length;
    let rest = line;
    if (openString) {
      const close = rest.indexOf(openString);
      if (close === -1) {
        if (rest) tokens.push({ text: rest, kind: "string" });
        return;
      }
      tokens.push({ text: rest.slice(0, close + 3), kind: "string" });
      rest = rest.slice(close + 3);
      openString = undefined;
    } else if (arrayDepth === 0 && /^\s*\[/.test(rest)) {
      const header = /^(\s*)(\[\[?[^\]#]*\]?\]?)/.exec(rest)!;
      if (header[1]) tokens.push({ text: header[1] });
      tokens.push({ text: header[2], kind: "section" });
      rest = rest.slice(header[0].length);
    } else {
      const key = TOML_KEY_LINE.exec(rest);
      if (key) {
        if (key[1]) tokens.push({ text: key[1] });
        tokens.push({ text: key[2], kind: "key" }, { text: key[3], kind: "punctuation" });
        rest = rest.slice(key[0].length);
      }
    }
    openString = tokenizeTomlValue(rest, tokens);
    for (let token = lineStart; token < tokens.length; token++) {
      if (tokens[token].kind !== "punctuation") continue;
      if (tokens[token].text === "[") arrayDepth++;
      else if (tokens[token].text === "]") arrayDepth = Math.max(0, arrayDepth - 1);
    }
  });
  return tokens;
}

/** Returns the delimiter of a multi-line string left open on this line. */
function tokenizeTomlValue(text: string, tokens: FilePreviewToken[]): string | undefined {
  for (const match of text.matchAll(TOML_VALUE_PATTERN)) {
    if (match[3] !== undefined) {
      const start = match.index! + 3;
      const close = text.indexOf(match[3], start);
      if (close === -1) {
        tokens.push({ text: text.slice(match.index), kind: "string" });
        return match[3];
      }
      // Hand the rest of the line back to the scanner after the string.
      tokens.push({ text: text.slice(match.index, close + 3), kind: "string" });
      return tokenizeTomlValue(text.slice(close + 3), tokens);
    }
    const kind: FilePreviewTokenKind | undefined = match[1] !== undefined ? undefined
      : match[2] !== undefined ? "comment"
      : match[4] !== undefined ? "string"
      : match[5] !== undefined || match[6] !== undefined ? "number"
      : match[7] !== undefined ? "literal"
      : match[8] !== undefined ? "punctuation"
      : /^\s*=/.test(text.slice(match.index! + match[0].length)) ? "key"
      : undefined;
    tokens.push(kind ? { text: match[0], kind } : { text: match[0] });
  }
  return undefined;
}

// ---------------------------------------------------------------- CSV/TSV

export function parseDelimitedTable(
  content: string,
  delimiter: "," | "\t",
): FilePreviewTable | undefined {
  const text = content.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let totalRows = 0;
  let row: string[] = [];
  let field = "";
  // TSV has no quoting convention; only CSV fields may be quoted.
  const quoting = delimiter === ",";
  let quoted = false;
  let fieldStarted = false;
  const endRow = () => {
    row.push(field);
    // A trailing newline does not make an empty final row.
    if (!(row.length === 1 && row[0] === "" && !fieldStarted)) {
      totalRows++;
      if (rows.length <= MAX_PREVIEW_TABLE_ROWS) rows.push(row);
    }
    row = [];
    field = "";
    fieldStarted = false;
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char !== '"') {
        field += char;
      } else if (text[index + 1] === '"') {
        field += '"';
        index++;
      } else {
        quoted = false;
      }
    } else if (quoting && char === '"' && !field) {
      quoted = true;
      fieldStarted = true;
    } else if (char === delimiter) {
      row.push(field);
      field = "";
      fieldStarted = true;
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index++;
      endRow();
    } else {
      field += char;
      fieldStarted = true;
    }
  }
  if (quoted) return undefined;
  if (field || fieldStarted || row.length) endRow();
  if (!rows.length) return undefined;

  const [header, ...body] = rows;
  const width = Math.max(...rows.map((cells) => cells.length));
  const pad = (cells: string[]) =>
    cells.length < width ? [...cells, ...Array<string>(width - cells.length).fill("")] : cells;
  const paddedBody = body.map(pad);
  const numericColumns = Array.from({ length: width }, (_, column) => {
    const values = paddedBody.map((cells) => cells[column].trim()).filter(Boolean);
    return values.length > 0 && values.every((value) =>
      /^[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?(?:[eE][-+]?\d+)?%?$/.test(value) && /\d/.test(value));
  });
  return { header: pad(header), rows: paddedBody, numericColumns, totalRows: totalRows - 1 };
}
