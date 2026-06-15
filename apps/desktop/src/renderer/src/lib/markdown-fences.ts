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
export function repairNestedLanguageFences(markdown: string): string {
  if (!markdown.includes("```")) {
    return markdown;
  }

  const lines = markdown.split("\n");
  let changed = false;

  for (let index = 0; index < lines.length; index += 1) {
    const opening = parseBacktickFenceLine(lines[index] ?? "");
    if (!opening) {
      continue;
    }

    let closeIndex = -1;
    let depth = 1;
    let maxFenceLength = opening.length;
    let sawNestedLanguageFence = false;

    for (let scanIndex = index + 1; scanIndex < lines.length; scanIndex += 1) {
      const fence = parseBacktickFenceLine(lines[scanIndex] ?? "");
      if (!fence) {
        continue;
      }

      maxFenceLength = Math.max(maxFenceLength, fence.length);

      if (fence.info) {
        sawNestedLanguageFence = true;
        depth += 1;
        continue;
      }

      if (depth > 1) {
        depth -= 1;
        continue;
      }

      if (sawNestedLanguageFence) {
        closeIndex = scanIndex;
      }
      break;
    }

    if (closeIndex === -1) {
      continue;
    }

    const repairedFenceLength = maxFenceLength + 1;
    lines[index] = replaceBacktickFenceLine(lines[index] ?? "", repairedFenceLength);
    lines[closeIndex] = replaceBacktickFenceLine(
      lines[closeIndex] ?? "",
      repairedFenceLength,
    );
    changed = true;
    index = closeIndex;
  }

  return changed ? lines.join("\n") : markdown;
}
