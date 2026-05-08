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
 *   - float        e.g. `1.5`, `-2.25`, `1.5e3`
 *   - boolean      e.g. `true` / `false`
 *   - string array e.g. `["a", "b"]`
 *   - inline-table array, with scalar fields per entry, e.g.
 *     `[{ id = "-1", label = "Mom" }, { id = "-2", label = "Work" }]`
 *
 * Read-side: tolerates multi-line array formatting, inline comments, and
 * `[[array.of.tables]]` headers. Unknown TOML value kinds (datetimes, hex
 * ints, multi-line strings) are skipped with a console warning rather than
 * throwing — a future build introducing them in a section the current build
 * doesn't know about must not kill the entire snapshot read.
 *
 * Write-side: emits a canonical, deterministic format. Values that match
 * the parsed existing value are skipped (the file stays byte-identical).
 *
 * Duplicate section headers (e.g. `[s]` twice in one file) follow
 * **first-wins** semantics: the reader takes only the first occurrence's
 * keys and warns; the editor edits keys in the first occurrence and leaves
 * subsequent duplicates untouched.
 *
 * Trailing newline: preserved from the source. Empty source plus content
 * defaults to having a trailing newline (POSIX convention).
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
  | { kind: "float"; value: number }
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
  duplicate: boolean; // true if this is the 2nd+ occurrence of the name
};

type SourceModel = {
  lines: string[];
  trailingNewline: boolean;
  sections: SectionLocation[];
};

