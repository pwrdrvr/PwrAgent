import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText, copyTextWithHtml, formatCopyTooltip } from "../copy-text";

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
      formatCopyTooltip("/Users/huntharo/.codex/worktrees/0f38/PwrAgent", 24)
    ).toContain("Click to copy to clipboard");
    expect(
      formatCopyTooltip("/Users/huntharo/.codex/worktrees/0f38/PwrAgent", 24)
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
});
