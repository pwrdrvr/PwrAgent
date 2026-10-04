import { Marked, type MarkedToken, type Token, type TokenizerExtension } from "marked";

export type TelegramMarkdownToken =
  | { type: "telegram_details"; raw: string; open: boolean; summary: Token[]; tokens: Token[] }
  | { type: "telegram_math" | "telegram_math_block"; raw: string; text: string }
  | { type: "telegram_footnote_reference"; raw: string; name: string; number?: number; anchor?: string }
  | { type: "telegram_footnote_definition" | "telegram_footnote"; raw: string; name: string; tokens: Token[]; number?: number; anchor?: string };

const detailsDepth = new WeakMap<object, number>();
// Let Marked invoke block extensions at block boundaries. A start hint can
// otherwise truncate a paragraph before its inline code spans are parsed.
const extensions: TokenizerExtension[] = [
  {
    name: "telegram_details",
    level: "block",
    childTokens: ["summary", "tokens"],
    tokenizer(src) {
      const opening = /^ {0,3}<details(?:\s+(open))?\s*>[ \t]*(?:\n)?/i.exec(src);
      if (!opening) return;
      const end = detailsEnd(src, opening[0].length);
      if (end === undefined) return;
      const raw = src.slice(0, end.end);
      const depth = detailsDepth.get(this.lexer) ?? 0;
      if (depth >= 16) return { type: "html", raw, text: raw };
      const body = src.slice(opening[0].length, end.start);
      const summary = /^\s*<summary>([\s\S]*?)<\/summary>[ \t]*(?:\n)?/i.exec(body);
      detailsDepth.set(this.lexer, depth + 1);
      try {
        return {
          type: "telegram_details", raw, open: Boolean(opening[1]),
          summary: this.lexer.inline(summary?.[1] ?? "Details"),
          tokens: this.lexer.blockTokens(body.slice(summary?.[0].length ?? 0)
            .replace(/^(?:[ \t]*\n)+|(?:\n[ \t]*)+$/g, "")),
        };
      } finally {
        detailsDepth.set(this.lexer, depth);
      }
    },
  },
  {
    name: "telegram_footnote_definition",
    level: "block",
    childTokens: ["tokens"],
    tokenizer(src) {
      const match = /^ {0,3}\[\^([A-Za-z0-9_-]{1,64})\]:[ \t]*([^\n]*(?:\n(?: {4}|\t)[^\n]*)*)(?:\n|$)/.exec(src);
      if (!match) return;
      return {
        type: "telegram_footnote_definition", raw: match[0], name: match[1],
        tokens: this.lexer.inline(match[2]!.replace(/\n(?: {4}|\t)/g, "\n")),
      };
    },
  },
  {
    name: "telegram_math_block",
    level: "block",
    tokenizer(src) {
      const opening = /^ {0,3}(\$\$|\\\[)/.exec(src);
      if (!opening) return;
      const end = src.indexOf(opening[1] === "$$" ? "$$" : "\\]", opening[0].length);
      if (end < 0 || !/^[ \t]*(?:\n|$)/.test(src.slice(end + 2))) return;
      const text = src.slice(opening[0].length, end).trim();
      if (!text) return;
      return { type: "telegram_math_block", raw: src.slice(0, end + 2), text };
    },
  },
  {
    name: "telegram_footnote_reference",
    level: "inline",
    start: (src) => src.indexOf("[^"),
    tokenizer(src) {
      const match = /^\[\^([A-Za-z0-9_-]{1,64})\]/.exec(src);
      if (match) return { type: "telegram_footnote_reference", raw: match[0], name: match[1] };
    },
  },
  {
    name: "telegram_math",
    level: "inline",
    start: (src) => src.search(/\$|\\\(/),
    tokenizer(src) {
      if (src.startsWith("\\(")) {
        const end = src.indexOf("\\)", 2);
        const text = src.slice(2, end);
        if (end >= 0 && text.trim() && !text.includes("\n")) {
          return { type: "telegram_math", raw: src.slice(0, end + 2), text };
        }
        return;
      }
      if (!src.startsWith("$") || src.startsWith("$$") || /\s/.test(src[1] ?? " ")) return;
      for (let end = 1; end < src.length && src[end] !== "\n"; end += 1) {
        if (src[end] === "\\") { end += 1; continue; }
        if (src[end] === "`") return;
        if (src[end] !== "$") continue;
        // A closing delimiter cannot follow whitespace or precede a digit:
        // ordinary currency such as "$5 and $10" stays ordinary text.
        if (/\s/.test(src[end - 1]!) || /\d/.test(src[end + 1] ?? "")) return;
        return { type: "telegram_math", raw: src.slice(0, end + 1), text: src.slice(1, end) };
      }
    },
  },
];

const markdown = new Marked({ gfm: true, extensions });

export function lexTelegramMarkdown(text: string, anchorPrefix = "fn"): Token[] {
  const tokens = markdown.lexer(text);
  const definitions = new Map<string, Extract<TelegramMarkdownToken, { type: "telegram_footnote_definition" | "telegram_footnote" }>>();
  const references: Array<Extract<TelegramMarkdownToken, { type: "telegram_footnote_reference" }>> = [];
  walkRenderedTokens(tokens, (token) => {
    if (token.type === "telegram_footnote_definition" && !definitions.has(token.name)) {
      definitions.set(token.name, token as TelegramMarkdownToken & { type: "telegram_footnote_definition" });
    } else if (token.type === "telegram_footnote_reference") {
      references.push(token as TelegramMarkdownToken & { type: "telegram_footnote_reference" });
    }
  });
  const used = new Map<string, number>();
  for (const reference of references) {
    const definition = definitions.get(reference.name);
    if (!definition) continue;
    let number = used.get(reference.name);
    if (number === undefined) {
      number = used.size + 1;
      used.set(reference.name, number);
      definition.number = number;
      definition.anchor = `${anchorPrefix}-${number}`;
      // Definitions are rendered after the body. Follow only used notes,
      // after all body references, and visit each definition once so cycles
      // and repeated references cannot create extra notes or consume numbers.
      walkRenderedTokens(definition.tokens, (token) => {
        if (token.type === "telegram_footnote_reference") {
          references.push(token as TelegramMarkdownToken & { type: "telegram_footnote_reference" });
        }
      });
    }
    reference.number = number;
    reference.anchor = definition.anchor;
  }
  return [...tokens, ...[...used.keys()].map((name) => ({ ...definitions.get(name)!, type: "telegram_footnote" }))];
}

/** Walk the syntax rendered as formatting, leaving literal source opaque. */
function walkRenderedTokens(tokens: Token[], visit: (token: Token) => void): void {
  for (const item of tokens) {
    const token = item as MarkedToken | TelegramMarkdownToken;
    visit(token);
    if (token.type === "telegram_footnote_definition" || token.type === "image") continue;
    if (token.type === "table") {
      for (const row of [token.header, ...token.rows]) {
        for (const cell of row) walkRenderedTokens(cell.tokens, visit);
      }
    } else if (token.type === "list") {
      for (const entry of token.items) walkRenderedTokens(entry.tokens, visit);
    } else {
      if (token.type === "telegram_details") walkRenderedTokens(token.summary, visit);
      if ("tokens" in token && token.tokens) walkRenderedTokens(token.tokens, visit);
    }
  }
}

/** Match nested details while leaving tag-shaped source in code untouched. */
function detailsEnd(src: string, start: number): { start: number; end: number } | undefined {
  let depth = 1;
  let fence: { char: string; length: number } | undefined;
  let codeSpan: number | undefined;
  const lastCodeRun = new Map<number, number>();
  for (const match of src.matchAll(/`+/g)) lastCodeRun.set(match[0].length, match.index);
  let offset = start;
  for (const line of src.slice(start).split(/(?<=\n)/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})([^\n]*)/.exec(line);
    if (fence) {
      if (marker && marker[1]![0] === fence.char && marker[1]!.length >= fence.length
        && !marker[2]!.trim()) fence = undefined;
      offset += line.length;
      continue;
    }
    if (marker && (marker[1]![0] !== "`" || !marker[2]!.includes("`"))) {
      fence = { char: marker[1]![0]!, length: marker[1]!.length };
      codeSpan = undefined;
      offset += line.length;
      continue;
    }
    if (!line.trim()) codeSpan = undefined;
    if (codeSpan === undefined && /^( {4}|\t)/.test(line)) {
      offset += line.length;
      continue;
    }
    // Equal-length backtick runs delimit code, including multiline spans.
    for (const match of line.matchAll(/`+|<details(?:\s+open)?\s*>|<\/details\s*>/gi)) {
      if (match[0].startsWith("`")) {
        const length = match[0].length;
        if (codeSpan === length) codeSpan = undefined;
        else if (codeSpan === undefined && (lastCodeRun.get(length) ?? 0) > offset + match.index) codeSpan = length;
        continue;
      }
      if (codeSpan !== undefined) continue;
      depth += match[0].startsWith("</") ? -1 : 1;
      if (depth === 0) return { start: offset + match.index, end: offset + match.index + match[0].length };
    }
    offset += line.length;
  }
}
