// Shared fenced-code-block helpers. Both the transcript renderer
// (`ThreadMarkdown`) and the composer's markdown parser
// (`ComposerTiptapInput`) use these so a nested code fence is interpreted the
// SAME way on display and on paste — otherwise the two surfaces disagree about
// where an outer block ends (see the "nested code block rendering" bug).

export type BacktickFenceLine = {
  carriageReturn: string;
  indent: string;
  info: string;
  length: number;
};

// Parse a line as an opening/closing backtick fence (3+ backticks, up to 3
// spaces of indent, an optional info string). Returns undefined for non-fence
// lines. Variable length matters: a closing fence must be at least as long as
// its opener, which is what lets a 3-backtick fence live inside a 4-backtick one.
export function parseBacktickFenceLine(line: string): BacktickFenceLine | undefined {
  const match = /^( {0,3})(`{3,})([^`\r\n]*?)[ \t]*(\r?)$/.exec(line);
  if (!match) {
    return undefined;
  }

  return {
    carriageReturn: match[4] ?? "",
    indent: match[1] ?? "",
    info: (match[3] ?? "").trim(),
    length: match[2]?.length ?? 0,
  };
}

export function replaceBacktickFenceLine(line: string, length: number): string {
  const parsed = parseBacktickFenceLine(line);
  if (!parsed) {
    return line;
  }

  const info = parsed.info ? parsed.info : "";
  return `${parsed.indent}${"`".repeat(length)}${info}${parsed.carriageReturn}`;
}

// Repair the "malformed nested code fence" pattern: an outer fence with no info
// string that contains an inner fence WITH a language (e.g. a ``` block whose
// body is itself a ```ts block). Markdown would close the outer block at the
// inner fence's bare close; we instead lengthen the outer open + its real close
// so the inner fence is preserved as content. Only fires when a nested
// language fence was actually seen, so well-formed blocks pass through untouched.
// Escape list items whose entire content is a hyphen run (`- ----`), which
// remark would otherwise parse as a thematic break instead of literal text.
// Fence-aware so hyphen runs inside code blocks stay untouched.
export function protectComposerHyphenListItems(markdown: string): string {
  const lines = markdown.split("\n");
  let fence: { marker: "`" | "~"; length: number } | undefined;

  return lines
    .map((line) => {
      const fenceLine = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
      if (fenceLine) {
        const sequence = fenceLine[1] ?? "";
        const marker = sequence[0] as "`" | "~";
        const trailing = fenceLine[2] ?? "";
        if (!fence) {
          fence = { marker, length: sequence.length };
        } else if (
          marker === fence.marker &&
          sequence.length >= fence.length &&
          trailing.trim() === ""
        ) {
          fence = undefined;
        }
        return line;
      }

      if (fence) {
        return line;
      }

      const hyphenOnlyListItem = line.match(/^(\s{0,3})-\s+(-+)(\s*)$/);
      if (!hyphenOnlyListItem || (hyphenOnlyListItem[2]?.length ?? 0) < 2) {
        return line;
      }

      return `${hyphenOnlyListItem[1]}- \\${hyphenOnlyListItem[2]}${hyphenOnlyListItem[3]}`;
    })
    .join("\n");
}

export function repairNestedLanguageFences(markdown: string): string {
  if (!markdown.includes("```")) {
    return markdown;
  }

  const lines = markdown.split("\n");
  type OpenFenceFrame = {
    lineIndex: number;
    maxInnerLength: number;
    openingLength: number;
    sawNestedLanguage: boolean;
  };
  const stack: OpenFenceFrame[] = [];
  let changed = false;

  // Single O(N) stack pass: pairs each opening fence with its matching bare
  // closing fence so well-formed blocks advance past their close (never
  // treating a closing ``` as a new opener) and unclosed fences never rescan
  // the remainder of the document.
  for (let index = 0; index < lines.length; index += 1) {
    const fence = parseBacktickFenceLine(lines[index] ?? "");
    if (!fence) {
      continue;
    }

    if (stack.length === 0) {
      stack.push({
        lineIndex: index,
        maxInnerLength: 0,
        openingLength: fence.length,
        sawNestedLanguage: false,
      });
      continue;
    }

    if (fence.info) {
      const parent = stack[stack.length - 1]!;
      parent.sawNestedLanguage = true;
      parent.maxInnerLength = Math.max(parent.maxInnerLength, fence.length);
      stack.push({
        lineIndex: index,
        maxInnerLength: 0,
        openingLength: fence.length,
        sawNestedLanguage: false,
      });
      continue;
    }

    const closing = stack.pop()!;
    if (stack.length > 0) {
      const parent = stack[stack.length - 1]!;
      parent.sawNestedLanguage = true;
      parent.maxInnerLength = Math.max(
        parent.maxInnerLength,
        closing.openingLength,
        closing.maxInnerLength,
        fence.length,
      );
      continue;
    }

    if (!closing.sawNestedLanguage) {
      continue;
    }

    // Already well-formed (outer opener & closer both exceed every inner fence)
    // passes through untouched, keeping repairNestedLanguageFences idempotent.
    const alreadyWellFormed =
      closing.openingLength > closing.maxInnerLength
      && fence.length >= closing.openingLength;
    if (alreadyWellFormed) {
      continue;
    }

    const repairedFenceLength =
      Math.max(closing.openingLength, closing.maxInnerLength, fence.length) + 1;
    lines[closing.lineIndex] = replaceBacktickFenceLine(
      lines[closing.lineIndex] ?? "",
      repairedFenceLength,
    );
    lines[index] = replaceBacktickFenceLine(lines[index] ?? "", repairedFenceLength);
    changed = true;
  }

  return changed ? lines.join("\n") : markdown;
}
