import { describe, expect, it, vi } from "vitest";
import {
  buildHtmlPreviewDocument,
  collectHtmlPreviewRefs,
  fileUrlForPath,
  HTML_PREVIEW_LOCAL_LINK_ORIGIN,
  htmlPreviewLocalLinkPath,
  resolveHtmlPreviewResources,
  type HtmlPreviewResources,
} from "../html-preview-document";

const PNG_URL = "data:image/png;base64,iVBORw0KGgo=";
const NO_RESOURCES: HtmlPreviewResources = { assets: new Map(), stylesheets: new Map() };

function parse(srcdoc: string): Document {
  return new DOMParser().parseFromString(srcdoc, "text/html");
}

function cssDataUrl(css: string): string {
  return `data:text/css;base64,${btoa(css)}`;
}

describe("collectHtmlPreviewRefs", () => {
  it("lists every local file the page loads, and nothing it does not", () => {
    const refs = collectHtmlPreviewRefs(`<!doctype html>
      <link rel="stylesheet" href="css/site.css">
      <link rel="icon" href="favicon.ico">
      <style>.hero { background: url('img/hero.webp'); }</style>
      <img src="img/a.png" srcset="img/a@2x.png 2x, https://cdn.example.com/a.png 3x">
      <div style="background-image: url(img/tile.png)" data="not-a-url"></div>
      <svg><image href="img/chart.svg"></image><a href="other.html"><text>x</text></a></svg>
      <video poster="media/poster.jpg"><source src="media/clip.mp4"></video>
      <img src="data:image/png;base64,AA"><img src="https://example.com/b.png"><img src="#frag">
      <a href="notes.html">Notes</a>
      <script src="app.js"></script>`);

    expect(refs.sort()).toEqual([
      "app.js",
      "css/site.css",
      "img/a.png",
      "img/a@2x.png",
      "img/chart.svg",
      "img/hero.webp",
      "img/tile.png",
      "media/clip.mp4",
      "media/poster.jpg",
    ]);
  });
});

