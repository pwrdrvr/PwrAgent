import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  browserUseSurfaceKey,
  extractCodexBrowserUseDetail,
  formatBrowserHandoffLabel,
  formatBrowserSurfaceLabel,
  formatBrowserUrlDisplay,
  formatCodexBrowserUseDetailLabel,
  summarizeCodexBrowserUseDetails,
} from "../codex-browser-use";

const SAMPLE_JPEG_DATA_URL = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==";

describe("extractCodexBrowserUseDetail", () => {
  it("extracts full codex/toolSurface browserUse metadata and browser_use url", () => {
    const detail = extractCodexBrowserUseDetail({
      type: "mcpToolCall",
      id: "call-browser-1",
      server: "node_repl",
      tool: "js",
      status: "completed",
      result: {
        content: [{ type: "text", text: "ok" }],
        _meta: {
          "codex/browserUse": true,
          "codex/toolSurface": {
            kind: "browserUse",
            backend: "iab",
            browserId: "iab",
            screenshot: {
              url: SAMPLE_JPEG_DATA_URL,
              tabId: "1",
              pageUrl: "http://localhost:3000/fallback",
              canPersist: true,
            },
            history: {
              provider: "iab",
              browser_id: "iab",
              screenshot: true,
              handoff: {
                tabId: "1",
                providerTabId: "tab-1",
                reason: "authentication",
              },
            },
            webMcpCalls: [
              { kind: "invokeTool", name: "checkout_submit", title: "Submit checkout", sourceHostname: "localhost" },
              { kind: "invokeTool", name: "checkout_submit", title: "Submit checkout", sourceHostname: "localhost" },
            ],
          },
          browser_use: {
            url: "http://localhost:3000/checkout",
          },
        },
      },
    });

    expect(detail).toEqual({
      backend: "iab",
      browserId: "iab",
      url: "http://localhost:3000/checkout",
      tabId: "1",
      handoffReason: "authentication",
      screenshotUrl: SAMPLE_JPEG_DATA_URL,
      webMcpTools: [
        { name: "checkout_submit", title: "Submit checkout", sourceHostname: "localhost" },
      ],
    });
    expect(formatBrowserSurfaceLabel(detail!)).toBe("In-app browser");
    expect(formatBrowserHandoffLabel(detail!.handoffReason!)).toBe("Sign-in required");
  });

  it("extracts Chrome/Edge extension metadata and falls back to screenshot.pageUrl", () => {
    const detail = extractCodexBrowserUseDetail({
      type: "mcpToolCall",
      server: "node_repl",
      tool: "js",
      result: {
        _meta: {
          "codex/toolSurface": {
            kind: "browserUse",
            backend: "chrome",
            browserId: "chrome-ext-1",
            browserFamily: "edge",
            screenshot: {
              pageUrl: "https://docs.example.com/pricing/",
              tabId: "42",
            },
            history: {
              provider: "edge",
              browser_id: "chrome-ext-1",
            },
            sessionEnded: true,
          },
        },
      },
    });

    expect(detail).toEqual({
      backend: "chrome",
      browserFamily: "edge",
      browserId: "chrome-ext-1",
      url: "https://docs.example.com/pricing/",
      tabId: "42",
      sessionEnded: true,
    });
    expect(formatBrowserSurfaceLabel(detail!)).toBe("Edge");
    expect(formatBrowserUrlDisplay(detail!.url!)).toBe("docs.example.com/pricing");
  });

  it("extracts CDP manual handoff and cloud browser handoff metadata", () => {
    const detail = extractCodexBrowserUseDetail({
      type: "mcpToolCall",
      server: "cua_repl",
      tool: "js",
      result: {
        _meta: {
          "codex/toolSurface": {
            kind: "browserUse",
            backend: "cdp",
            browserId: "cdp-1",
            manualHandoffReason: "captcha",
            manualHandoffTabId: "7",
          },
          cloud_browser_handoff: {
            browser_conversation_id: "conv-1",
            tab_id: "7",
          },
        },
      },
    });

    expect(detail).toMatchObject({
      backend: "cdp",
      browserId: "cdp-1",
      tabId: "7",
      handoffReason: "captcha",
      cloudHandoff: true,
    });
    expect(formatBrowserSurfaceLabel(detail!)).toBe("Cloud browser");
  });

  it.each([
    {
      name: "missing _meta",
      item: { type: "mcpToolCall", result: { content: [] } },
    },
    {
      name: "non-browserUse toolSurface kind (computerUse)",
      item: {
        type: "mcpToolCall",
        result: {
          _meta: {
            "codex/browserUse": true,
            "codex/toolSurface": { kind: "computerUse", backend: "macos" },
          },
        },
      },
    },
    {
      name: "contradictory browserId vs history.browser_id",
      item: {
        type: "mcpToolCall",
        result: {
          _meta: {
            "codex/toolSurface": {
              kind: "browserUse",
              backend: "iab",
              browserId: "iab",
              history: { provider: "iab", browser_id: "chrome-1" },
            },
          },
        },
      },
    },
    {
      name: "contradictory backend vs history.provider",
      item: {
        type: "mcpToolCall",
        result: {
          _meta: {
            "codex/toolSurface": {
              kind: "browserUse",
              backend: "iab",
              browserId: "iab",
              history: { provider: "chrome", browser_id: "iab" },
            },
          },
        },
      },
    },
    {
      name: "only unrelated browser_use key without codex/toolSurface or codex/browserUse",
      item: {
        type: "mcpToolCall",
        result: {
          _meta: {
            browser_use: { url: "https://example.com" },
          },
        },
      },
    },
  ])("rejects $name", ({ item }) => {
    expect(extractCodexBrowserUseDetail(item)).toBeUndefined();
  });

  it("drops unsafe URLs and invalid or SVG screenshot data URLs while keeping valid surface identity", () => {
    const detail = extractCodexBrowserUseDetail({
      type: "mcpToolCall",
      result: {
        _meta: {
          "codex/toolSurface": {
            kind: "browserUse",
            backend: "iab",
            browserId: "iab",
            screenshot: {
              url: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
              pageUrl: "file:///etc/passwd",
            },
          },
          browser_use: {
            url: "javascript:alert(1)",
          },
        },
      },
    });

    expect(detail).toEqual({
      backend: "iab",
      browserId: "iab",
    });
  });

  it("omits screenshotUrl when history.screenshot is explicitly false", () => {
    const detail = extractCodexBrowserUseDetail({
      type: "mcpToolCall",
      result: {
        _meta: {
          "codex/toolSurface": {
            kind: "browserUse",
            backend: "iab",
            browserId: "iab",
            screenshot: { url: SAMPLE_JPEG_DATA_URL },
            history: { provider: "iab", browser_id: "iab", screenshot: false },
          },
        },
      },
    });
    expect(detail?.screenshotUrl).toBeUndefined();
  });

  it("never accepts non-http(s) URLs or embedded credentials across generated inputs", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("javascript:", "data:", "file:", "ftp:", "chrome:", "http://user:pass@"),
        fc.string({ maxLength: 32 }),
        (prefix, rest) => {
          const detail = extractCodexBrowserUseDetail({
            type: "mcpToolCall",
            result: {
              _meta: {
                "codex/toolSurface": {
                  kind: "browserUse",
                  backend: "iab",
                  browserId: "iab",
                },
                browser_use: { url: `${prefix}${rest}` },
              },
            },
          });
          expect(detail?.url).toBeUndefined();
        },
      ),
    );
  });

  it("produces consistent detail labels and summaries", () => {
    const meta = { backend: "iab", browserId: "iab", url: "http://localhost:3000/checkout" };
    expect(formatCodexBrowserUseDetailLabel(meta)).toBe("In-app browser · localhost:3000/checkout");
    expect(formatCodexBrowserUseDetailLabel(meta, "Verify checkout button")).toBe(
      "Verify checkout button",
    );
    expect(
      summarizeCodexBrowserUseDetails([
        { id: "c1", kind: "command", label: "In-app browser · localhost:3000/checkout", browserUse: meta },
        { id: "c2", kind: "command", label: "In-app browser · localhost:3000/checkout", browserUse: meta },
      ]),
    ).toBe("Browsed localhost:3000");
    expect(browserUseSurfaceKey(meta)).toBe(browserUseSurfaceKey({ backend: "IAB", browserId: "iab" }));
  });
});
