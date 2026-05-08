/**
 * Diff-style TOML editor.
 *
 * Reads an existing TOML source as text, applies a list of `set`/`delete`
 * operations to the keys we know about, and returns the updated text. Lines,
 * whitespace, comments, and unknown sections that aren't touched by an edit
 * are preserved byte-for-byte. The point is to avoid round-trip data loss
 * when a build that doesn't recognize a section saves the file.
 *
 * Supported value kinds (read and write):
 *   - string       e.g. `"value"`
 *   - integer      e.g. `123`
 *   - boolean      e.g. `true` / `false`
 *   - string array e.g. `["a", "b"]`
 *   - inline-table array, with scalar fields per entry, e.g.
 *     `[{ id = "-1", label = "Mom" }, { id = "-2", label = "Work" }]`
 *
 * Read-side: tolerates multi-line array formatting, inline comments, and
 * `[[array.of.tables]]` / dotted-key forms it doesn't actively use.
 *
 * Write-side: emits a canonical, deterministic format. Values that match
 * the parsed existing value are skipped (the file stays byte-identical).
 */

export type TomlEditScalar = string | number | boolean;

export type TomlEditValue =
  | TomlEditScalar
  | readonly string[]
  | readonly Record<string, TomlEditScalar>[];

export type TomlEdit =
  | { op: "set"; path: readonly string[]; value: TomlEditValue }
  | { op: "delete"; path: readonly string[] };

/** Parsed value type for the read-side parser. */
export type TomlValue =
  | string
  | number
  | boolean
  | string[]
  | Record<string, TomlEditScalar>[];

/** Map of section name (dotted, "" for top-level) to key→value map. */
export type TomlTables = Record<string, Record<string, TomlValue>>;

type ParsedValue =
  | { kind: "string"; value: string }
  | { kind: "integer"; value: number }
  | { kind: "boolean"; value: boolean }
  | { kind: "string-array"; value: string[] }
  | { kind: "inline-table-array"; value: Record<string, TomlEditScalar>[] };

type KeyLocation = {
  name: string;
  startLine: number;
  endLine: number; // inclusive
};

type SectionLocation = {
  name: string; // dotted; "" for the implicit top-level section
  headerLine: number; // -1 for the implicit top-level section
  keys: KeyLocation[];
};

type SourceModel = {
  lines: string[];
  trailingNewline: boolean;
  sections: SectionLocation[];
};

