const INTERACTIVE_SVG_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
].join("; ");

/** Return a sandbox document only when the SVG has user-facing interactions. */
export function interactiveSvgDocument(source: string): string | undefined {
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
  return `<!doctype html><html><head>
    <meta http-equiv="Content-Security-Policy" content="${INTERACTIVE_SVG_CSP}">
    <meta name="referrer" content="no-referrer">
    <style>html, body { width: 100%; height: 100%; margin: 0; overflow: auto; } svg { display: block; width: 100%; }</style>
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
