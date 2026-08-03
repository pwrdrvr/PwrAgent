import { fromMarkdown } from "mdast-util-from-markdown";

type ProtectedRange = {
  end: number;
  start: number;
};

type Fence = {
  length: number;
  marker: "`" | "~";
};

type ClosingDelimiterSearch = {
  closingIndex: number;
  unmatchedUntil: number;
};

type PositionedMarkdownNode = {
  children?: PositionedMarkdownNode[];
  position?: {
    end: { offset?: number };
    start: { offset?: number };
  };
  type: string;
};

/**
 * Convert the LaTeX delimiters emitted by Codex into the dollar-delimited
 * syntax understood by remark-math. Each delimiter stays two characters long,
 * so mdast source offsets still line up with the original transcript text.
 *
 * CommonMark otherwise consumes the backslash in `\(`, `\[`, and spacing
 * commands such as `\;` as punctuation escapes before a renderer can see that
 * they belong to a math expression.
 */
export function normalizeLatexMathDelimiters(markdown: string): string {
  if (!markdown.includes("\\(") && !markdown.includes("\\[")) {
    return markdown;
  }

  const protectedRanges = collectProtectedCodeRanges(markdown);
  const characters = markdown.split("");
  let changed = false;
  let index = 0;
  let unmatchedDisplayUntil = 0;
  let unmatchedInlineUntil = 0;

  while (index < markdown.length - 1) {
    const protectedRange = protectedRangeAt(protectedRanges, index);
    if (protectedRange) {
      index = protectedRange.end;
      continue;
    }

    if (
      markdown[index] !== "\\"
      || isEscapedBackslash(markdown, index)
      || (markdown[index + 1] !== "(" && markdown[index + 1] !== "[")
    ) {
      index += 1;
      continue;
    }

    const inline = markdown[index + 1] === "(";
    const openingCharacter = inline ? "(" : "[";
    const unmatchedUntil = inline
      ? unmatchedInlineUntil
      : unmatchedDisplayUntil;
    if (index < unmatchedUntil) {
      index += 2;
      continue;
    }
    const closingCharacter = inline ? ")" : "]";
    const search = findClosingDelimiter(
      markdown,
      index + 2,
      openingCharacter,
      closingCharacter,
      inline,
      protectedRanges,
    );

    if (search.closingIndex === -1) {
      if (inline) {
        unmatchedInlineUntil = search.unmatchedUntil;
      } else {
        unmatchedDisplayUntil = search.unmatchedUntil;
      }
      index += 2;
      continue;
    }

    characters[index] = "$";
    characters[index + 1] = "$";
    characters[search.closingIndex] = "$";
    characters[search.closingIndex + 1] = "$";
    changed = true;
    index = search.closingIndex + 2;
  }

  return changed ? characters.join("") : markdown;
}

function findClosingDelimiter(
  markdown: string,
  start: number,
  openingCharacter: "(" | "[",
  closingCharacter: ")" | "]",
  inline: boolean,
  protectedRanges: ProtectedRange[],
): ClosingDelimiterSearch {
  for (let index = start; index < markdown.length - 1; index += 1) {
    if (inline && markdown[index] === "\n") {
      return { closingIndex: -1, unmatchedUntil: index + 1 };
    }

    const protectedRange = protectedRangeAt(protectedRanges, index);
    if (protectedRange) {
      return { closingIndex: -1, unmatchedUntil: protectedRange.end };
    }

    if (markdown[index] === "\\" && !isEscapedBackslash(markdown, index)) {
      if (markdown[index + 1] === closingCharacter) {
        return { closingIndex: index, unmatchedUntil: 0 };
      }
      if (markdown[index + 1] === openingCharacter) {
        return { closingIndex: -1, unmatchedUntil: index };
      }
    }
  }

  return { closingIndex: -1, unmatchedUntil: markdown.length };
}

function isEscapedBackslash(value: string, index: number): boolean {
  let precedingBackslashes = 0;
  for (let scanIndex = index - 1; scanIndex >= 0; scanIndex -= 1) {
    if (value[scanIndex] !== "\\") {
      break;
    }
    precedingBackslashes += 1;
  }
  return precedingBackslashes % 2 === 1;
}

function collectProtectedCodeRanges(markdown: string): ProtectedRange[] {
  if (hasPotentialIndentedCode(markdown)) {
    return collectParsedCodeRanges(markdown);
  }

  const blockRanges = collectProtectedBlockRanges(markdown);
  const codeSpanRanges: ProtectedRange[] = [];
  let index = 0;

  while (index < markdown.length) {
    const blockRange = protectedRangeAt(blockRanges, index);
    if (blockRange) {
      index = blockRange.end;
      continue;
    }

    if (markdown[index] !== "`") {
      index += 1;
      continue;
    }

    const openingLength = countRun(markdown, index, "`");
    const closingIndex = findClosingCodeSpan(
      markdown,
      index + openingLength,
      openingLength,
      blockRanges,
    );
    if (closingIndex === -1) {
      index += openingLength;
      continue;
    }

    const end = closingIndex + openingLength;
    codeSpanRanges.push({ start: index, end });
    index = end;
  }

  return mergeRanges([...blockRanges, ...codeSpanRanges]);
}

