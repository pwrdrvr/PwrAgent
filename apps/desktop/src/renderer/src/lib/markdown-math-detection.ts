/**
 * Source-only loading hint, not a math parser. Keep this module dependency-free.
 * The runtime remains the authority on escaping, code, and complete pairs.
 * Inspect the repaired Markdown that will actually reach ReactMarkdown.
 */
export function hasPotentialMarkdownMath(markdown: string): boolean {
  if (markdown.includes("$$") || markdown.includes("\\(") || markdown.includes("\\[")) {
    return true;
  }

  // rehype-katex also renders language-math code fences. CommonMark decodes
  // character references and escapes in fence info strings, so ambiguous
  // encoded info must load too (for example m&#97;th). Do not guess container
  // indentation or code protection here: false positives preserve rendering.
  // Consume each candidate line once, including arbitrarily long fence runs.
  for (const match of markdown.matchAll(/(?:`{3}|~{3})[^\r\n]*/g)) {
    if (/math|[&\\]/.test(match[0])) {
      return true;
    }
  }
  return false;
}
