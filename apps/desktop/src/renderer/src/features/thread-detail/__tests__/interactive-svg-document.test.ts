import { describe, expect, it } from "vitest";
import { interactiveSvgDocument } from "../interactive-svg-document";

describe("interactiveSvgDocument", () => {
  it("puts SVG scripts behind an opaque-origin iframe policy", () => {
    const source = '<svg xmlns="http://www.w3.org/2000/svg" onload="init(evt)"><script>function init() {}</script></svg>';
    const document = interactiveSvgDocument(source);

    expect(document).toContain('http-equiv="Content-Security-Policy"');
    expect(document).toContain("default-src 'none'");
    expect(document).toContain("script-src 'unsafe-inline'");
    expect(document).toContain("form-action 'none'");
    expect(document).toContain("frame-src 'none'");
    expect(document).toContain("onload=\"init(evt)\"");
    expect(document).toContain("function init() {}");
  });

  it("declares the owner's color scheme so the frame stays transparent", () => {
    const source = '<svg xmlns="http://www.w3.org/2000/svg"><script>function init() {}</script></svg>';

    expect(interactiveSvgDocument(source)).toContain(":root { color-scheme: light; }");
    expect(interactiveSvgDocument(source, "dark")).toContain(":root { color-scheme: dark; }");
  });

  it("sizes only the root SVG, capped at its declared width", () => {
    const document = interactiveSvgDocument('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="390" viewBox="0 0 1200 390"><script>function init() {}</script><svg id="frames" width="1180"></svg></svg>');

    // A bare `svg` rule would also resize the nested frames <svg>, and an
    // uncapped `max-width` alone collapses a root whose script removes its
    // width to Chromium's 300px default.
    expect(document).not.toMatch(/(^|[;{}])\s*svg\s*\{/m);
    expect(document).toContain("body > svg {");
    expect(document).toContain("width: min(100%, 1200px);");
    // Only while a viewBox exists can the height follow the width without
    // clipping: a fluid flame graph removes it and keeps its pixel height.
    expect(document).toContain("body > svg[viewBox] { height: auto; }");
  });

  it("fills the frame when the SVG declares no pixel width", () => {
    const fluid = '<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="390"><script>function init() {}</script></svg>';
    const viewBoxOnly = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 100"><script>function init() {}</script></svg>';

    expect(interactiveSvgDocument(fluid)).toContain("width: 100%;");
    expect(interactiveSvgDocument(viewBoxOnly)).toContain("width: min(100%, calc(100vh * 4));");
  });

  it("rejects non-SVG documents", () => {
    expect(() => interactiveSvgDocument("<html/>"))
      .toThrow("Interactive SVG could not be parsed");
  });

  it("leaves inert SVGs in the image preview", () => {
    expect(interactiveSvgDocument('<svg xmlns="http://www.w3.org/2000/svg"><rect width="20" height="20"/></svg>'))
      .toBeUndefined();
  });

  it("recognizes event handlers and CSS hover interactions", () => {
    expect(interactiveSvgDocument('<svg xmlns="http://www.w3.org/2000/svg"><rect onclick="zoom()" width="20" height="20"/></svg>'))
      .toContain("onclick=");
    expect(interactiveSvgDocument('<svg xmlns="http://www.w3.org/2000/svg"><style>rect:hover { fill: red; }</style><rect width="20" height="20"/></svg>'))
      .toContain("rect:hover");
  });
});
