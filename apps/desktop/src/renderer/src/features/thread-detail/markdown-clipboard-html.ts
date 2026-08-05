import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import {
  protectComposerHyphenListItems,
  repairNestedLanguageFences,
} from "../../lib/markdown-fences";

// Renders transcript markdown to standalone semantic HTML for the clipboard's
// text/html flavor, so rich-text targets (Google Docs, Gmail, Word) paste
// formatted content while plain-text targets keep the raw markdown. Uses the
// same source repairs and remark plugins as ThreadMarkdown, minus the
// app-specific plugins (PR chips, table profiling, math) whose output only
// makes sense inside the renderer.
export function renderMarkdownToClipboardHtml(markdown: string): string {
  return renderToStaticMarkup(
    createElement(
      ReactMarkdown,
      { remarkPlugins: [remarkBreaks, remarkGfm] },
      protectComposerHyphenListItems(repairNestedLanguageFences(markdown)),
    ),
  );
}
