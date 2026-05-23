import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_RENDERED_LOG_ENTRIES,
  LogsWindow,
  appendRenderedLogEntry,
  buildRenderedLogLines,
  createRenderedLogEntryBuffer,
  orderedRenderedLogEntries,
  tokenizeLogLine,
} from "../LogsWindow";
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

describe("rendered log entry buffer", () => {
  it("keeps the newest ordered tail without shifting entries on append", () => {
    const buffer = createRenderedLogEntryBuffer();
    let droppedEntry = false;

    for (let index = 1; index <= MAX_RENDERED_LOG_ENTRIES + 2; index += 1) {
      droppedEntry =
        appendRenderedLogEntry(buffer, {
          sequence: index,
          timestamp: Date.now(),
          level: "info",
          line: `line ${index}`,
        }) || droppedEntry;
    }

    const entries = orderedRenderedLogEntries(buffer);

    expect(droppedEntry).toBe(true);
    expect(entries).toHaveLength(MAX_RENDERED_LOG_ENTRIES);
    expect(entries[0]?.sequence).toBe(3);
    expect(entries.at(-1)?.sequence).toBe(MAX_RENDERED_LOG_ENTRIES + 2);
  });

  it("reports when a live append overwrites an old slot", () => {
    const buffer = createRenderedLogEntryBuffer(
      Array.from({ length: MAX_RENDERED_LOG_ENTRIES }, (_, index) => ({
        sequence: index,
        timestamp: Date.now(),
        level: "info",
        line: `line ${index}`,
      })),
    );

    expect(
      appendRenderedLogEntry(buffer, {
        sequence: MAX_RENDERED_LOG_ENTRIES + 1,
        timestamp: Date.now(),
        level: "info",
        line: "wrapped line",
      }),
    ).toBe(true);
  });

  it("trims oversized snapshots to the newest ordered tail", () => {
    const buffer = createRenderedLogEntryBuffer(
      Array.from({ length: MAX_RENDERED_LOG_ENTRIES + 2 }, (_, index) => ({
        sequence: index + 1,
        timestamp: Date.now(),
        level: "info",
        line: `line ${index + 1}`,
      })),
    );

    const entries = orderedRenderedLogEntries(buffer);

    expect(entries).toHaveLength(MAX_RENDERED_LOG_ENTRIES);
    expect(entries[0]?.sequence).toBe(3);
    expect(entries.at(-1)?.sequence).toBe(MAX_RENDERED_LOG_ENTRIES + 2);
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

  it("does not trim visible paused output while newer stream entries arrive", async () => {
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
            line: "[2026-05-12 20:06:28.722] [info] (pwragent:main) selected line",
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

    await screen.findByText(/selected line/);
    fireEvent.pointerDown(screen.getByLabelText("Log viewport"));
    act(() => {
      for (let index = 2; index <= MAX_RENDERED_LOG_ENTRIES + 2; index += 1) {
        listener?.({
          sequence: index,
          timestamp: Date.now(),
          level: "info",
          line: `[2026-05-12 20:06:29.000] [info] (pwragent:main) hidden line ${index}`,
        });
      }
    });

    expect(screen.getByText(/selected line/)).toBeInTheDocument();
    expect(screen.queryByText(/hidden line/)).not.toBeInTheDocument();
    expect(screen.getByText("Paused app log stream")).toBeInTheDocument();
  });

  it("reloads the current tail before following again when scrolled back to bottom", async () => {
    let listener: Parameters<NonNullable<DesktopApi["onAppLogEntry"]>>[0] | undefined;
    const desktopApi = {
      readAppLogSnapshot: vi
        .fn()
        .mockResolvedValueOnce({
          kind: "log-snapshot",
          title: "Logs",
          entries: [
            {
              sequence: 1,
              timestamp: Date.now(),
              level: "info",
              line: "[2026-05-12 20:05:00.000] [info] (pwragent:main) old visible line",
            },
          ],
          readAt: Date.now(),
          truncated: false,
        })
        .mockResolvedValueOnce({
          kind: "log-snapshot",
          title: "Logs",
          entries: [
            {
              sequence: 7,
              timestamp: Date.now(),
              level: "info",
              line: "[2026-05-12 20:08:00.000] [info] (pwragent:main) current tail line",
            },
          ],
          readAt: Date.now(),
          truncated: true,
        }),
      onAppLogEntry: vi.fn((callback) => {
        listener = callback;
        return () => undefined;
      }),
    } as unknown as DesktopApi;
    (window as Window & { pwragent?: DesktopApi }).pwragent = desktopApi;

    render(<LogsWindow />);

    const viewport = await screen.findByLabelText("Log viewport");
    await screen.findByText(/old visible line/);
    fireEvent.pointerDown(viewport);
    act(() => {
      listener?.({
        sequence: 2,
        timestamp: Date.now(),
        level: "info",
        line: "[2026-05-12 20:06:00.000] [info] (pwragent:main) skipped while paused",
      });
    });

    Object.defineProperty(viewport, "scrollHeight", {
      configurable: true,
      value: 100,
    });
    Object.defineProperty(viewport, "clientHeight", {
      configurable: true,
      value: 100,
    });
    Object.defineProperty(viewport, "scrollTop", {
      configurable: true,
      value: 0,
      writable: true,
    });
    fireEvent.scroll(viewport);

    expect(await screen.findByText(/current tail line/)).toBeInTheDocument();
    expect(screen.queryByText(/old visible line/)).not.toBeInTheDocument();
    expect(screen.getByText("Showing tail")).toBeInTheDocument();
    expect(desktopApi.readAppLogSnapshot).toHaveBeenCalledTimes(2);
  });

  it(
    "marks the view as tail-only when the live renderer buffer wraps",
    async () => {
      let listener:
        | Parameters<NonNullable<DesktopApi["onAppLogEntry"]>>[0]
        | undefined;
      const desktopApi = {
        readAppLogSnapshot: vi.fn(async () => ({
          kind: "log-snapshot",
          title: "Logs",
          entries: Array.from(
            { length: MAX_RENDERED_LOG_ENTRIES },
            (_, index) => ({
              sequence: index + 1,
              timestamp: Date.now(),
              level: "info",
              line:
                index === 0
                  ? "[2026-05-12 20:06:28.722] [info] (pwragent:main) oldest visible marker"
                  : `[2026-05-12 20:06:28.722] [info] (pwragent:main) line ${index + 1}`,
            }),
          ),
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

      await screen.findByText(/oldest visible marker/);
      expect(screen.queryByText("Showing tail")).not.toBeInTheDocument();

      act(() => {
        listener?.({
          sequence: MAX_RENDERED_LOG_ENTRIES + 1,
          timestamp: Date.now(),
          level: "info",
          line: "[2026-05-12 20:06:29.000] [info] (pwragent:main) wrapped line",
        });
      });

      expect(screen.getByText("Showing tail")).toBeInTheDocument();
      expect(screen.queryByText(/oldest visible marker/)).not.toBeInTheDocument();
      expect(screen.getByText(/wrapped line/)).toBeInTheDocument();
    },
    30_000,
  );
});