/**
 * Indentation is context-sensitive in CommonMark: four leading spaces can be
 * an indented code block, ordinary paragraph continuation, or list-item
 * content. When a message contains an ambiguous line, use the same mdast
 * parser family as ReactMarkdown as the authority for code-node ranges rather
 * than guessing from the raw prefix.
 */
function collectParsedCodeRanges(markdown: string): ProtectedRange[] {
  const ranges: ProtectedRange[] = [];

  function visit(node: PositionedMarkdownNode): void {
    if (node.type === "code" || node.type === "inlineCode") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) {
        ranges.push({ start, end });
      }
      return;
    }
    for (const child of node.children ?? []) {
      visit(child);
    }
  }

  visit(fromMarkdown(markdown) as PositionedMarkdownNode);
  return mergeRanges(ranges);
}

function hasPotentialIndentedCode(markdown: string): boolean {
  return /(?:^|\n)(?: {0,3}>[ \t]?)*(?: {4}| {0,3}\t)/.test(markdown);
}

function collectProtectedBlockRanges(markdown: string): ProtectedRange[] {
  const ranges: ProtectedRange[] = [];
  let activeFence: (Fence & { start: number }) | undefined;
  let lineStart = 0;

  while (lineStart < markdown.length) {
    const newlineIndex = markdown.indexOf("\n", lineStart);
    const lineEnd = newlineIndex === -1 ? markdown.length : newlineIndex + 1;
    const line = markdown.slice(
      lineStart,
      newlineIndex === -1 ? markdown.length : newlineIndex,
    );
    const fence = parseFence(line, !activeFence);

    if (activeFence) {
      if (
        fence
        && fence.marker === activeFence.marker
        && fence.length >= activeFence.length
        && isClosingFenceLine(line)
      ) {
        ranges.push({ start: activeFence.start, end: lineEnd });
        activeFence = undefined;
      }
    } else if (fence) {
      activeFence = { ...fence, start: lineStart };
    }

    lineStart = lineEnd;
  }

  if (activeFence) {
    ranges.push({ start: activeFence.start, end: markdown.length });
  }

  return ranges;
}

function parseFence(line: string, allowListMarker: boolean): Fence | undefined {
  const candidate = stripMarkdownContainerPrefix(line, allowListMarker);
  const match = /^ {0,3}(`{3,}|~{3,})(.*?)(?:\r)?$/.exec(candidate);
  if (!match) {
    return undefined;
  }

  const sequence = match[1] ?? "";
  const info = match[2] ?? "";
  if (sequence.startsWith("`") && info.includes("`")) {
    return undefined;
  }

  return {
    length: sequence.length,
    marker: sequence[0] as Fence["marker"],
  };
}

function isClosingFenceLine(line: string): boolean {
  const candidate = stripMarkdownContainerPrefix(line, false);
  return /^ {0,3}(?:`{3,}|~{3,})[ \t]*(?:\r)?$/.test(candidate);
}

function stripMarkdownContainerPrefix(
  line: string,
  allowListMarker: boolean,
): string {
  let candidate = line;
  while (/^ {0,3}>[ \t]?/.test(candidate)) {
    candidate = candidate.replace(/^ {0,3}>[ \t]?/, "");
  }
  return allowListMarker
    ? candidate.replace(/^ {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+/, "")
    : candidate;
}

function findClosingCodeSpan(
  markdown: string,
  start: number,
  openingLength: number,
  blockRanges: ProtectedRange[],
): number {
  let index = start;
  while (index < markdown.length) {
    const blockRange = protectedRangeAt(blockRanges, index);
    if (blockRange) {
      index = blockRange.end;
      continue;
    }

    const candidate = markdown.indexOf("`", index);
    if (candidate === -1) {
      return -1;
    }

    const candidateBlockRange = protectedRangeAt(blockRanges, candidate);
    if (candidateBlockRange) {
      index = candidateBlockRange.end;
      continue;
    }

    const candidateLength = countRun(markdown, candidate, "`");
    if (candidateLength === openingLength) {
      return candidate;
    }
    index = candidate + candidateLength;
  }

  return -1;
}

function countRun(value: string, start: number, character: string): number {
  let end = start;
  while (value[end] === character) {
    end += 1;
  }
  return end - start;
}

function protectedRangeAt(
  ranges: ProtectedRange[],
  index: number,
): ProtectedRange | undefined {
  let low = 0;
  let high = ranges.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const range = ranges[middle];
    if (!range) {
      return undefined;
    }
    if (index < range.start) {
      high = middle - 1;
    } else if (index >= range.end) {
      low = middle + 1;
    } else {
      return range;
    }
  }

  return undefined;
}

function mergeRanges(ranges: ProtectedRange[]): ProtectedRange[] {
  const sorted = ranges.slice().sort((left, right) => left.start - right.start);
  const merged: ProtectedRange[] = [];

  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }

  return merged;
}