const KEY_LINE = /^(\s*)([A-Za-z_][A-Za-z0-9_\-]*)\s*=\s*/;
const SECTION_HEADER = /^\s*\[\s*([^\[\]]+?)\s*\]\s*(#.*)?$/;
const ARRAY_OF_TABLES_HEADER = /^\s*\[\[\s*([^\[\]]+?)\s*\]\]\s*(#.*)?$/;

/**
 * Parse a TOML source into a flat `tables[sectionName][key] = value` map.
 *
 * Strict: throws on invalid TOML, unsupported value kinds, or malformed
 * section headers, so callers can surface a config error to the user.
 *
 * Tolerant of multi-line `[ ... ]` arrays, multi-line inline-table arrays,
 * comments (line and trailing), and `[[array.of.tables]]` headers (each
 * occurrence overwrites the prior accumulator under the same name).
 */
export function parseTomlTables(source: string, filePath: string): TomlTables {
  const lines = source.split(/\r?\n/);
  const tables: TomlTables = {};
  let currentTable = "";

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = stripComment(line).trim();
    if (trimmed.length === 0) {
      i += 1;
      continue;
    }

    const arrayHeader = ARRAY_OF_TABLES_HEADER.exec(line);
    const sectionMatch = arrayHeader ?? SECTION_HEADER.exec(line);
    if (sectionMatch) {
      currentTable = sectionMatch[1].trim();
      if (!currentTable) {
        throw new Error(`Invalid TOML table on line ${i + 1} in ${filePath}`);
      }
      tables[currentTable] ??= {};
      i += 1;
      continue;
    }

    const keyMatch = KEY_LINE.exec(line);
    if (!keyMatch) {
      throw new Error(`Invalid TOML line ${i + 1} in ${filePath}`);
    }
    const key = keyMatch[2];
    const valueStartCol = keyMatch[0].length;
    const endLine = findValueEndLine(lines, i, valueStartCol);
    const valueText = sliceValueText(lines, i, valueStartCol, endLine);
    const parsed = tryParseValue(valueText);
    if (!parsed) {
      throw new Error(`Unsupported TOML value on line ${i + 1} in ${filePath}`);
    }

    tables[currentTable] ??= {};
    tables[currentTable][key] = parsed.value;
    i = endLine + 1;
  }

  return tables;
}

export function applyTomlEdits(
  source: string,
  edits: readonly TomlEdit[],
): string {
  if (edits.length === 0) {
    return source;
  }

  const model = parseSource(source);
  let lines = model.lines.slice();

  for (const edit of edits) {
    lines = applyEdit(lines, parseSource(joinLines(lines, model.trailingNewline)), edit);
  }

  return joinLines(lines, model.trailingNewline);
}

function joinLines(lines: string[], _trailingNewline: boolean): string {
  if (lines.length === 0) {
    return "";
  }
  return lines.join("\n") + "\n";
}

function parseSource(source: string): SourceModel {
  const trailingNewline = source.endsWith("\n");
  const body = trailingNewline ? source.slice(0, -1) : source;
  const lines = body.length === 0 ? [] : body.split("\n");

  const sections: SectionLocation[] = [
    { name: "", headerLine: -1, keys: [] },
  ];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = stripComment(line).trim();

    if (trimmed.length === 0) {
      i += 1;
      continue;
    }

    const arrayHeader = ARRAY_OF_TABLES_HEADER.exec(line);
    if (arrayHeader) {
      sections.push({
        name: arrayHeader[1].trim(),
        headerLine: i,
        keys: [],
      });
      i += 1;
      continue;
    }

    const header = SECTION_HEADER.exec(line);
    if (header) {
      sections.push({
        name: header[1].trim(),
        headerLine: i,
        keys: [],
      });
      i += 1;
      continue;
    }

    const keyMatch = KEY_LINE.exec(line);
    if (!keyMatch) {
      // Unknown line shape — leave it alone.
      i += 1;
      continue;
    }

    const key = keyMatch[2];
    const valueStartCol = keyMatch[0].length;
    const endLine = findValueEndLine(lines, i, valueStartCol);
    const currentSection = sections[sections.length - 1];
    currentSection.keys.push({ name: key, startLine: i, endLine });
    i = endLine + 1;
  }

  return { lines, trailingNewline: trailingNewline || lines.length > 0, sections };
}

function applyEdit(
  lines: string[],
  model: SourceModel,
  edit: TomlEdit,
): string[] {
  const { tableName, keyName } = splitPath(edit.path);
  const section = findSection(model, tableName);

  if (edit.op === "delete") {
    if (!section) {
      return lines;
    }
    const key = section.keys.find((k) => k.name === keyName);
    if (!key) {
      return lines;
    }
    return removeLines(lines, key.startLine, key.endLine);
  }

  // op: set
  if (!section) {
    return appendNewSection(lines, tableName, keyName, edit.value);
  }

  const existingKey = section.keys.find((k) => k.name === keyName);
  if (existingKey) {
    const existingValue = parseExistingValue(lines, existingKey);
    if (existingValue && valuesEqual(existingValue, edit.value)) {
      return lines;
    }
    return replaceLines(
      lines,
      existingKey.startLine,
      existingKey.endLine,
      formatKeyValue(keyName, edit.value, /* indent */ ""),
    );
  }

  return appendKeyToSection(lines, model, section, keyName, edit.value);
}

function splitPath(path: readonly string[]): {
  tableName: string;
  keyName: string;
} {
  if (path.length === 0) {
    throw new Error("TomlEdit path must have at least one segment");
  }
  if (path.length === 1) {
    return { tableName: "", keyName: path[0] };
  }
  return {
    tableName: path.slice(0, -1).join("."),
    keyName: path[path.length - 1],
  };
}

function findSection(
  model: SourceModel,
  name: string,
): SectionLocation | undefined {
  // Last definition wins for repeated headers, but for our config format we
  // expect each section to appear once. Search from the end so a redeclared
  // section wins.
  for (let i = model.sections.length - 1; i >= 0; i -= 1) {
    if (model.sections[i].name === name) {
      return model.sections[i];
    }
  }
  return undefined;
}

