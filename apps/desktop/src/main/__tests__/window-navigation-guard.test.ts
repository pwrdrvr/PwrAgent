// Drives the real `will-navigate` listener that `applyWindowSecurityHardening`
// installs on every window. A main frame that reaches any document other than
// the renderer entry would run with the PwrAgent preload API exposed.
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getAppPath: () => "/app",
    getVersion: () => "1.0.6",
    getPath: () => "/tmp",
  },
  BrowserWindow: class {},
  Menu: { buildFromTemplate: vi.fn() },
  clipboard: { writeText: vi.fn() },
  shell: { openExternal: vi.fn() },
}));

const { applyWindowSecurityHardening, getRendererEntry } = await import("../window");

type NavigateListener = (event: { preventDefault: () => void }, targetUrl: string) => void;

function navigate(url: string): { blocked: boolean } {
  let listener: NavigateListener | undefined;
  applyWindowSecurityHardening({
    webContents: {
      setWindowOpenHandler: () => undefined,
      on: (event: string, handler: NavigateListener) => {
        if (event === "will-navigate") listener = handler;
      },
    },
  } as unknown as Parameters<typeof applyWindowSecurityHardening>[0]);
  let blocked = false;
  listener?.({ preventDefault: () => (blocked = true) }, url);
  return { blocked };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("renderer will-navigate guard, bundled renderer", () => {
  function entryUrl(): string {
    vi.stubEnv("ELECTRON_RENDERER_URL", "");
    const entry = getRendererEntry();
    expect(entry.kind).toBe("file");
    return pathToFileURL(entry.value).href;
  }

  it("allows the renderer entry with a hash or query", () => {
    const url = entryUrl();
    expect(navigate(url).blocked).toBe(false);
    expect(navigate(`${url}#messaging-activity`).blocked).toBe(false);
    expect(navigate(`${url}?reload=1#star-map`).blocked).toBe(false);
  });

  it("blocks any other local document", () => {
    const url = entryUrl();
    for (const target of [
      "file:///tmp/x.html",
      "file:///Users/sample/Downloads/preview.html",
      url.replace("index.html", "preview.html"),
      url.replace("/renderer/index.html", "/main/index.js"),
    ]) {
      expect(navigate(target).blocked, target).toBe(true);
    }
  });

  it("blocks web and opaque URLs", () => {
    entryUrl();
    for (const target of ["https://example.com/", "http://localhost:5173/", "data:text/html,x", "about:blank"]) {
      expect(navigate(target).blocked, target).toBe(true);
    }
  });
});

describe("renderer will-navigate guard, dev server", () => {
  it("allows only the dev server origin", () => {
    vi.stubEnv("ELECTRON_RENDERER_URL", "http://localhost:5173");
    expect(navigate("http://localhost:5173/").blocked).toBe(false);
    expect(navigate("http://localhost:5173/#settings").blocked).toBe(false);
    expect(navigate("http://localhost:5174/").blocked).toBe(true);
    expect(navigate("https://example.com/").blocked).toBe(true);
  });

  it("blocks file documents, which the dev window never loads", () => {
    vi.stubEnv("ELECTRON_RENDERER_URL", "http://localhost:5173");
    expect(navigate("file:///tmp/x.html").blocked).toBe(true);
    vi.stubEnv("ELECTRON_RENDERER_URL", "");
    const bundled = pathToFileURL(getRendererEntry().value).href;
    vi.stubEnv("ELECTRON_RENDERER_URL", "http://localhost:5173");
    expect(navigate(bundled).blocked).toBe(true);
  });
});
