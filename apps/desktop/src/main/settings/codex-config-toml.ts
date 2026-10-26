/**
 * A read-only TOML parser for Codex `config.toml` files.
 *
 * PwrAgent's own TOML editor reads a subset of TOML, and it rejects some of
 * what Codex writes: quoted table names such as `[projects."/tmp"]`, inline
 * tables and multi-line strings. This parser reads the whole TOML 1.0 syntax
 * into plain objects, so an import can find `model_providers` in any file
 * Codex accepts. It never writes.
 *
 * It is lenient where leniency is harmless: it does not reject a table
 * defined twice, and it returns dates and times as their source text.
 * Every table is a null-prototype object, so a key such as `__proto__` is
 * just a key.
 */

export type CodexTomlTable = { [key: string]: CodexTomlValue };
export type CodexTomlValue = string | number | boolean | CodexTomlValue[] | CodexTomlTable;

export class CodexConfigTomlError extends Error {
  readonly line: number;

  constructor(reason: string, line: number) {
    super(`${reason} on line ${line}`);
    this.name = "CodexConfigTomlError";
    this.line = line;
  }
}

const BARE_KEY = /[A-Za-z0-9_-]/u;
const VALUE_CHAR = /[A-Za-z0-9_+\-.:]/u;
/** Integers and floats in decimal. */
const DECIMAL_NUMBER = /^[+-]?(?:0|[1-9](?:_?\d)*)(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?$/u;
const PREFIXED_INTEGER = /^0(?:x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*|o[0-7](?:_?[0-7])*|b[01](?:_?[01])*)$/u;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:\d{2})?)?$|^\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/u;

function newTable(): CodexTomlTable {
  return Object.create(null) as CodexTomlTable;
}