function appendNewSection(
  lines: string[],
  tableName: string,
  keyName: string,
  value: TomlEditValue,
): string[] {
  const additions: string[] = [];
  // Separate from preceding content with a blank line, but only if there's
  // content and it doesn't already end with one.
  if (lines.length > 0 && lines[lines.length - 1].trim().length !== 0) {
    additions.push("");
  }
  if (tableName.length > 0) {
    additions.push(`[${tableName}]`);
  }
  for (const formatted of formatKeyValue(keyName, value, "")) {
    additions.push(formatted);
  }
  return [...lines, ...additions];
}

function appendKeyToSection(
  lines: string[],
  model: SourceModel,
  section: SectionLocation,
  keyName: string,
  value: TomlEditValue,
): string[] {
  const insertionLine = computeKeyInsertionLine(model, section);
  const additions = formatKeyValue(keyName, value, "");
  return [...lines.slice(0, insertionLine), ...additions, ...lines.slice(insertionLine)];
}

function computeKeyInsertionLine(
  model: SourceModel,
  section: SectionLocation,
): number {
  // Insert at the end of the section's content, before any trailing blank
  // lines that separate this section from the next.
  const sectionIndex = model.sections.indexOf(section);
  const nextSection = model.sections[sectionIndex + 1];
  const sectionEnd =
    nextSection !== undefined ? nextSection.headerLine : model.lines.length;

  // The last "owned" line of this section is the line of its last key (or the
  // header line if no keys).
  let cursor = sectionEnd - 1;
  const lastKey = section.keys[section.keys.length - 1];
  const lastOwnedLine = lastKey
    ? lastKey.endLine
    : section.headerLine; // -1 for top-level implicit section

  // Walk back over trailing blank lines that would be visually attached to the
  // *next* section (or to nothing, for the trailing-blank-at-EOF case).
  while (cursor > lastOwnedLine && model.lines[cursor].trim().length === 0) {
    cursor -= 1;
  }

  return cursor + 1;
}

function removeLines(
  lines: string[],
  startLine: number,
  endLine: number,
): string[] {
  return [...lines.slice(0, startLine), ...lines.slice(endLine + 1)];
}

function replaceLines(
  lines: string[],
  startLine: number,
  endLine: number,
  replacement: string[],
): string[] {
  return [
    ...lines.slice(0, startLine),
    ...replacement,
    ...lines.slice(endLine + 1),
  ];
}

function parseExistingValue(
  lines: string[],
  key: KeyLocation,
): ParsedValue | undefined {
  // Reconstruct the value text from the key line and any continuation lines.
  const firstLine = lines[key.startLine];
  const match = KEY_LINE.exec(firstLine);
  if (!match) {
    return undefined;
  }
  const valueText = sliceValueText(
    lines,
    key.startLine,
    match[0].length,
    key.endLine,
  );
  return tryParseValue(valueText);
}

function sliceValueText(
  lines: string[],
  startLine: number,
  startCol: number,
  endLine: number,
): string {
  if (startLine === endLine) {
    return lines[startLine].slice(startCol);
  }
  const parts: string[] = [lines[startLine].slice(startCol)];
  for (let l = startLine + 1; l <= endLine; l += 1) {
    parts.push(lines[l]);
  }
  return parts.join("\n");
}

function tryParseValue(rawText: string): ParsedValue | undefined {
  const text = stripValueTrailingComment(rawText).trim();
  if (text.length === 0) {
    return undefined;
  }

  if (text === "true") {
    return { kind: "boolean", value: true };
  }
  if (text === "false") {
    return { kind: "boolean", value: false };
  }
  if (/^-?\d+$/.test(text)) {
    const value = Number(text);
    return Number.isFinite(value) ? { kind: "integer", value } : undefined;
  }
  if (text.startsWith('"')) {
    const result = scanQuotedString(text, 0);
    if (result && result.endIndex === text.length - 1) {
      return { kind: "string", value: result.value };
    }
    return undefined;
  }
  if (text.startsWith("[")) {
    return parseArrayLiteral(text);
  }
  return undefined;
}

