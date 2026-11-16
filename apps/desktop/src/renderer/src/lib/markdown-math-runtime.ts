import type { Options as ReactMarkdownOptions } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";
import "../styles/markdown-math.css";
import { normalizeLatexMathDelimiters } from "./markdown-math";
import { remarkBoundedMath } from "./remark-bounded-math";
import { remarkSingleDollarMath } from "./remark-single-dollar-math";
import { rehypeMathCopy } from "./rehype-math-copy";
import { MathFormula } from "../features/thread-detail/MathFormula";

export type MarkdownMathRuntime = {
  normalize: typeof normalizeLatexMathDelimiters;
  rehypePlugins: NonNullable<ReactMarkdownOptions["rehypePlugins"]>;
  remarkPlugins: NonNullable<ReactMarkdownOptions["remarkPlugins"]>;
  components?: NonNullable<ReactMarkdownOptions["components"]> & { "math-formula": typeof MathFormula };
};

export const markdownMathRuntime: MarkdownMathRuntime = {
  components: { "math-formula": MathFormula },
  normalize: normalizeLatexMathDelimiters,
  rehypePlugins: [
    [rehypeKatex, {
      maxExpand: 1_000,
      maxSize: 20,
      trust: false,
    }],
    rehypeMathCopy,
  ],
  remarkPlugins: [
    remarkMath,
    remarkBoundedMath,
    remarkSingleDollarMath,
  ],
};