export function isCodexTomlTable(value: CodexTomlValue | undefined): value is CodexTomlTable {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseCodexConfigToml(source: string): CodexTomlTable {
  return new Parser(source.replace(/^\uFEFF/u, "")).parseDocument();
}

class Parser {
  private index = 0;
  private line = 1;

  constructor(private readonly text: string) {}

  parseDocument(): CodexTomlTable {
    const root = newTable();
    let current = root;
    for (;;) {
      this.skipWhitespaceAndComments();
      if (this.index >= this.text.length) return root;
      if (this.peek() === "[") {
        const arrayOfTables = this.text.startsWith("[[", this.index);
        this.index += arrayOfTables ? 2 : 1;
        this.skipSpaces();
        const path = this.parseKey();
        this.skipSpaces();
        if (!this.text.startsWith(arrayOfTables ? "]]" : "]", this.index)) {
          this.fail("Expected the end of a table header");
        }
        this.index += arrayOfTables ? 2 : 1;
        current = arrayOfTables ? this.appendTable(root, path) : this.openTable(root, path);
      } else {
        const path = this.parseKey();
        this.skipSpaces();
        if (this.peek() !== "=") this.fail("Expected = after a key");
        this.index += 1;
        this.skipSpaces();
        this.assign(current, path, this.parseValue());
      }
      this.endLine();
    }
  }

  /** `[a.b]`: walk to the table, creating it. An array means its last table. */
  private openTable(root: CodexTomlTable, path: string[]): CodexTomlTable {
    let table = root;
    for (const key of path) {
      const existing = table[key];
      if (existing === undefined) {
        const next = newTable();
        table[key] = next;
        table = next;
      } else if (isCodexTomlTable(existing)) {
        table = existing;
      } else if (Array.isArray(existing) && isCodexTomlTable(existing[existing.length - 1])) {
        table = existing[existing.length - 1] as CodexTomlTable;
      } else {
        this.fail(`"${path.join(".")}" is already a value`);
      }
    }
    return table;
  }

  private appendTable(root: CodexTomlTable, path: string[]): CodexTomlTable {
    const parent = this.openTable(root, path.slice(0, -1));
    const key = path[path.length - 1];
    const existing = parent[key];
    const entry = newTable();
    if (existing === undefined) {
      parent[key] = [entry];
    } else if (Array.isArray(existing)) {
      existing.push(entry);
    } else {
      this.fail(`"${path.join(".")}" is already a value`);
    }
    return entry;
  }

  private assign(table: CodexTomlTable, path: string[], value: CodexTomlValue): void {
    const parent = this.openTable(table, path.slice(0, -1));
    const key = path[path.length - 1];
    if (parent[key] !== undefined) this.fail(`"${path.join(".")}" is defined twice`);
    parent[key] = value;
  }

  /** A dotted key of bare and quoted parts. */
  private parseKey(): string[] {
    const parts: string[] = [];
    for (;;) {
      const char = this.peek();
      if (char === "\"") {
        parts.push(this.parseBasicString());
      } else if (char === "'") {
        parts.push(this.parseLiteralString());
      } else {
        const start = this.index;
        while (this.index < this.text.length && BARE_KEY.test(this.text[this.index])) this.index += 1;
        if (start === this.index) this.fail("Expected a key");
        parts.push(this.text.slice(start, this.index));
      }
      this.skipSpaces();
      if (this.peek() !== ".") return parts;
      this.index += 1;
      this.skipSpaces();
    }
  }

  private parseValue(): CodexTomlValue {
    const char = this.peek();
    if (this.text.startsWith("\"\"\"", this.index)) return this.parseMultilineBasicString();
    if (this.text.startsWith("'''", this.index)) return this.parseMultilineLiteralString();
    if (char === "\"") return this.parseBasicString();
    if (char === "'") return this.parseLiteralString();
    if (char === "[") return this.parseArray();
    if (char === "{") return this.parseInlineTable();
    return this.parseScalar();
  }

  private parseArray(): CodexTomlValue[] {
    this.index += 1;
    const values: CodexTomlValue[] = [];
    for (;;) {
      this.skipWhitespaceAndComments();
      if (this.peek() === "]") {
        this.index += 1;
        return values;
      }
      values.push(this.parseValue());
      this.skipWhitespaceAndComments();
      if (this.peek() === ",") {
        this.index += 1;
      } else if (this.peek() !== "]") {
        this.fail("Expected , or ] in an array");
      }
    }
  }

  private parseInlineTable(): CodexTomlTable {
    this.index += 1;
    const table = newTable();
    // TOML 1.0 keeps an inline table on one line; 1.1 allows newlines and a
    // trailing comma. Reading both costs nothing.
    for (;;) {
      this.skipWhitespaceAndComments();
      if (this.peek() === "}") {
        this.index += 1;
        return table;
      }
      const path = this.parseKey();
      this.skipSpaces();
      if (this.peek() !== "=") this.fail("Expected = in an inline table");
      this.index += 1;
      this.skipSpaces();
      this.assign(table, path, this.parseValue());
      this.skipWhitespaceAndComments();
      if (this.peek() === ",") {
        this.index += 1;
      } else if (this.peek() !== "}") {
        this.fail("Expected , or } in an inline table");
      }
    }
  }

  private parseScalar(): CodexTomlValue {
    const start = this.index;
    while (this.index < this.text.length && VALUE_CHAR.test(this.text[this.index])) this.index += 1;
    // A date and time may be separated by one space.
    if (
      /^\d{4}-\d{2}-\d{2}$/u.test(this.text.slice(start, this.index))
      && /^ \d{2}:/u.test(this.text.slice(this.index, this.index + 4))
    ) {
      this.index += 1;
      while (this.index < this.text.length && VALUE_CHAR.test(this.text[this.index])) this.index += 1;
    }
    const token = this.text.slice(start, this.index);
    if (!token) this.fail("Expected a value");
    if (token === "true") return true;
    if (token === "false") return false;
    if (/^[+-]?(?:inf|nan)$/u.test(token)) {
      return token.endsWith("nan") ? Number.NaN : token.startsWith("-") ? -Infinity : Infinity;
    }
    if (PREFIXED_INTEGER.test(token)) return Number(token.replace(/_/gu, ""));
    if (DECIMAL_NUMBER.test(token)) return Number(token.replace(/_/gu, ""));
    if (DATE_TIME.test(token)) return token;
    return this.fail(`Unsupported value ${JSON.stringify(token.slice(0, 40))}`);
  }

  private parseBasicString(): string {
    this.index += 1;
    let value = "";
    for (;;) {
      const char = this.text[this.index];
      if (char === undefined || char === "\n" || char === "\r") this.fail("Unterminated string");
      this.index += 1;
      if (char === "\"") return value;
      value += char === "\\" ? this.parseEscape() : char;
    }
  }

  private parseLiteralString(): string {
    this.index += 1;
    const end = this.text.slice(this.index).search(/['\r\n]/u);
    if (end < 0 || this.text[this.index + end] !== "'") this.fail("Unterminated string");
    const value = this.text.slice(this.index, this.index + end);
    this.index += end + 1;
    return value;
  }

  private parseMultilineBasicString(): string {
    this.index += 3;
    this.skipFirstNewline();
    let value = "";
    for (;;) {
      if (this.index >= this.text.length) this.fail("Unterminated string");
      if (this.text.startsWith("\"\"\"", this.index)) {
        // Up to two quotes may sit right before the closing three.
        let quotes = 3;
        while (quotes < 5 && this.text[this.index + quotes] === "\"") quotes += 1;
        value += "\"".repeat(quotes - 3);
        this.index += quotes;
        return value;
      }
      const char = this.text[this.index];
      this.index += 1;
      if (char === "\n") this.line += 1;
      if (char !== "\\") {
        value += char;
        continue;
      }
      // A backslash at the end of a line trims the newline and the
      // whitespace that follows it.
      const rest = /^[ \t]*\r?\n/u.exec(this.text.slice(this.index));
      if (rest) {
        this.index += rest[0].length;
        this.line += 1;
        while (/[ \t\r\n]/u.test(this.text[this.index] ?? "")) {
          if (this.text[this.index] === "\n") this.line += 1;
          this.index += 1;
        }
        continue;
      }
      value += this.parseEscape();
    }
  }

  private parseMultilineLiteralString(): string {
    this.index += 3;
    this.skipFirstNewline();
    const end = this.text.indexOf("'''", this.index);
    if (end < 0) this.fail("Unterminated string");
    let close = end + 3;
    while (close < end + 5 && this.text[close] === "'") close += 1;
    const value = this.text.slice(this.index, close - 3);
    this.line += value.split("\n").length - 1;
    this.index = close;
    return value;
  }

  private parseEscape(): string {
    const char = this.text[this.index];
    this.index += 1;
    switch (char) {
      case "b": return "\b";
      case "t": return "\t";
      case "n": return "\n";
      case "f": return "\f";
      case "r": return "\r";
      case "e": return "\u001b";
      case "\"": return "\"";
      case "\\": return "\\";
      case "u":
      case "U": {
        const length = char === "u" ? 4 : 8;
        const hex = this.text.slice(this.index, this.index + length);
        const codePoint = /^[0-9A-Fa-f]+$/u.test(hex) && hex.length === length ? Number.parseInt(hex, 16) : Number.NaN;
        if (!(codePoint <= 0x10ffff) || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
          this.fail("Invalid unicode escape");
        }
        this.index += length;
        return String.fromCodePoint(codePoint);
      }
      default:
        return this.fail("Invalid escape");
    }
  }

  private skipFirstNewline(): void {
    if (this.text.startsWith("\r\n", this.index)) {
      this.index += 2;
      this.line += 1;
    } else if (this.text[this.index] === "\n") {
      this.index += 1;
      this.line += 1;
    }
  }

  private peek(): string | undefined {
    return this.text[this.index];
  }

  private skipSpaces(): void {
    while (this.peek() === " " || this.peek() === "\t") this.index += 1;
  }

  private skipComment(): void {
    if (this.peek() !== "#") return;
    while (this.index < this.text.length && this.peek() !== "\n") this.index += 1;
  }

  private skipNewline(): boolean {
    if (this.text.startsWith("\r\n", this.index)) {
      this.index += 2;
    } else if (this.peek() === "\n") {
      this.index += 1;
    } else {
      return false;
    }
    this.line += 1;
    return true;
  }

  private skipWhitespaceAndComments(): void {
    for (;;) {
      this.skipSpaces();
      this.skipComment();
      if (!this.skipNewline()) return;
    }
  }

  /** After a header or key/value pair: only a comment may follow. */
  private endLine(): void {
    this.skipSpaces();
    this.skipComment();
    if (this.index < this.text.length && !this.skipNewline()) {
      this.fail("Expected the end of the line");
    }
  }

  private fail(reason: string): never {
    throw new CodexConfigTomlError(reason, this.line);
  }
}