const KEY_LINE = /^(\s*)([A-Za-z_][A-Za-z0-9_\-]*)\s*=\s*/;
const SECTION_HEADER = /^\s*\[\s*([^\[\]]+?)\s*\]\s*(#.*)?$/;
const ARRAY_OF_TABLES_HEADER = /^\s*\[\[\s*([^\[\]]+?)\s*\]\]\s*(#.*)?$/;
const INTEGER_LITERAL = /^-?\d+$/;
const FLOAT_LITERAL = /^-?(?:\d+\.\d+(?:[eE][-+]?\d+)?|\d+[eE][-+]?\d+)$/;

/**
 * Parse a TOML source into a flat `tables[sectionName][key] = value` map.
 *
 * Strict on syntax (throws on malformed lines or empty section headers) but
 * lenient on value kinds — values our value parser doesn't recognize log a
 * warning and the key is dropped from the table. The schema-aware
 * normalization layer treats missing keys as defaults, so an exotic value
 * in an unknown section can't kill a config read.
 *
 * Duplicate section headers: first occurrence wins. Subsequent occurrences
 * log a warning and their keys are ignored.
 */
export function parseTomlTables(source: string, filePath: string): TomlTables {
  const lines = source.split(/\r?\n/);
  const tables: TomlTables = {};
  const seenSections = new Set<string>();
  let currentTable = "";
  let skipSection = false;

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
      const name = sectionMatch[1].trim();
      if (!name) {
        throw new Error(`Invalid TOML table on line ${i + 1} in ${filePath}`);
      }
      if (seenSections.has(name)) {
        console.warn(
          `Duplicate section [${name}] on line ${i + 1} in ${filePath} — using the first occurrence; subsequent keys are ignored.`,
        );
        skipSection = true;
      } else {
        seenSections.add(name);
        currentTable = name;
        tables[currentTable] ??= {};
        skipSection = false;
      }
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

    if (skipSection) {
      i = endLine + 1;
      continue;
    }

    const valueText = sliceValueText(lines, i, valueStartCol, endLine);
    const parsed = tryParseValue(valueText);
    if (!parsed) {
      console.warn(
        `Skipping unsupported TOML value for key '${key}' on line ${i + 1} in ${filePath}.`,
      );
      i = endLine + 1;
      continue;
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
  const plan = planEdits(model, edits);
  if (plan.lineOps.length === 0 && plan.newSections.length === 0) {
    return source;
  }
  const newLines = executePlan(model, plan);
  return joinLines(newLines, model.trailingNewline);
}

// =============================================================================
// Source parsing (used by the editor; lenient where parseTomlTables is strict)
// =============================================================================

function parseSource(source: string): SourceModel {
  // Treat empty source as "should end with \n once we add content".
  const hadTrailingNewline = source.endsWith("\n");
  const trailingNewline = hadTrailingNewline || source.length === 0;
  const body = hadTrailingNewline ? source.slice(0, -1) : source;
  const lines = body.length === 0 ? [] : body.split("\n");

  const sections: SectionLocation[] = [
    { name: "", headerLine: -1, keys: [], duplicate: false },
  ];
  const seenNames = new Set<string>();

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
      const name = sectionMatch[1].trim();
      const duplicate = seenNames.has(name);
      if (!duplicate) seenNames.add(name);
      sections.push({ name, headerLine: i, keys: [], duplicate });
      i += 1;
      continue;
    }

    const keyMatch = KEY_LINE.exec(line);
    if (!keyMatch) {
      // Unknown line shape — leave it alone.
      i += 1;
      continue;
    }

    const valueStartCol = keyMatch[0].length;
    const endLine = findValueEndLine(lines, i, valueStartCol);
    const currentSection = sections[sections.length - 1];
    // Skip recording keys in duplicate sections so edits never target them.
    if (!currentSection.duplicate) {
      currentSection.keys.push({
        name: keyMatch[2],
        startLine: i,
        endLine,
      });
    }
    i = endLine + 1;
  }

  return { lines, trailingNewline, sections };
}

function joinLines(lines: string[], trailingNewline: boolean): string {
  if (lines.length === 0) {
    return "";
  }
  return lines.join("\n") + (trailingNewline ? "\n" : "");
}

// =============================================================================
// Edit planning: turn a list of TomlEdits into concrete line operations,
// computed against the original model (no re-parsing per edit).
// =============================================================================

type LineOp =
  | {
      kind: "replace";
      startLine: number;
      endLine: number;
      newLines: readonly string[];
    }
  | { kind: "insert"; insertionLine: number; newLines: readonly string[] };

type NewSectionPlan = {
  tableName: string;
  keyLines: string[]; // already formatted, including any multi-line entries
};

type EditPlan = {
  lineOps: LineOp[];
  newSections: NewSectionPlan[];
};

function planEdits(model: SourceModel, edits: readonly TomlEdit[]): EditPlan {
  const lineOps: LineOp[] = [];
  // Insertion order is preserved by Map iteration, so all keys destined for
  // the same nonexistent section land in one new section in the order they
  // were requested.
  const newSections = new Map<string, string[]>();

  for (const edit of edits) {
    const { tableName, keyName } = splitPath(edit.path);
    const section = findSection(model, tableName);

    if (edit.op === "delete") {
      if (!section) continue;
      const key = section.keys.find((k) => k.name === keyName);
      if (!key) continue;
      lineOps.push({
        kind: "replace",
        startLine: key.startLine,
        endLine: key.endLine,
        newLines: [],
      });
      continue;
    }

    // op: set
    if (!section) {
      const formatted = formatKeyValue(keyName, edit.value, "");
      let bucket = newSections.get(tableName);
      if (!bucket) {
        bucket = [];
        newSections.set(tableName, bucket);
      }
      bucket.push(...formatted);
      continue;
    }

    const existingKey = section.keys.find((k) => k.name === keyName);
    if (existingKey) {
      const existingValue = parseExistingValue(model.lines, existingKey);
      if (existingValue && valuesEqual(existingValue, edit.value)) {
        continue; // no-op set
      }
      lineOps.push({
        kind: "replace",
        startLine: existingKey.startLine,
        endLine: existingKey.endLine,
        newLines: formatKeyValue(keyName, edit.value, ""),
      });
      continue;
    }

    lineOps.push({
      kind: "insert",
      insertionLine: computeKeyInsertionLine(model, section),
      newLines: formatKeyValue(keyName, edit.value, ""),
    });
  }

  const newSectionPlans: NewSectionPlan[] = [];
  for (const [tableName, keyLines] of newSections) {
    newSectionPlans.push({ tableName, keyLines });
  }

  return { lineOps, newSections: newSectionPlans };
}

function executePlan(model: SourceModel, plan: EditPlan): string[] {
  // Bucket line ops by line. Each line index can have:
  //   - at most one "replace" (since edits don't overlap on existing keys)
  //   - any number of "insert" blocks (preserved in arrival order)
  const replaceAt = new Map<
    number,
    { endLine: number; newLines: readonly string[] }
  >();
  const insertsAt = new Map<number, string[][]>();

  for (const op of plan.lineOps) {
    if (op.kind === "replace") {
      replaceAt.set(op.startLine, {
        endLine: op.endLine,
        newLines: op.newLines,
      });
    } else {
      let bucket = insertsAt.get(op.insertionLine);
      if (!bucket) {
        bucket = [];
        insertsAt.set(op.insertionLine, bucket);
      }
      bucket.push([...op.newLines]);
    }
  }

  // Walk the original lines once, emitting a new array.
  const result: string[] = [];
  let i = 0;
  while (i < model.lines.length) {
    const inserts = insertsAt.get(i);
    if (inserts) {
      for (const block of inserts) {
        for (const ln of block) result.push(ln);
      }
    }

    const replace = replaceAt.get(i);
    if (replace) {
      for (const ln of replace.newLines) result.push(ln);
      i = replace.endLine + 1;
      continue;
    }

    result.push(model.lines[i]);
    i += 1;
  }
  // Inserts targeted at one-past-the-last line:
  const eofInserts = insertsAt.get(model.lines.length);
  if (eofInserts) {
    for (const block of eofInserts) {
      for (const ln of block) result.push(ln);
    }
  }

  // Append new sections at end of file, separated by a blank line each.
  for (const section of plan.newSections) {
    if (result.length > 0 && result[result.length - 1].trim().length !== 0) {
      result.push("");
    }
    if (section.tableName.length > 0) {
      result.push(`[${section.tableName}]`);
    }
    for (const ln of section.keyLines) result.push(ln);
  }

  return result;
}

// =============================================================================
// Section / key location helpers
// =============================================================================

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
  // First-wins: scan from the start so duplicate section headers are inert
  // for editing purposes (the duplicate-detection in parseSource also skips
  // recording keys for them on read).
  for (const section of model.sections) {
    if (section.name === name && !section.duplicate) {
      return section;
    }
  }
  return undefined;
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

  let cursor = sectionEnd - 1;
  const lastKey = section.keys[section.keys.length - 1];
  const lastOwnedLine = lastKey ? lastKey.endLine : section.headerLine;

  while (cursor > lastOwnedLine && model.lines[cursor].trim().length === 0) {
    cursor -= 1;
  }

  return cursor + 1;
}

