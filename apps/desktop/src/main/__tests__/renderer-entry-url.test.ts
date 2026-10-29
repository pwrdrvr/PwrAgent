import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { isAppRendererUrl, type RendererEntry } from "../renderer-entry-url";

const BUNDLE_ENTRY: RendererEntry = {
  kind: "file",
  value: "/Applications/PwrAgent.app/Contents/Resources/app.asar/out/renderer/index.html",
};
const BUNDLE_URL = pathToFileURL(BUNDLE_ENTRY.value).href;
const DEV_ENTRY: RendererEntry = { kind: "url", value: "http://localhost:5173/" };

describe("isAppRendererUrl from the bundle", () => {
  it("allows the bundled index.html with any hash or query", () => {
    expect(isAppRendererUrl(BUNDLE_URL, BUNDLE_ENTRY)).toBe(true);
    expect(isAppRendererUrl(`${BUNDLE_URL}#star-map`, BUNDLE_ENTRY)).toBe(true);
    expect(isAppRendererUrl(`${BUNDLE_URL}?window=activity#messaging-activity`, BUNDLE_ENTRY)).toBe(true);
  });

  it("matches a path containing characters Chromium percent-encodes", () => {
    const entry: RendererEntry = { kind: "file", value: "/Users/sample user/Pwr Agent/out/renderer/index.html" };
    const url = pathToFileURL(entry.value).href;
    expect(url).toContain("sample%20user/Pwr%20Agent");
    expect(isAppRendererUrl(url, entry)).toBe(true);
  });

  it("refuses any other local document, including siblings of the entry", () => {
    for (const url of [
      "file:///tmp/x.html",
      "file:///Users/sample/Downloads/preview.html",
      BUNDLE_URL.replace("index.html", "other.html"),
      BUNDLE_URL.replace("/renderer/index.html", "/index.html"),
      `${BUNDLE_URL}/extra`,
      BUNDLE_URL.replace("index.html", "../renderer-copy/index.html"),
      "file:///",
    ]) {
      expect(isAppRendererUrl(url, BUNDLE_ENTRY), url).toBe(false);
    }
  });

  it("resolves dot segments before comparing", () => {
    // The URL parser resolves dot segments, so this one IS the entry.
    expect(isAppRendererUrl(BUNDLE_URL.replace("/renderer/", "/renderer/../renderer/"), BUNDLE_ENTRY)).toBe(true);
    expect(isAppRendererUrl(BUNDLE_URL.replace("/renderer/", "/renderer/../main/"), BUNDLE_ENTRY)).toBe(false);
  });

  it("refuses an encoded separator and a remote file host", () => {
    expect(isAppRendererUrl(BUNDLE_URL.replace("/renderer/", "%2Frenderer%2F"), BUNDLE_ENTRY)).toBe(false);
    expect(isAppRendererUrl(BUNDLE_URL.replace("file:///", "file://attacker.example/"), BUNDLE_ENTRY)).toBe(false);
  });

  it("refuses every non-file URL, even the dev server's", () => {
    for (const url of [
      "http://localhost:5173/",
      "https://example.com/",
      "about:blank",
      "about:srcdoc",
      "data:text/html,<p>x</p>",
      "javascript:alert(1)",
      "not a url",
      "",
    ]) {
      expect(isAppRendererUrl(url, BUNDLE_ENTRY), url).toBe(false);
    }
    expect(isAppRendererUrl(undefined, BUNDLE_ENTRY)).toBe(false);
  });
});

describe("isAppRendererUrl from a dev server", () => {
  it("allows the dev server origin with any path, hash or query", () => {
    expect(isAppRendererUrl("http://localhost:5173/", DEV_ENTRY)).toBe(true);
    expect(isAppRendererUrl("http://localhost:5173/#star-map", DEV_ENTRY)).toBe(true);
    expect(isAppRendererUrl("http://localhost:5173/src/main.tsx?t=1", DEV_ENTRY)).toBe(true);
  });

  it("refuses every file URL, including the bundled entry", () => {
    expect(isAppRendererUrl(BUNDLE_URL, DEV_ENTRY)).toBe(false);
    expect(isAppRendererUrl("file:///tmp/x.html", DEV_ENTRY)).toBe(false);
  });

  it("refuses other origins, ports and schemes", () => {
    for (const url of [
      "http://localhost:5174/",
      "https://localhost:5173/",
      "http://127.0.0.1:5173/",
      "http://localhost.example.com:5173/",
      "about:srcdoc",
      "data:text/html,x",
    ]) {
      expect(isAppRendererUrl(url, DEV_ENTRY), url).toBe(false);
    }
  });

  it("matches nothing when the dev server URL is malformed or opaque", () => {
    expect(isAppRendererUrl("http://localhost:5173/", { kind: "url", value: "not a url" })).toBe(false);
    expect(isAppRendererUrl("data:text/html,x", { kind: "url", value: "data:text/html,x" })).toBe(false);
  });
});
