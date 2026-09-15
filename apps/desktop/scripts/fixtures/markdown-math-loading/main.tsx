import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MarkdownRenderingOptionsProvider } from "../../../src/renderer/src/lib/markdown-rendering-options";
import { ThreadMarkdown } from "../../../src/renderer/src/features/thread-detail/ThreadMarkdown";

const ordinary = "# Ordinary Markdown\n\nA **bold** $5 part and a $10 part.\n\n```ts\nconst x = 1;\n```";
function Fixture() {
  const [enabled, setEnabled] = useState(true);
  const [text, setText] = useState(ordinary);
  return <>
    <label><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />Math enabled</label>
    <label>Message<textarea value={text} onChange={(event) => setText(event.target.value)} /></label>
    <MarkdownRenderingOptionsProvider mathEnabled={enabled}>
      <section aria-label="Message"><ThreadMarkdown text={text} /></section>
      <section aria-label="Ordinary sibling"><ThreadMarkdown text={ordinary} /></section>
    </MarkdownRenderingOptionsProvider>
  </>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);
