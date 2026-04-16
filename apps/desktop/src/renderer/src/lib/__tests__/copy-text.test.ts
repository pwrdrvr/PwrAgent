import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText, formatCopyTooltip } from "../copy-text";

describe("copyText", () => {
  afterEach(() => {
    Object.defineProperty(window, "pwragnt", {
      configurable: true,
      value: undefined,
    });
    vi.restoreAllMocks();
  });

  it("uses the desktop bridge when available", async () => {
    const bridgeCopy = vi.fn(async () => undefined);
    Object.defineProperty(window, "pwragnt", {
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
      formatCopyTooltip("/Users/huntharo/.codex/worktrees/0f38/PwrAgnt", 24)
    ).toContain("Click to copy to clipboard");
    expect(
      formatCopyTooltip("/Users/huntharo/.codex/worktrees/0f38/PwrAgnt", 24)
    ).toContain("…");
  });
});
