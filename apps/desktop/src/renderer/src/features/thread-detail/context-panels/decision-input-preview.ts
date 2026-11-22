/**
 * A batch item's input preview is its compact JSON, cut at about 2 KB. The
 * batch dialog shows it as labelled fields rather than JSON, so a cut
 * preview has to parse too: this reads as much of the text as is whole and
 * marks where it stopped. Pure, so the node test project covers it.
 */

export type PreviewValue =
  | { kind: "text"; text: string; cut?: true }
  | { kind: "scalar"; text: string }
  | { kind: "object"; entries: Array<[string, PreviewValue]>; cut?: true }
  | { kind: "array"; items: PreviewValue[]; cut?: true };

/** Thrown inside the parser when the text ends; caught at each container. */
class EndOfText extends Error {}

/** Thrown for text that is not JSON at all, whole or cut. */
class NotJson extends Error {}

/**
 * The preview's value. A whole preview is JSON; a cut one is read as far
 * as it goes. Returns undefined for text that is not JSON, or that ends
 * before any value starts.
 */
export function parseInputPreview(text: string, truncated: boolean): PreviewValue | undefined {
  if (!truncated) {
    try {
      return fromJson(JSON.parse(text));
    } catch {
      return undefined;
    }
  }
  return parsePartialPreview(text);
}

/**
 * Reads a cut preview as far as it goes. A value the text ends inside is
 * kept when part of it can be shown (a string, an object, an array) and
 * dropped when it cannot (a number or literal cut short).
 */
export function parsePartialPreview(text: string): PreviewValue | undefined {
  const parser = new PreviewParser(text);
  try {
    parser.skipSpace();
    const value = parser.value();
    // A cut container stops where its last whole value ends, before the
    // number, literal or key the text ends inside.
    if (isCut(value)) return value;
    parser.skipSpace();
    return parser.atEnd() ? value : undefined;
  } catch (error) {
    if (error instanceof EndOfText || error instanceof NotJson) return undefined;
    throw error;
  }
}

function fromJson(value: unknown): PreviewValue {
  if (typeof value === "string") return { kind: "text", text: value };
  if (Array.isArray(value)) return { kind: "array", items: value.map(fromJson) };
  if (value && typeof value === "object") {
    return { kind: "object", entries: Object.entries(value).map(([key, field]) => [key, fromJson(field)]) };
  }
  return { kind: "scalar", text: JSON.stringify(value) };
}

class PreviewParser {
  private at = 0;

  constructor(private readonly text: string) {}

  atEnd(): boolean {
    return this.at >= this.text.length;
  }

  skipSpace(): void {
    while (!this.atEnd() && /\s/.test(this.text[this.at]!)) this.at += 1;
  }

  private peek(): string {
    if (this.atEnd()) throw new EndOfText();
    return this.text[this.at]!;
  }

  value(): PreviewValue {
    const char = this.peek();
    if (char === "{") return this.object();
    if (char === "[") return this.array();
    if (char === "\"") return this.string();
    return this.scalar();
  }

  private object(): PreviewValue {
    this.at += 1;
    const entries: Array<[string, PreviewValue]> = [];
    try {
      this.skipSpace();
      if (this.peek() === "}") {
        this.at += 1;
        return { kind: "object", entries };
      }
      for (;;) {
        this.skipSpace();
        if (this.peek() !== "\"") throw new NotJson();
        const key = this.string();
        // A key the text cut is not a field yet.
        if (key.kind !== "text" || key.cut) throw new EndOfText();
        this.skipSpace();
        if (this.peek() !== ":") throw new NotJson();
        this.at += 1;
        this.skipSpace();
        const field = this.partial();
        if (!field) throw new EndOfText();
        entries.push([key.text, field]);
        if (isCut(field)) throw new EndOfText();
        this.skipSpace();
        const next = this.peek();
        this.at += 1;
        if (next === "}") return { kind: "object", entries };
        if (next !== ",") throw new NotJson();
      }
    } catch (error) {
      if (error instanceof EndOfText) return { kind: "object", entries, cut: true };
      throw error;
    }
  }

