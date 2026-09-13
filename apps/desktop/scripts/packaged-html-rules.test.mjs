import { describe, expect, it } from "vitest";
import { findRemoteScript, isRendererHtmlEntry } from "./packaged-html-rules.mjs";

describe("packaged HTML rules", () => {
  it("scopes the scan to the app's own renderer HTML", () => {
    expect(isRendererHtmlEntry("/out/renderer/index.html")).toBe(true);
    expect(isRendererHtmlEntry("/out/renderer/index.htm")).toBe(true);
  });

  it("ignores dependency HTML the app never loads", () => {
    // electron-builder auto-includes the production node_modules tree. A
    // dependency's playground page pointing at a CDN is not a packaging
    // defect in this repository, and failing a release on it would tell the
    // operator to unset a flag that has nothing to do with the file.
    expect(
      isRendererHtmlEntry("/node_modules/some-dep/demo/playground.html"),
    ).toBe(false);
    expect(isRendererHtmlEntry("/out/renderer/assets/index.js")).toBe(false);
  });

  it("detects the DevTools bridge the gate exists to stop", () => {
    // The returned snippet is what the failure message prints, so it has to
    // carry enough of the tag for an operator to recognize the offender.
    const snippet = findRemoteScript('<script src="http://localhost:8097"></script>');
    expect(snippet).toContain("<script");
    expect(snippet).toContain("http://");
  });

  it("detects remote scripts across quoting and protocol forms", () => {
    for (const markup of [
      `<script src='https://cdn.example.com/x.js'></script>`,
      `<script src=https://cdn.example.com/x.js></script>`,
      `<script src="//cdn.example.com/x.js"></script>`,
      `<script\n  type="module"\n  src="https://cdn.example.com/x.js"\n></script>`,
      `<script defer SRC = "HTTP://cdn.example.com/x.js"></script>`,
    ]) {
      expect(findRemoteScript(markup)).not.toBeNull();
    }
  });

  it("leaves local scripts alone", () => {
    for (const markup of [
      `<script type="module" src="/src/main.tsx"></script>`,
      `<script src="./assets/index.js"></script>`,
      `<script>console.info("http://localhost:8097")</script>`,
    ]) {
      expect(findRemoteScript(markup)).toBeNull();
    }
  });

  it("does not mistake hyphenated attributes for a src", () => {
    // `\bsrc` would match after the hyphen, failing a release over a
    // lazy-loading placeholder that loads nothing.
    expect(
      findRemoteScript('<script data-src="https://cdn.example.com/x.js"></script>'),
    ).toBeNull();
  });
});
