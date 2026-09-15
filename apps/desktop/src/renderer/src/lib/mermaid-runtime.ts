import mermaid from "mermaid";

export type DiagramPalette = {
  background: string;
  foreground: string;
  line: string;
  surface: string;
  accent: string;
};

const cache = new Map<string, string>();
let cacheCharacters = 0;
let queue: Promise<unknown> = Promise.resolve();
let sequence = 0;

/** Mermaid has global configuration and temporary DOM: serialize both. */
export function renderMermaid(
  source: string,
  palette: DiagramPalette,
  isCurrent: () => boolean,
): Promise<string | undefined> {
  const job = queue.then(async () => {
    if (!isCurrent()) return undefined;
    const key = JSON.stringify([source, palette]);
    const cached = cache.get(key);
    if (cached) {
      cache.delete(key);
      cache.set(key, cached);
      return cached;
    }
    // Transcript text must not override security, resource limits, or inject CSS.
    if (source.length > 20_000
      || /%%\s*\{|^\s*---/.test(source)
      || /\b(?:https?|file|data|javascript):|url\s*\(|\bimg\s*:|\b(?:style|classDef|linkStyle)\s/im.test(source)) {
      throw new Error("Unsupported diagram configuration or size");
    }
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      maxTextSize: 20_000,
      maxEdges: 200,
      htmlLabels: false,
      theme: "base",
      themeVariables: {
        background: palette.background,
        primaryColor: palette.surface,
        primaryTextColor: palette.foreground,
        primaryBorderColor: palette.accent,
        secondaryColor: palette.surface,
        tertiaryColor: palette.background,
        lineColor: palette.line,
        textColor: palette.foreground,
        edgeLabelBackground: palette.background,
        fontFamily: "system-ui, sans-serif",
      },
      flowchart: { htmlLabels: false },
    });
    const container = document.createElement("div");
    container.style.position = "fixed";
    container.style.visibility = "hidden";
    container.style.pointerEvents = "none";
    container.setAttribute("aria-hidden", "true");
    document.body.append(container);
    try {
      const { svg } = await mermaid.render(`pwragent-mermaid-${++sequence}`, source, container);
      // An SVG image has no active links/scripts and cannot load external resources.
      // Never inject generated SVG into the transcript or call bindFunctions.
      const image = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      if (image.length <= 1_000_000) {
        cache.set(key, image);
        cacheCharacters += key.length + image.length;
        while (cache.size > 32 || cacheCharacters > 4_000_000) {
          const oldest = cache.keys().next().value!;
          cacheCharacters -= oldest.length + cache.get(oldest)!.length;
          cache.delete(oldest);
        }
      }
      return image;
    } finally {
      container.remove();
    }
  });
  queue = job.catch(() => undefined);
  return job;
}
