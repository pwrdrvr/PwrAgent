import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LogsWindow, buildRenderedLogLines, tokenizeLogLine } from "../LogsWindow";
import type { DesktopApi } from "../../../lib/desktop-api";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
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
        entries: [
          {
            sequence: 1,
            timestamp: Date.now(),
            level: "info",
            line: "INFO booted",
          },
          {
            sequence: 2,
            timestamp: Date.now(),
            level: "warn",
            line: "WARN retry",
          },
        ],
        readAt: Date.now(),
        truncated: false,
      })),
      onAppLogEntry: vi.fn(() => () => undefined),
    } as unknown as DesktopApi;
    (window as Window & { pwragent?: DesktopApi }).pwragent = desktopApi;

    render(<LogsWindow />);

    expect(await screen.findByLabelText("Search logs")).toBeInTheDocument();
    expect(await screen.findByText("INFO booted")).toBeInTheDocument();
    expect(screen.getByText("Live app log stream")).toBeInTheDocument();
    await waitFor(() => {
      expect(desktopApi.readAppLogSnapshot).toHaveBeenCalled();
    });
  });

  it("appends streamed log entries while following", async () => {
    let listener: Parameters<NonNullable<DesktopApi["onAppLogEntry"]>>[0] | undefined;
    const desktopApi = {
      readAppLogSnapshot: vi.fn(async () => ({
        kind: "log-snapshot",
        title: "Logs",
        entries: [],
        readAt: Date.now(),
        truncated: false,
      })),
      onAppLogEntry: vi.fn((callback) => {
        listener = callback;
        return () => undefined;
      }),
    } as unknown as DesktopApi;
    (window as Window & { pwragent?: DesktopApi }).pwragent = desktopApi;

    render(<LogsWindow />);

    await screen.findByLabelText("Log viewport");
    act(() => {
      listener?.({
        sequence: 1,
        timestamp: Date.now(),
        level: "info",
        line: "[2026-05-12 20:06:28.722] [info] (pwragent:main) streamed line",
      });
    });

    expect(await screen.findByText(/streamed line/)).toBeInTheDocument();
  });

  it("ignores streamed log entries while the log output is being selected", async () => {
    let listener: Parameters<NonNullable<DesktopApi["onAppLogEntry"]>>[0] | undefined;
    const desktopApi = {
      readAppLogSnapshot: vi.fn(async () => ({
        kind: "log-snapshot",
        title: "Logs",
        entries: [
          {
            sequence: 1,
            timestamp: Date.now(),
            level: "info",
            line: "[2026-05-12 20:06:28.722] [info] (pwragent:main) stable line",
          },
        ],
        readAt: Date.now(),
        truncated: false,
      })),
      onAppLogEntry: vi.fn((callback) => {
        listener = callback;
        return () => undefined;
      }),
    } as unknown as DesktopApi;
    (window as Window & { pwragent?: DesktopApi }).pwragent = desktopApi;

    render(<LogsWindow />);

    await screen.findByText(/stable line/);
    fireEvent.pointerDown(screen.getByLabelText("Log viewport"));
    act(() => {
      listener?.({
        sequence: 2,
        timestamp: Date.now(),
        level: "info",
        line: "[2026-05-12 20:06:29.000] [info] (pwragent:main) moving line",
      });
    });

    expect(screen.queryByText(/moving line/)).not.toBeInTheDocument();
    expect(screen.getByText("Paused app log stream")).toBeInTheDocument();
  });
});