function parseArrayLiteral(text: string): ParsedValue | undefined {
  // text starts with `[` and (we hope) ends with `]`.
  const last = findArrayClose(text, 0);
  if (last === -1 || last !== text.length - 1) {
    return undefined;
  }
  const inner = text.slice(1, last);
  const elements = splitTopLevel(inner, ",");
  if (elements.length === 1 && elements[0].trim().length === 0) {
    // Empty array — could be either kind; pick string-array as the canonical
    // empty form.
    return { kind: "string-array", value: [] };
  }

  const trimmed = elements.map((e) => e.trim()).filter((e) => e.length > 0);
  if (trimmed.length === 0) {
    return { kind: "string-array", value: [] };
  }

  if (trimmed.every((e) => e.startsWith("{") && e.endsWith("}"))) {
    const tables: Record<string, TomlEditScalar>[] = [];
    for (const entry of trimmed) {
      const table = parseInlineTable(entry);
      if (!table) return undefined;
      tables.push(table);
    }
    return { kind: "inline-table-array", value: tables };
  }

  if (trimmed.every((e) => e.startsWith('"'))) {
    const strings: string[] = [];
    for (const entry of trimmed) {
      const parsed = scanQuotedString(entry, 0);
      if (!parsed || parsed.endIndex !== entry.length - 1) return undefined;
      strings.push(parsed.value);
    }
    return { kind: "string-array", value: strings };
  }

  return undefined;
}

function parseInlineTable(text: string): Record<string, TomlEditScalar> | undefined {
  // text is `{ ... }` (possibly with newlines/whitespace inside).
  if (!text.startsWith("{") || !text.endsWith("}")) return undefined;
  const inner = text.slice(1, -1);
  const fields = splitTopLevel(inner, ",");
  const out: Record<string, TomlEditScalar> = {};
  for (const raw of fields) {
    const field = raw.trim();
    if (field.length === 0) continue;
    const eq = field.indexOf("=");
    if (eq === -1) return undefined;
    const key = field.slice(0, eq).trim();
    const valueText = field.slice(eq + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_\-]*$/.test(key)) return undefined;
    const parsed = tryParseValue(valueText);
    if (!parsed) return undefined;
    if (
      parsed.kind === "string"
      || parsed.kind === "integer"
      || parsed.kind === "boolean"
    ) {
      out[key] = parsed.value;
    } else {
      return undefined;
    }
  }
  return out;
}

function findArrayClose(text: string, openIndex: number): number {
  let depth = 0;
  let i = openIndex;
  let inDQ = false;
  let inSQ = false;
  let escaped = false;
  while (i < text.length) {
    const ch = text[i];
    if (inDQ) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inDQ = false;
    } else if (inSQ) {
      if (ch === "'") inSQ = false;
    } else {
      if (ch === '"') inDQ = true;
      else if (ch === "'") inSQ = true;
      else if (ch === "[" || ch === "{") depth += 1;
      else if (ch === "]" || ch === "}") {
        depth -= 1;
        if (depth === 0) return i;
      } else if (ch === "#") {
        // Skip rest of line.
        const nl = text.indexOf("\n", i);
        if (nl === -1) return -1;
        i = nl;
      }
    }
    i += 1;
  }
  return -1;
}

function splitTopLevel(text: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inDQ = false;
  let inSQ = false;
  let escaped = false;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inDQ) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inDQ = false;
      continue;
    }
    if (inSQ) {
      if (ch === "'") inSQ = false;
      continue;
    }
    if (ch === '"') {
      inDQ = true;
      continue;
    }
    if (ch === "'") {
      inSQ = true;
      continue;
    }
    if (ch === "[" || ch === "{") {
      depth += 1;
      continue;
    }
    if (ch === "]" || ch === "}") {
      depth -= 1;
      continue;
    }
    if (ch === "#") {
      const nl = text.indexOf("\n", i);
      if (nl === -1) {
        // Treat rest as comment — drop.
        text = text.slice(0, i);
        break;
      }
      text = text.slice(0, i) + text.slice(nl);
      continue;
    }
    if (ch === sep && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function scanQuotedString(
  text: string,
  startIndex: number,
): { value: string; endIndex: number } | undefined {
  if (text[startIndex] !== '"') return undefined;
  let value = "";
  let i = startIndex + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      const escape = text[i + 1];
      if (escape === undefined) return undefined;
      if (escape === "\\") value += "\\";
      else if (escape === '"') value += '"';
      else if (escape === "n") value += "\n";
      else if (escape === "t") value += "\t";
      else if (escape === "r") value += "\r";
      else return undefined;
      i += 2;
      continue;
    }
    if (ch === '"') {
      return { value, endIndex: i };
    }
    value += ch;
    i += 1;
  }
  return undefined;
}

function stripValueTrailingComment(text: string): string {
  // Strip a trailing `# ...` comment that's not inside a string. Multi-line
  // safe: only consider comments on the final line.
  const lines = text.split("\n");
  const lastLine = lines[lines.length - 1];
  const stripped = stripComment(lastLine);
  lines[lines.length - 1] = stripped;
  return lines.join("\n");
}

