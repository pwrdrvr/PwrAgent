import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LogsWindow, buildRenderedLogLines, tokenizeLogLine } from "../LogsWindow";
import type { DesktopApi } from "../../../lib/desktop-api";

afterEach(() => {
  cleanup();
  delete (window as Window & { pwragent?: unknown }).pwragent;
});

describe("buildRenderedLogLines", () => {
  it("counts case-insensitive matches across log lines", () => {
    const result = buildRenderedLogLines(
      "INFO booted\nwarn retry\nINFO ready",
      "info",
    );

    expect(result.matchCount).toBe(2);
    expect(result.lines[0].parts).toEqual([
      { text: "INFO", matchIndex: 0 },
      { text: " booted" },
    ]);
    expect(result.lines[2].parts).toEqual([
      { text: "INFO", matchIndex: 1 },
      { text: " ready" },
    ]);
  });

  it("preserves log prefix tones while applying search matches", () => {
    const result = buildRenderedLogLines(
      "[2026-05-12 20:06:28.644] [warn] (pwragent:settings) obsolete setting",
      "pwragent",
    );

    expect(result.matchCount).toBe(1);
    expect(result.lines[0].level).toBe("warn");
    expect(result.lines[0].parts).toContainEqual({
      text: "[2026-05-12 20:06:28.644]",
      tone: "timestamp",
    });
    expect(result.lines[0].parts).toContainEqual({
      text: "[warn]",
      tone: "level-warn",
    });
    expect(result.lines[0].parts).toContainEqual({
      text: "pwragent",
      tone: "scope",
      matchIndex: 0,
    });
  });
});

describe("tokenizeLogLine", () => {
  it("classifies Electron log timestamps, levels, and scopes", () => {
    expect(
      tokenizeLogLine(
        "[2026-05-12 20:06:28.722] [error] (pwragent:codex-client) failed",
      ),
    ).toEqual({
      level: "error",
      parts: [
        { text: "[2026-05-12 20:06:28.722]", tone: "timestamp" },
        { text: " " },
        { text: "[error]", tone: "level-error" },
        { text: " " },
        { text: "(pwragent:codex-client)", tone: "scope" },
        { text: " " },
        { text: "failed" },
      ],
    });
  });
});

describe("LogsWindow", () => {
  it("loads a log snapshot and renders search controls", async () => {
    const desktopApi = {
      readAppLogSnapshot: vi.fn(async () => ({
        kind: "log-snapshot",
        title: "Logs",
        path: "/Users/huntharo/Library/Logs/PwrAgent/main.log",
        content: "INFO booted\nWARN retry\n",
        sizeBytes: 24,
        readAt: Date.now(),
        truncated: false,
      })),
      copyText: vi.fn(async () => undefined),
    } as unknown as DesktopApi;
    (window as Window & { pwragent?: DesktopApi }).pwragent = desktopApi;

    render(<LogsWindow />);

    expect(await screen.findByLabelText("Search logs")).toBeInTheDocument();
    expect(await screen.findByText("INFO booted")).toBeInTheDocument();
    expect(screen.getByText("/Users/huntharo/Library/Logs/PwrAgent/main.log"))
      .toBeInTheDocument();
    await waitFor(() => {
      expect(desktopApi.readAppLogSnapshot).toHaveBeenCalled();
    });
  });
});