  private array(): PreviewValue {
    this.at += 1;
    const items: PreviewValue[] = [];
    try {
      this.skipSpace();
      if (this.peek() === "]") {
        this.at += 1;
        return { kind: "array", items };
      }
      for (;;) {
        this.skipSpace();
        const item = this.partial();
        if (item) items.push(item);
        if (!item || isCut(item)) throw new EndOfText();
        this.skipSpace();
        const next = this.peek();
        this.at += 1;
        if (next === "]") return { kind: "array", items };
        if (next !== ",") throw new NotJson();
      }
    } catch (error) {
      if (error instanceof EndOfText) return { kind: "array", items, cut: true };
      throw error;
    }
  }

  /** A value inside a container: undefined when the text ends before any of it can show. */
  private partial(): PreviewValue | undefined {
    try {
      return this.value();
    } catch (error) {
      if (error instanceof EndOfText) return undefined;
      throw error;
    }
  }

  private string(): PreviewValue {
    this.at += 1;
    let text = "";
    for (;;) {
      if (this.atEnd()) return { kind: "text", text, cut: true };
      const char = this.text[this.at]!;
      if (char === "\"") {
        this.at += 1;
        return { kind: "text", text };
      }
      if (char !== "\\") {
        text += char;
        this.at += 1;
        continue;
      }
      const escape = this.text[this.at + 1];
      if (escape === undefined) return { kind: "text", text, cut: true };
      if (escape === "u") {
        const hex = this.text.slice(this.at + 2, this.at + 6);
        if (hex.length < 4) return { kind: "text", text, cut: true };
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new NotJson();
        text += String.fromCharCode(Number.parseInt(hex, 16));
        this.at += 6;
        continue;
      }
      const decoded = ESCAPES[escape];
      if (decoded === undefined) throw new NotJson();
      text += decoded;
      this.at += 2;
    }
  }

  /** A number, true, false or null. One the text ends inside cannot be shown. */
  private scalar(): PreviewValue {
    const match = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(this.text.slice(this.at));
    if (!match) {
      if (isScalarPrefix(this.text.slice(this.at))) throw new EndOfText();
      throw new NotJson();
    }
    const end = this.at + match[0].length;
    // "12" at the very end may be the start of "123": not a whole value yet.
    if (end >= this.text.length && /\d$/.test(match[0])) throw new EndOfText();
    if (end < this.text.length && /[-0-9.eE+a-z]/.test(this.text[end]!)) {
      // "1." or "1e" at the very end: a number the cut ended inside.
      if (isScalarPrefix(this.text.slice(this.at))) throw new EndOfText();
      throw new NotJson();
    }
    this.at = end;
    return { kind: "scalar", text: match[0] };
  }
}

const ESCAPES: Record<string, string> = {
  "\"": "\"",
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

/** The rest of the text is the start of a number or literal the cut ended inside. */
function isScalarPrefix(rest: string): boolean {
  return rest.length > 0
    && (["true", "false", "null"].some((literal) => literal.startsWith(rest))
      || /^-?(?:0|[1-9]\d*)?(?:\.\d*)?(?:[eE][+-]?\d*)?$/.test(rest));
}

function isCut(value: PreviewValue): boolean {
  return value.kind !== "scalar" && value.cut === true;
}

/**
 * A one-line summary for the item list: the input's text when it is a
 * string, else its first text field, else its first field of any kind.
 */
export function previewSummary(value: PreviewValue | undefined, raw: string): string {
  if (!value) return raw;
  if (value.kind === "text") return value.text;
  if (value.kind === "object") {
    const text = value.entries.find(([, field]) => field.kind === "text");
    if (text) return (text[1] as { text: string }).text;
    const first = value.entries[0];
    if (first) return `${first[0]}: ${previewInline(first[1])}`;
    return value.cut ? raw : "{}";
  }
  return previewInline(value);
}

/** A value on one line: text as is, a container as compact JSON-like text. */
export function previewInline(value: PreviewValue): string {
  switch (value.kind) {
    case "text": return value.cut ? `${value.text}…` : value.text;
    case "scalar": return value.text;
    case "array":
      return `[${value.items.map(previewInline).join(", ")}${value.cut ? ", …" : ""}]`;
    case "object":
      return `{ ${value.entries.map(([key, field]) => `${key}: ${previewInline(field)}`).join(", ")}${value.cut ? ", …" : ""} }`;
  }
}