describe("buildHtmlPreviewDocument", () => {
  it("puts a no-network, no-script policy ahead of everything in the page", () => {
    const { srcdoc } = buildHtmlPreviewDocument(
      "<!doctype html><html><head><title>Brief</title><script>alert(1)</script></head><body>Hi</body></html>",
      NO_RESOURCES,
      { scripts: false },
    );

    expect(srcdoc.startsWith("<!DOCTYPE html>")).toBe(true);
    const head = parse(srcdoc).head;
    const policy = head.firstElementChild;
    expect(policy?.getAttribute("http-equiv")).toBe("Content-Security-Policy");
    const content = policy?.getAttribute("content") ?? "";
    expect(content).toContain("default-src 'none'");
    expect(content).toContain("script-src 'none'");
    expect(content).toContain("connect-src 'none'");
    expect(content).toContain("img-src data: blob:");
    expect(content).toContain("form-action 'none'");
    expect(content).toContain("base-uri 'none'");
    expect(head.querySelector('meta[name="referrer"]')?.getAttribute("content")).toBe("no-referrer");
  });

  it("lets scripts run when asked, still with no way to reach the network", () => {
    const { srcdoc } = buildHtmlPreviewDocument("<p>Hi</p>", NO_RESOURCES, { scripts: true });
    const head = parse(srcdoc).head;
    const content = head.firstElementChild?.getAttribute("content") ?? "";

    expect(content).toContain("script-src 'unsafe-inline'");
    expect(content).toContain("connect-src data: blob:");
    expect(content).not.toMatch(/https?:/);
    // The guard runs before any script of the page's own.
    const guard = head.querySelector("script");
    expect(guard?.textContent).toContain("RTCPeerConnection");
  });

  it("inlines local files, removes web loads, and counts both kinds of miss", () => {
    const resources: HtmlPreviewResources = {
      assets: new Map([["img/a.png", PNG_URL]]),
      stylesheets: new Map(),
    };
    const result = buildHtmlPreviewDocument(`
      <img id="local" src="img/a.png">
      <img id="missing" src="img/gone.png">
      <img id="web" src="https://tracker.example.com/pixel.gif?u=1">
      <img id="set" srcset="img/a.png 1x, https://cdn.example.com/a.png 2x">
      <div id="styled" style="background: url('https://cdn.example.com/bg.png')"></div>
      <a id="ping" href="https://example.com" ping="https://tracker.example.com">x</a>`,
    resources, { scripts: false });
    const doc = parse(result.srcdoc);

    expect(doc.getElementById("local")?.getAttribute("src")).toBe(PNG_URL);
    expect(doc.getElementById("missing")?.hasAttribute("src")).toBe(false);
    expect(doc.getElementById("web")?.hasAttribute("src")).toBe(false);
    expect(doc.getElementById("set")?.getAttribute("srcset")).toBe(`${PNG_URL} 1x`);
    expect(doc.getElementById("styled")?.getAttribute("style")).toBe('background: url("data:,")');
    expect(doc.getElementById("ping")?.hasAttribute("ping")).toBe(false);
    expect(result.blockedRemote).toBe(3);
    expect(result.missingLocal).toBe(1);
    expect(result.srcdoc).not.toContain("tracker.example.com");
    expect(result.srcdoc).not.toContain("cdn.example.com");
  });

  it("drops the tags that only reach out or move the page", () => {
    const { srcdoc } = buildHtmlPreviewDocument(`<head>
      <base href="https://example.com/">
      <meta http-equiv="refresh" content="0; url=https://example.com/">
      <link rel="preconnect" href="https://example.com">
      <link rel="dns-prefetch" href="https://example.com">
      <link rel="icon" href="favicon.ico">
    </head><body>Hi</body>`, NO_RESOURCES, { scripts: false });
    const doc = parse(srcdoc);

    expect(doc.querySelector("base")).toBeNull();
    expect(doc.querySelector('meta[http-equiv="refresh"]')).toBeNull();
    expect(doc.querySelectorAll("link")).toHaveLength(0);
  });

  it("points links where the viewer can catch them", () => {
    const fileUrl = fileUrlForPath("/work/brief/index.html");
    const { srcdoc } = buildHtmlPreviewDocument(`
      <a id="fragment" href="#pricing" target="_blank">Pricing</a>
      <a id="web" href="https://example.com/docs" target="_blank">Docs</a>
      <a id="relative" href="appendix.html#a1">Appendix</a>
      <a id="absolute" href="/work/other/notes.md">Notes</a>
      <a id="script" href="javascript:alert(1)">Run</a>`,
    NO_RESOURCES, { scripts: false, fileUrl });
    const doc = parse(srcdoc);

    expect(doc.getElementById("fragment")?.getAttribute("href")).toBe("about:srcdoc#pricing");
    expect(doc.getElementById("fragment")?.hasAttribute("target")).toBe(false);
    expect(doc.getElementById("web")?.getAttribute("href")).toBe("https://example.com/docs");
    expect(doc.getElementById("web")?.hasAttribute("target")).toBe(false);
    const relative = doc.getElementById("relative")?.getAttribute("href") ?? "";
    expect(relative.startsWith(HTML_PREVIEW_LOCAL_LINK_ORIGIN)).toBe(true);
    expect(htmlPreviewLocalLinkPath(relative)).toBe("/work/brief/appendix.html");
    expect(htmlPreviewLocalLinkPath(doc.getElementById("absolute")?.getAttribute("href") ?? ""))
      .toBe("/work/other/notes.md");
    expect(doc.getElementById("script")?.hasAttribute("href")).toBe(false);
  });

  it("drops relative links from a page on another machine", () => {
    const { srcdoc } = buildHtmlPreviewDocument(
      '<a id="relative" href="appendix.html">Appendix</a><a id="web" href="https://example.com">Web</a>',
      NO_RESOURCES,
      { scripts: false },
    );
    const doc = parse(srcdoc);

    expect(doc.getElementById("relative")?.hasAttribute("href")).toBe(false);
    expect(doc.getElementById("web")?.getAttribute("href")).toBe("https://example.com");
  });

  it("swaps a linked stylesheet for its text, with its own images inlined", () => {
    const resources: HtmlPreviewResources = {
      assets: new Map([["img/bg.png", PNG_URL]]),
      stylesheets: new Map([["css/site.css", 'body { background: url("img/bg.png"); }']]),
    };
    const { srcdoc } = buildHtmlPreviewDocument(
      '<head><link rel="stylesheet" media="screen" href="css/site.css"></head><body></body>',
      resources,
      { scripts: false },
    );
    const style = parse(srcdoc).querySelector("style");

    expect(style?.getAttribute("media")).toBe("screen");
    expect(style?.textContent).toBe(`body { background: url("${PNG_URL}"); }`);
  });
});

describe("resolveHtmlPreviewResources", () => {
  it("reads the page's files, then the files its stylesheets name", async () => {
    const readAssets = vi.fn(async (refs: string[]) => ({
      assets: refs.flatMap((ref) => {
        if (ref === "css/site.css") {
          return [{ ref, dataUrl: cssDataUrl(".hero { background: url(../img/hero.png); }") }];
        }
        if (ref === "img/hero.png") return [{ ref, dataUrl: PNG_URL }];
        return [];
      }),
      skipped: [],
    }));

    const resources = await resolveHtmlPreviewResources(
      '<link rel="stylesheet" href="css/site.css"><p>Hi</p>',
      readAssets,
    );

    expect(readAssets.mock.calls).toEqual([[["css/site.css"]], [["img/hero.png"]]]);
    expect(resources.stylesheets.get("css/site.css")).toBe('.hero { background: url("img/hero.png"); }');
    expect(resources.assets.get("img/hero.png")).toBe(PNG_URL);
  });

  it("says why no file was read when the page has some but cannot get them", async () => {
    await expect(resolveHtmlPreviewResources('<img src="a.png">', undefined, "Not here."))
      .resolves.toMatchObject({ unavailable: "Not here." });
    await expect(resolveHtmlPreviewResources(
      '<img src="a.png">',
      async () => ({ assets: [], skipped: [], error: "No access." }),
    )).resolves.toMatchObject({ unavailable: "No access." });
    // A page with no local files has nothing to explain.
    await expect(resolveHtmlPreviewResources("<p>Hi</p>", undefined))
      .resolves.not.toHaveProperty("unavailable");
  });
});

describe("fileUrlForPath", () => {
  it.each([
    ["/work/My Brief/index.html", "file:///work/My%20Brief/index.html"],
    ["C:\\work\\brief#1.html", "file:///C:/work/brief%231.html"],
  ])("writes %s as %s", (filePath, url) => {
    expect(fileUrlForPath(filePath)).toBe(url);
  });
});