function stripComment(line: string): string {
  let inDQ = false;
  let inSQ = false;
  let escaped = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inDQ) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inDQ = false;
      continue;
    }
    if (inSQ) {
      if (ch === "'") inSQ = false;
      continue;
    }
    if (ch === '"') {
      inDQ = true;
      continue;
    }
    if (ch === "'") {
      inSQ = true;
      continue;
    }
    if (ch === "#") {
      return line.slice(0, i);
    }
  }
  return line;
}

function findValueEndLine(
  lines: string[],
  startLine: number,
  valueStartCol: number,
): number {
  const first = lines[startLine];
  let i = valueStartCol;
  while (i < first.length && /\s/.test(first[i])) i += 1;
  if (i >= first.length) {
    return startLine;
  }
  const ch = first[i];
  if (ch !== "[" && ch !== "{") {
    // Single-line scalar / string.
    return startLine;
  }

  let depth = 0;
  let inDQ = false;
  let inSQ = false;
  let escaped = false;
  for (let l = startLine; l < lines.length; l += 1) {
    const startCol = l === startLine ? i : 0;
    const line = lines[l];
    let c = startCol;
    while (c < line.length) {
      const cur = line[c];
      if (inDQ) {
        if (escaped) escaped = false;
        else if (cur === "\\") escaped = true;
        else if (cur === '"') inDQ = false;
      } else if (inSQ) {
        if (cur === "'") inSQ = false;
      } else {
        if (cur === '"') inDQ = true;
        else if (cur === "'") inSQ = true;
        else if (cur === "[" || cur === "{") depth += 1;
        else if (cur === "]" || cur === "}") {
          depth -= 1;
          if (depth === 0) return l;
        } else if (cur === "#") {
          break; // comment to end of line
        }
      }
      c += 1;
    }
    if (depth === 0) return l;
  }
  // Unterminated; best effort.
  return lines.length - 1;
}

function valuesEqual(parsed: ParsedValue, requested: TomlEditValue): boolean {
  if (parsed.kind === "boolean" && typeof requested === "boolean") {
    return parsed.value === requested;
  }
  if (parsed.kind === "integer" && typeof requested === "number") {
    return parsed.value === requested;
  }
  if (parsed.kind === "string" && typeof requested === "string") {
    return parsed.value === requested;
  }
  if (parsed.kind === "string-array" && Array.isArray(requested)) {
    if (requested.length === 0) return parsed.value.length === 0;
    if (typeof requested[0] !== "string") return false;
    if (parsed.value.length !== requested.length) return false;
    return parsed.value.every((v, i) => v === requested[i]);
  }
  if (parsed.kind === "inline-table-array" && Array.isArray(requested)) {
    if (requested.length === 0) return parsed.value.length === 0;
    if (typeof requested[0] !== "object") return false;
    if (parsed.value.length !== requested.length) return false;
    return parsed.value.every((entry, i) => {
      const other = requested[i] as Record<string, TomlEditScalar>;
      const entryKeys = Object.keys(entry);
      const otherKeys = Object.keys(other);
      if (entryKeys.length !== otherKeys.length) return false;
      return entryKeys.every((k) => entry[k] === other[k]);
    });
  }
  return false;
}

function formatKeyValue(
  key: string,
  value: TomlEditValue,
  indent: string,
): string[] {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return [`${indent}${key} = []`];
    }
    if (typeof value[0] === "string") {
      const items = (value as readonly string[]).map(formatString);
      return [`${indent}${key} = [${items.join(", ")}]`];
    }
    // inline-table array — multi-line, one entry per line
    const lines: string[] = [`${indent}${key} = [`];
    for (const entry of value as readonly Record<string, TomlEditScalar>[]) {
      lines.push(`${indent}  ${formatInlineTable(entry)},`);
    }
    lines.push(`${indent}]`);
    return lines;
  }
  return [`${indent}${key} = ${formatScalar(value as TomlEditScalar)}`];
}

function formatScalar(value: TomlEditScalar): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  return formatString(value);
}

function formatString(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(/\r/g, "\\r")}"`;
}

function formatInlineTable(entry: Record<string, TomlEditScalar>): string {
  const fields = Object.entries(entry)
    .map(([k, v]) => `${k} = ${formatScalar(v)}`)
    .join(", ");
  return `{ ${fields} }`;
}
