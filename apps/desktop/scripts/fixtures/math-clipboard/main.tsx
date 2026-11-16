import { createRoot } from "react-dom/client";
import { MarkdownRenderingOptionsProvider } from "../../../src/renderer/src/lib/markdown-rendering-options";
import { ThreadMarkdown } from "../../../src/renderer/src/features/thread-detail/ThreadMarkdown";
import "../../../src/renderer/src/styles/app.css";
import type {} from "./types";

window.formulaClipboard = {};
const source = new URLSearchParams(location.search).get("source") ?? String.raw`## A bound on the sum

The correction is $q^{-4}$ for each pair. Summing over the edges gives

\[
\mathbb{E}\Phi \le \sum_{i\to j}(2d_i+2d_j) = 4\sum_i d_i^2 \le \frac{8e\Delta}{\sqrt{q}}.
\]

The bound separates the correction from the degree sum.`;

createRoot(document.getElementById("root")!).render(
  <main style={{ padding: 40, maxWidth: 960, margin: "auto" }}>
    <section aria-label="Example proof" style={{ padding: 24, border: "1px solid var(--border-subtle)", borderRadius: 8, background: "var(--bg-panel)" }}>
      <MarkdownRenderingOptionsProvider mathEnabled>
        <ThreadMarkdown text={source} desktopApi={{
          copyText: async (text) => { window.formulaClipboard = { text }; },
          copyRichText: async (payload) => { window.formulaClipboard = payload; },
        }} />
      </MarkdownRenderingOptionsProvider>
    </section>
  </main>,
);
