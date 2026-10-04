import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText, copyTextAsCodeBlock, copyTextWithHtml, formatCopyTooltip } from "../copy-text";

describe("copyText", () => {
  afterEach(() => {
    Object.defineProperty(window, "pwragent", {
      configurable: true,
      value: undefined,
    });
    vi.restoreAllMocks();
  });

  it("uses the desktop bridge when available", async () => {
    const bridgeCopy = vi.fn(async () => undefined);
    Object.defineProperty(window, "pwragent", {
      configurable: true,
      value: {
        copyText: bridgeCopy,
      },
    });

    await copyText("/tmp/worktree");

    expect(bridgeCopy).toHaveBeenCalledWith("/tmp/worktree");
  });

  it("falls back to navigator.clipboard when the desktop bridge is missing", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText,
      },
    });

    await copyText("/tmp/project");

    expect(writeText).toHaveBeenCalledWith("/tmp/project");
  });

  it("formats tooltips with an elided path and copy hint", () => {
    expect(
      formatCopyTooltip("/Users/fixture-user/.codex/worktrees/0f38/PwrAgent", 24)
    ).toContain("Click to copy to clipboard");
    expect(
      formatCopyTooltip("/Users/fixture-user/.codex/worktrees/0f38/PwrAgent", 24)
    ).toContain("…");
  });
});

describe("copyTextWithHtml", () => {
  afterEach(() => {
    Object.defineProperty(window, "pwragent", {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("writes both flavors through the desktop bridge when available", async () => {
    const bridgeCopyRich = vi.fn(async () => undefined);
    Object.defineProperty(window, "pwragent", {
      configurable: true,
      value: {
        copyRichText: bridgeCopyRich,
      },
    });

    await copyTextWithHtml("**bold**", "<p><strong>bold</strong></p>");

    expect(bridgeCopyRich).toHaveBeenCalledWith({
      text: "**bold**",
      html: "<p><strong>bold</strong></p>",
    });
  });

  it("falls back to navigator.clipboard.write with both flavors", async () => {
    class FakeClipboardItem {
      readonly items: Record<string, Blob>;

      constructor(items: Record<string, Blob>) {
        this.items = items;
      }
    }
    vi.stubGlobal("ClipboardItem", FakeClipboardItem);
    const write = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        write,
      },
    });

    await copyTextWithHtml("**bold**", "<p><strong>bold</strong></p>");

    expect(write).toHaveBeenCalledTimes(1);
    const [items] = write.mock.calls[0] as unknown as [FakeClipboardItem[]];
    expect(items).toHaveLength(1);
    await expect(items[0].items["text/plain"].text()).resolves.toBe("**bold**");
    await expect(items[0].items["text/html"].text()).resolves.toBe(
      "<p><strong>bold</strong></p>"
    );
  });

  it("falls back to a plain-text copy when rich flavors are unavailable", async () => {
    const bridgeCopy = vi.fn(async () => undefined);
    Object.defineProperty(window, "pwragent", {
      configurable: true,
      value: {
        copyText: bridgeCopy,
      },
    });

    await copyTextWithHtml("**bold**", "<p><strong>bold</strong></p>");

    expect(bridgeCopy).toHaveBeenCalledWith("**bold**");
  });

  it("copies a literal code block alongside unchanged plain text", async () => {
    const bridgeCopyRich = vi.fn(async () => undefined);
    const text = "Thread title: <widget> & \"quotes\" `code`\n\nPath: /tmp/a&b";

    await copyTextAsCodeBlock(text, { copyRichText: bridgeCopyRich });

    expect(bridgeCopyRich).toHaveBeenCalledWith({
      text,
      html: "<pre><code>Thread title: &lt;widget&gt; &amp; \"quotes\" `code`\n\nPath: /tmp/a&amp;b</code></pre>",
    });
  });

  it("falls back to the original diagnostic text when a rich write fails", async () => {
    const bridgeCopy = vi.fn(async () => undefined);
    const text = "Thread ID: fixture-thread\nPwrAgent profile: fixture";

    await copyTextAsCodeBlock(text, {
      copyRichText: vi.fn(async () => { throw new Error("Rich clipboard unavailable"); }),
      copyText: bridgeCopy,
    });

    expect(bridgeCopy).toHaveBeenCalledWith(text);
  });
});
