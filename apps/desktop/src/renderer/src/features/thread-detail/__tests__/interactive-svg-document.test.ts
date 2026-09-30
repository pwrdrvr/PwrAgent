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

  it("rejects non-SVG documents", () => {
    expect(() => interactiveSvgDocument("<html/>"))
      .toThrow("Interactive SVG could not be parsed");
  });
});
