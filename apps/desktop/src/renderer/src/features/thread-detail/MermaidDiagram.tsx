import { useEffect, useRef, useState } from "react";
import type { DesktopApi } from "../../lib/desktop-api";
import { createDiagramImage, type DiagramImage } from "../../lib/diagram-image";
import { ImageLightbox } from "./ImageLightbox";
import { ClipboardActionButton, ImageCopyButton } from "./ImageCopyButton";
import { getDesktopApi } from "../../lib/desktop-api";

export function MermaidDiagram(props: {
  source: string;
  desktopApi?: Pick<DesktopApi, "copyText">;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme);
  const [result, setResult] = useState<{ source: string; theme?: string; image?: DiagramImage }>();
  const [expanded, setExpanded] = useState(false);
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
    if (!visible || showSource || (result?.source === props.source && result.theme === theme)) return;
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
        .then((svg) => active && svg ? createDiagramImage(svg, color("--bg-app")) : undefined)
        .then((image) => {
          if (active) setResult({ source: props.source, theme, image });
        })
        .catch(() => {
          if (active) setResult({ source: props.source, theme });
        });
    }, 300);
    return () => { active = false; window.clearTimeout(timer); };
  }, [props.source, theme, visible, showSource, result]);

  const current = result?.source === props.source && result.theme === theme;
  const image = current ? result.image : undefined;
  const copySource = async () => {
    const api = props.desktopApi ?? getDesktopApi();
    if (api?.copyText) await api.copyText(props.source);
    else if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(props.source);
    else throw new Error("Text clipboard is unavailable");
  };
  return (
    <div className="transcript-message__pre-wrap mermaid-diagram" ref={root}>
      <div className="mermaid-diagram__toolbar">
        <span>{current && !image ? "Diagram unavailable" : "Mermaid"}</span>
        <button className="mermaid-diagram__toggle" type="button"
          aria-pressed={showSource} onClick={() => setShowSource(!showSource)}>
          {showSource ? "Show diagram" : "Show source"}
        </button>
        {image ? <ImageCopyButton src={image.src} appearance="chip" /> : null}
        <ClipboardActionButton key={props.source} label="Copy source" text="source"
          appearance="chip" copy={copySource} />
      </div>
      {image && !showSource ? (
        <div className="mermaid-diagram__viewport" tabIndex={0} aria-label="Mermaid diagram">
          <img src={image.src} width={image.width} height={image.height}
            style={{ width: image.width, height: image.height }}
            role="button" tabIndex={0} aria-label="Expand Mermaid diagram"
            onClick={() => setExpanded(true)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                setExpanded(true);
              }
            }}
            alt="Mermaid diagram; use Show source to read its definition" />
        </div>
      ) : (
        <pre className="transcript-message__pre" aria-label="Diagram source" tabIndex={0}>
          <code>{props.source}</code>
        </pre>
      )}
      {expanded && image ? <ImageLightbox src={image.src} alt="Mermaid diagram"
        dialogLabel="Expanded Mermaid diagram"
        actions={<ClipboardActionButton key={props.source} label="Copy source" text="source"
          appearance="pill" copy={copySource} />}
        onClose={() => setExpanded(false)} /> : null}
    </div>
  );
}