// =============================================================================
// Value parsing (read-side)
// =============================================================================

function parseExistingValue(
  lines: string[],
  key: KeyLocation,
): ParsedValue | undefined {
  const firstLine = lines[key.startLine];
  const match = KEY_LINE.exec(firstLine);
  if (!match) return undefined;
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
  if (text.length === 0) return undefined;

  if (text === "true") return { kind: "boolean", value: true };
  if (text === "false") return { kind: "boolean", value: false };

  if (INTEGER_LITERAL.test(text)) {
    const value = Number(text);
    return Number.isFinite(value) ? { kind: "integer", value } : undefined;
  }
  if (FLOAT_LITERAL.test(text)) {
    const value = Number(text);
    return Number.isFinite(value) ? { kind: "float", value } : undefined;
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
  const last = findArrayClose(text, 0);
  if (last === -1 || last !== text.length - 1) return undefined;
  const inner = text.slice(1, last);
  const elements = splitTopLevel(inner, ",");
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

function parseInlineTable(
  text: string,
): Record<string, TomlEditScalar> | undefined {
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
      || parsed.kind === "float"
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
  // Strip line comments first so we don't have to track them inside the loop.
  const cleaned = stripCommentsAcrossLines(text);
  const parts: string[] = [];
  let depth = 0;
  let inDQ = false;
  let inSQ = false;
  let escaped = false;
  let start = 0;
  for (let i = 0; i < cleaned.length; i += 1) {
    const ch = cleaned[i];
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
    if (ch === sep && depth === 0) {
      parts.push(cleaned.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(cleaned.slice(start));
  return parts;
}

function stripCommentsAcrossLines(text: string): string {
  return text
    .split("\n")
    .map((line) => stripComment(line))
    .join("\n");
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
  const lines = text.split("\n");
  const lastLine = lines[lines.length - 1];
  lines[lines.length - 1] = stripComment(lastLine);
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
  if (i >= first.length) return startLine;
  const ch = first[i];
  if (ch !== "[" && ch !== "{") {
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
  return lines.length - 1;
}

function valuesEqual(parsed: ParsedValue, requested: TomlEditValue): boolean {
  if (parsed.kind === "boolean" && typeof requested === "boolean") {
    return parsed.value === requested;
  }
  if (
    (parsed.kind === "integer" || parsed.kind === "float")
    && typeof requested === "number"
  ) {
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

// =============================================================================
// Value formatting (write-side)
// =============================================================================

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
  if (typeof value === "number") return formatNumber(value);
  return formatString(value);
}

function formatNumber(value: number): string {
  // Integer values that happen to be whole numbers still emit without a
  // decimal point — matches how the editor parses them back as integers.
  // For non-integer numbers, JS's default String() produces a TOML-valid
  // float literal.
  return String(value);
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
