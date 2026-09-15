import { useEffect, useRef, useState } from "react";
import type { DesktopApi } from "../../lib/desktop-api";
import { TranscriptCopyButton } from "./TranscriptCopyButton";

export function MermaidDiagram(props: {
  source: string;
  desktopApi?: Pick<DesktopApi, "copyText">;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme);
  const [result, setResult] = useState<{ source: string; theme?: string; image?: string }>();
  const [showSource, setShowSource] = useState(false);

  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => {
      setVisible(entry?.isIntersecting ?? false);
    });
    if (root.current) observer.observe(root.current);
    const themes = new MutationObserver(() => setTheme(document.documentElement.dataset.theme));
    themes.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => { observer.disconnect(); themes.disconnect(); };
  }, []);

  useEffect(() => {
    if (!visible || showSource) return;
    let active = true;
    // Streaming text must settle before paying for parsing and layout.
    const timer = window.setTimeout(() => {
      const style = getComputedStyle(document.documentElement);
      const color = (token: string) => style.getPropertyValue(token).trim();
      void import("../../lib/mermaid-runtime")
        .then(({ renderMermaid }) => renderMermaid(props.source, {
          background: color("--bg-app"),
          foreground: color("--text-primary"),
          line: color("--text-secondary"),
          surface: color("--bg-panel"),
          accent: color("--accent"),
        }, () => active))
        .then((image) => {
          if (active) setResult({ source: props.source, theme, image });
        })
        .catch(() => {
          if (active) setResult({ source: props.source, theme });
        });
    }, 300);
    return () => { active = false; window.clearTimeout(timer); };
  }, [props.source, theme, visible, showSource]);

  const current = result?.source === props.source && result.theme === theme;
  const image = current ? result.image : undefined;
  return (
    <div className="transcript-message__pre-wrap mermaid-diagram" ref={root}>
      <div className="mermaid-diagram__toolbar">
        <span>{current && !image ? "Diagram unavailable" : "Mermaid"}</span>
        <button className="mermaid-diagram__toggle" type="button"
          aria-pressed={showSource} onClick={() => setShowSource(!showSource)}>
          {showSource ? "Show diagram" : "Show source"}
        </button>
        <TranscriptCopyButton className="mermaid-diagram__copy" desktopApi={props.desktopApi}
          label="Copy diagram source" copiedLabel="Copied diagram source" text={props.source} />
      </div>
      {image && !showSource ? (
        <div className="mermaid-diagram__viewport" tabIndex={0} aria-label="Mermaid diagram">
          <img src={image} alt="Mermaid diagram; use Show source to read its definition" />
        </div>
      ) : (
        <pre className="transcript-message__pre" aria-label="Diagram source" tabIndex={0}>
          <code>{props.source}</code>
        </pre>
      )}
    </div>
  );
}
