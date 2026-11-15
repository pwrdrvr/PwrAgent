import type { Options as ReactMarkdownOptions } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";
import "../styles/markdown-math.css";
import { normalizeLatexMathDelimiters } from "./markdown-math";
import { remarkBoundedMath } from "./remark-bounded-math";
import { remarkSingleDollarMath } from "./remark-single-dollar-math";

export type MarkdownMathRuntime = {
  normalize: typeof normalizeLatexMathDelimiters;
  rehypePlugins: NonNullable<ReactMarkdownOptions["rehypePlugins"]>;
  remarkPlugins: NonNullable<ReactMarkdownOptions["remarkPlugins"]>;
};

export const markdownMathRuntime: MarkdownMathRuntime = {
  normalize: normalizeLatexMathDelimiters,
  rehypePlugins: [
    [rehypeKatex, {
      maxExpand: 1_000,
      maxSize: 20,
      trust: false,
    }],
  ],
  remarkPlugins: [
    remarkMath,
    remarkBoundedMath,
    remarkSingleDollarMath,
  ],
};
