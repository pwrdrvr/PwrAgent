const INTERACTIVE_SVG_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
].join("; ");

/** Return a sandbox document only when the SVG has user-facing interactions.
 *
 *  `colorScheme` must be the scheme the owning `<iframe>` element uses, and the
 *  caller pins the same value on it. Chromium paints an opaque canvas — white
 *  for a light document — behind a frame whose scheme differs from its owner's,
 *  and `light dark` would follow the OS preference rather than the app theme. */
export function interactiveSvgDocument(
  source: string,
  colorScheme: "light" | "dark" = "light",
): string | undefined {
  const parsed = new DOMParser().parseFromString(source, "image/svg+xml");
  const svg = parsed.documentElement;
  if (
    svg.localName !== "svg"
    || svg.namespaceURI !== "http://www.w3.org/2000/svg"
    || parsed.getElementsByTagName("parsererror").length > 0
  ) {
    throw new Error("Interactive SVG could not be parsed");
  }

  const interactive = [svg, ...svg.querySelectorAll("*")].some((element) =>
    element.localName === "script"
    || (element.localName === "style" && /:(?:hover|active|focus)\b/i.test(element.textContent ?? ""))
    || [...element.attributes].some((attribute) => /^on[a-z]+$/i.test(attribute.name))
  );
  if (!interactive) return undefined;

  const serialized = new XMLSerializer().serializeToString(svg);
  const rootWidth = interactiveSvgRootWidth(svg);
  return `<!doctype html><html><head>
    <meta http-equiv="Content-Security-Policy" content="${INTERACTIVE_SVG_CSP}">
    <meta name="referrer" content="no-referrer">
    <style>:root { color-scheme: ${colorScheme}; } html { height: 100%; overflow: auto; } body { display: flex; flex-direction: column; min-height: 100%; margin: 0; } body > svg { display: block; flex: none; width: ${rootWidth}; margin: auto; background: Canvas; border-radius: 4px; } body > svg[viewBox] { height: auto; }</style>
    <script>
      (function() {
        const replaceState = history.replaceState.bind(history);
        history.replaceState = function() {
          try {
            replaceState.apply(null, arguments);
          } catch (error) {
            if (!error || error.name !== "SecurityError") throw error;
          }
        };
      })();
    </script>
  </head><body>${serialized}
    <script>
      window.addEventListener("click", function(event) {
        if (event.target && event.target.id === "search" && !window.searching) {
          event.preventDefault();
          event.stopImmediatePropagation();
          parent.postMessage("pwragent-interactive-svg-search", "*");
        }
      }, true);
      window.addEventListener("keydown", function(event) {
        if (event.key === "Escape") {
          parent.postMessage("pwragent-interactive-svg-escape", "*");
        } else if ((event.key === "F3" || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f")) && !window.searching) {
          event.preventDefault();
          event.stopImmediatePropagation();
          parent.postMessage("pwragent-interactive-svg-search", "*");
        }
      }, true);
      window.addEventListener("message", function(event) {
        if (event.source !== parent || !event.data || event.data.type !== "pwragent-interactive-svg-search-term") return;
        try {
          if (typeof search === "function") search(event.data.term);
        } catch (_) {
          parent.postMessage("pwragent-interactive-svg-search-error", "*");
        }
      });
    </script>
  </body></html>`;
}

const PIXEL_LENGTH = /^\s*(\d+(?:\.\d+)?|\.\d+)(?:px)?\s*$/;

/**
 * The root's CSS width, fixed when the document is built.
 *
 * It cannot be read back from the SVG later: inferno's fluid layout removes
 * the root's `width` and `viewBox` in its load handler, and an inline `<svg>`
 * with no width left is sized at the 300px replaced-element default. Capping
 * at the declared width matches the preview, which never upscales; an SVG that
 * declares no pixel width fills the frame, as it would as a document of its
 * own. The height is the SVG's own `height` attribute, except while a viewBox
 * gives it a ratio to follow (`body > svg[viewBox]`), so a fluid graph keeps
 * the pixel height its frames are laid out in.
 */
function interactiveSvgRootWidth(svg: Element): string {
  const width = PIXEL_LENGTH.exec(svg.getAttribute("width") ?? "");
  if (width && Number(width[1]) > 0) return `min(100%, ${Number(width[1])}px)`;
  const viewBox = (svg.getAttribute("viewBox") ?? "").trim().split(/[\s,]+/).map(Number);
  if (viewBox.length === 4 && viewBox[2] > 0 && viewBox[3] > 0) {
    return `min(100%, calc(100vh * ${viewBox[2] / viewBox[3]}))`;
  }
  return "100%";
}
