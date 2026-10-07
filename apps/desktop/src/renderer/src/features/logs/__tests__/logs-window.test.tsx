import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_RENDERED_LOG_ENTRIES, LogsWindow } from "../LogsWindow";
import type { DesktopApi } from "../../../lib/desktop-api";
import type { AppLogEntry, AppLogSnapshot } from "../../../../../shared/app-metadata";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete (window as Window & { pwragent?: unknown }).pwragent;
});

type EntryListener = Parameters<NonNullable<DesktopApi["onAppLogEntry"]>>[0];

function logLine(sequence: number, level: string, scope: string, message: string): AppLogEntry {
  return {
    sequence,
    timestamp: Date.UTC(2026, 9, 7, 16, 40, sequence % 60),
    level,
    line: `[2026-10-07 12:40:${String(sequence % 60).padStart(2, "0")}.000] [${level}] (pwragent:${scope}) ${message}`,
  };
}

function snapshot(entries: AppLogEntry[], extra: Partial<AppLogSnapshot> = {}): AppLogSnapshot {
  return {
    kind: "log-snapshot",
    title: "Logs",
    debugCollectionEnabled: false,
    entries,
    readAt: Date.now(),
    truncated: false,
    ...extra,
  };
}

function installApi(
  overrides: Partial<Record<keyof DesktopApi, unknown>> & { entries?: AppLogEntry[] } = {},
): { api: DesktopApi; emit: (entry: AppLogEntry) => void } {
  let listener: EntryListener | undefined;
  const { entries = [], ...rest } = overrides;
  const api = {
    readAppLogSnapshot: vi.fn(async () => snapshot(entries)),
    onAppLogEntry: vi.fn((callback: EntryListener) => {
      listener = callback;
      return () => undefined;
    }),
    writeSettingsConfig: vi.fn(async () => ({})),
    ...rest,
  } as unknown as DesktopApi;
  (window as Window & { pwragent?: DesktopApi }).pwragent = api;
  return {
    api,
    emit: (entry) => {
      act(() => {
        listener?.(entry);
      });
    },
  };
}

function lineNumber(sequence: number): HTMLElement {
  const row = document.querySelector<HTMLElement>(`[data-log-sequence="${sequence}"]`);
  if (!row) throw new Error(`no row ${sequence}`);
  return within(row).getByText(String(sequence));
}

function scrollViewportAwayFromBottom(viewport: HTMLElement): void {
  Object.defineProperty(viewport, "scrollHeight", { configurable: true, value: 1000 });
  Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 100 });
  Object.defineProperty(viewport, "scrollTop", { configurable: true, value: 0, writable: true });
  fireEvent.scroll(viewport);
}

const MCP_ENTRIES = [
  logLine(1, "info", "backend-registry", "startThread backend=codex"),
  logLine(2, "error", "codex-client", "MCP server startup failed serverName=computer-use"),
  logLine(3, "error", "codex-transport", "app-server stderr child exited"),
  logLine(4, "error", "codex-client", "MCP server startup failed serverName=diskhound"),
  logLine(5, "info", "backend-registry", "thread settings observed"),
];

describe("LogsWindow", () => {
  it("loads a snapshot and keeps the file path actions in the status bar", async () => {
    const copyText = vi.fn(async () => undefined);
    const { api } = installApi({
      copyText,
      readAppLogSnapshot: vi.fn(async () =>
        snapshot(MCP_ENTRIES, {
          logFilePath: "/Users/example/Library/Logs/PwrAgent/main.log",
        }),
      ),
    });

    render(<LogsWindow />);

    expect(await screen.findByLabelText("Search logs")).toBeInTheDocument();
    expect(await screen.findByText(/startThread backend=codex/)).toBeInTheDocument();
    expect(screen.getByText("5 lines")).toBeInTheDocument();
    expect(screen.getByText("main.log")).toHaveAttribute(
      "title",
      "/Users/example/Library/Logs/PwrAgent/main.log",
    );
    expect(screen.getByRole("button", { name: /^Error/ })).toHaveTextContent("Error3");
    fireEvent.click(screen.getByRole("button", { name: "Copy log file path" }));
    await waitFor(() => {
      expect(copyText).toHaveBeenCalledWith("/Users/example/Library/Logs/PwrAgent/main.log");
    });
    expect(screen.getByRole("button", { name: "Copied log file path" })).toBeInTheDocument();
    expect(api.readAppLogSnapshot).toHaveBeenCalledTimes(1);
  });

  it("filters to matching lines with gaps, and highlights in place in Highlight mode", async () => {
    const { api } = installApi({ entries: MCP_ENTRIES });

    render(<LogsWindow />);
    await screen.findByText(/startThread/);

    fireEvent.change(screen.getByLabelText("Search logs"), {
      target: { value: "startup failed" },
    });

    expect(screen.queryByText(/startThread/)).not.toBeInTheDocument();
    expect(screen.getByText("1 of 2 lines")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /line hidden/ })).toHaveLength(3);

    fireEvent.click(screen.getByRole("button", { name: "Highlight" }));

    expect(screen.getByText(/startThread/)).toBeInTheDocument();
    expect(screen.queryAllByRole("button", { name: /line hidden/ })).toHaveLength(0);
    expect(api.writeSettingsConfig).toHaveBeenCalledWith({
      patch: { ui: { logs: { searchMode: "highlight" } } },
    });
  });

  it("expands a gap row to show the lines it hid", async () => {
    installApi({ entries: MCP_ENTRIES });

    render(<LogsWindow />);
    await screen.findByText(/startThread/);
    fireEvent.change(screen.getByLabelText("Search logs"), {
      target: { value: "diskhound" },
    });
    expect(screen.queryByText(/startThread/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "3 lines hidden" }));

    expect(screen.getByText(/startThread/)).toBeInTheDocument();
  });

  it("selects lines from the line numbers and copies them with diagnostics", async () => {
    const copyRichText = vi.fn(async () => undefined);
    installApi({
      entries: MCP_ENTRIES,
      copyRichText,
      readAppMetadata: vi.fn(async () => ({
        applicationVersion: "1.14.2",
        activeProfileName: "default",
        mainProcessId: 41872,
        logFilePath: "/Users/example/main.log",
      })),
      readFederationHealth: vi.fn(async () => ({
        health: {
          enabled: true,
          role: "server",
          status: "online",
          instanceId: "inst-1",
          localLabel: "studio-mac",
          peers: [],
        },
      })),
    });

    render(<LogsWindow />);
    await screen.findByText(/startThread/);

    fireEvent.pointerDown(lineNumber(2), { button: 0 });
    expect(screen.getByRole("toolbar", { name: "Selected lines" })).toHaveTextContent("Line 2");
    fireEvent.pointerDown(lineNumber(4), { button: 0, shiftKey: true });
    expect(screen.getByText("3 lines selected")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Include diagnostics" })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    await waitFor(() => {
      expect(copyRichText).toHaveBeenCalledTimes(1);
    });
    const copied = (copyRichText.mock.calls[0] as unknown as [{ text: string }])[0].text;
    expect(copied).toContain("PwrAgent version: 1.14.2");
    expect(copied).toContain("PwrAgent instance: [@studio-mac](pwragent://instance/inst-1)");
    expect(copied).toContain("Log lines: 2–4 (3 of 5 loaded; levels: Error, Warning, Info)");
    expect(copied.endsWith(
      MCP_ENTRIES.slice(1, 4).map((item) => item.line).join("\n"),
    )).toBe(true);
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Copied 3 lines with diagnostics");
    expect(document.querySelector('[data-log-sequence="3"]')).toHaveClass(
      "log-window__line--copied",
    );
  });

  it("copies only the lines when Include diagnostics is off, and remembers the choice", async () => {
    const copyRichText = vi.fn(async () => undefined);
    const readAppMetadata = vi.fn(async () => ({}));
    const { api } = installApi({ entries: MCP_ENTRIES, copyRichText, readAppMetadata });

    render(<LogsWindow />);
    await screen.findByText(/startThread/);
    fireEvent.pointerDown(lineNumber(5), { button: 0 });
    fireEvent.click(screen.getByRole("checkbox", { name: "Include diagnostics" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    await waitFor(() => {
      expect(copyRichText).toHaveBeenCalledWith({
        text: MCP_ENTRIES[4].line,
        html: expect.stringContaining("thread settings observed"),
      });
    });
    expect(readAppMetadata).not.toHaveBeenCalled();
    expect(api.writeSettingsConfig).toHaveBeenCalledWith({
      patch: { ui: { logs: { includeDiagnostics: false } } },
    });
    expect(await screen.findByRole("status")).toHaveTextContent("Copied 1 line");
  });

  it("selects every shown line with ⌘A and copies with ⌘C; Esc clears", async () => {
    const copyRichText = vi.fn(async () => undefined);
    installApi({ entries: MCP_ENTRIES, copyRichText });

    render(<LogsWindow />);
    await screen.findByText(/startThread/);
    fireEvent.change(screen.getByLabelText("Search logs"), {
      target: { value: "codex-client" },
    });
    fireEvent.keyDown(document.body, { key: "a", metaKey: true });
    expect(screen.getByText("2 lines selected")).toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: "c", metaKey: true });
    await waitFor(() => {
      expect(copyRichText).toHaveBeenCalledTimes(1);
    });

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("toolbar", { name: "Selected lines" })).not.toBeInTheDocument();
  });

  it("adds a scope token when a scope in a line is clicked", async () => {
    installApi({ entries: MCP_ENTRIES });

    render(<LogsWindow />);
    await screen.findByText(/startThread/);
    const row = document.querySelector<HTMLElement>('[data-log-sequence="3"]');
    fireEvent.click(within(row as HTMLElement).getByText("(pwragent:codex-transport)"));

    expect(screen.getByRole("button", { name: "Remove scope filter codex-transport" }))
      .toBeInTheDocument();
    expect(screen.queryByText(/startThread/)).not.toBeInTheDocument();
    expect(screen.getByText(/app-server stderr child exited/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remove scope filter codex-transport" }));
    expect(screen.getByText(/startThread/)).toBeInTheDocument();
  });

  it("drops a mark and selects every line after it, including new ones", async () => {
    const { emit } = installApi({ entries: MCP_ENTRIES.slice(0, 2) });

    render(<LogsWindow />);
    await screen.findByText(/startThread/);
    fireEvent.click(screen.getByRole("button", { name: "Mark" }));
    expect(screen.getByRole("button", { name: "Select since mark" })).toBeDisabled();

    emit(MCP_ENTRIES[2]);
    emit(MCP_ENTRIES[3]);
    fireEvent.click(screen.getByRole("button", { name: "Select since mark" }));
    expect(screen.getByText("2 lines since mark")).toBeInTheDocument();

    emit(MCP_ENTRIES[4]);
    expect(screen.getByText("3 lines since mark")).toBeInTheDocument();
  });

  it("remembers Wrap and starts from the stored preferences", async () => {
    const { api } = installApi({
      entries: MCP_ENTRIES,
      readConfigBootstrap: vi.fn(async () => ({
        snapshot: {
          logs: {
            wrap: false,
            searchMode: "filter",
            contextLines: 0,
            includeDiagnostics: true,
            levels: ["error", "warn"],
          },
        },
      })),
    });

    render(<LogsWindow />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Wrap" })).toHaveAttribute("aria-pressed", "false");
    });
    expect(screen.queryByText(/startThread/)).not.toBeInTheDocument();
    expect(screen.getByRole("log", { name: "Log output" })).not.toHaveClass(
      "log-window__lines--wrap",
    );

    fireEvent.click(screen.getByRole("button", { name: "Wrap" }));

    expect(screen.getByRole("log", { name: "Log output" })).toHaveClass(
      "log-window__lines--wrap",
    );
    expect(api.writeSettingsConfig).toHaveBeenCalledWith({
      patch: { ui: { logs: { wrap: true } } },
    });
  });

  it("defaults to Error, Warning, and Info toggles with Debug off", async () => {
    const entries = [
      logLine(1, "error", "main", "visible error line"),
      logLine(2, "warn", "main", "visible warn line"),
      logLine(3, "info", "main", "visible info line"),
      logLine(4, "debug", "main", "hidden debug line"),
    ];
    const { api } = installApi({
      entries,
      setAppLogDebugCollectionEnabled: vi.fn(async (enabled: boolean) =>
        snapshot(entries, { debugCollectionEnabled: enabled }),
      ),
    });

    render(<LogsWindow />);

    expect(await screen.findByText(/visible error line/)).toBeInTheDocument();
    expect(screen.getByText(/visible warn line/)).toBeInTheDocument();
    expect(screen.getByText(/visible info line/)).toBeInTheDocument();
    expect(screen.queryByText(/hidden debug line/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Info" }));

    expect(screen.queryByText(/visible info line/)).not.toBeInTheDocument();
    expect(api.writeSettingsConfig).toHaveBeenCalledWith({
      patch: { ui: { logs: { levels: ["error", "warn"] } } },
    });

    fireEvent.click(screen.getByRole("button", { name: /^Error/ }));

    expect(screen.queryByText(/visible error line/)).not.toBeInTheDocument();
    expect(screen.getByText(/visible warn line/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Debug" }));

    await waitFor(() => {
      expect(api.setAppLogDebugCollectionEnabled).toHaveBeenCalledWith(true);
    });
    expect(await screen.findByText(/hidden debug line/)).toBeInTheDocument();
    expect(screen.getByText("Debug collection on")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Debug" }));

    await waitFor(() => {
      expect(api.setAppLogDebugCollectionEnabled).toHaveBeenCalledWith(false);
    });
    expect(screen.queryByText(/hidden debug line/)).not.toBeInTheDocument();
  });

  it("disables debug collection after a rapid Debug toggle off", async () => {
    const entries = [
      logLine(1, "info", "main", "visible info line"),
      logLine(2, "debug", "main", "hidden debug line"),
    ];
    let resolveEnable: ((value: AppLogSnapshot) => void) | undefined;
    let resolveDisable: ((value: AppLogSnapshot) => void) | undefined;
    const { api } = installApi({
      entries,
      setAppLogDebugCollectionEnabled: vi.fn(
        (enabled: boolean) =>
          new Promise<AppLogSnapshot>((resolve) => {
            if (enabled) {
              resolveEnable = resolve;
            } else {
              resolveDisable = resolve;
            }
          }),
      ),
    });

    render(<LogsWindow />);

    expect(await screen.findByText(/visible info line/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Debug" }));
    await waitFor(() => {
      expect(api.setAppLogDebugCollectionEnabled).toHaveBeenCalledWith(true);
    });
    fireEvent.click(screen.getByRole("button", { name: "Debug" }));
    expect(api.setAppLogDebugCollectionEnabled).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveEnable?.(snapshot(entries, { debugCollectionEnabled: true }));
    });

    await waitFor(() => {
      expect(api.setAppLogDebugCollectionEnabled).toHaveBeenCalledWith(false);
    });

    await act(async () => {
      resolveDisable?.(snapshot(entries));
    });

    await waitFor(() => {
      expect(screen.queryByText("Debug collection on")).not.toBeInTheDocument();
    });
    expect(screen.queryByText(/hidden debug line/)).not.toBeInTheDocument();
  });

  it("appends streamed log entries while live", async () => {
    const { emit } = installApi();

    render(<LogsWindow />);

    await screen.findByLabelText("Log viewport");
    emit(logLine(1, "info", "main", "streamed line"));

    expect(await screen.findByText(/streamed line/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Live" })).toHaveAttribute("aria-pressed", "true");
  });

  it("does not pause when lines are selected from the line numbers", async () => {
    const { emit } = installApi({ entries: MCP_ENTRIES.slice(0, 1) });

    render(<LogsWindow />);
    await screen.findByText(/startThread/);
    fireEvent.pointerDown(lineNumber(1), { button: 0 });
    emit(logLine(2, "info", "main", "arrives while selected"));

    expect(screen.getByText(/arrives while selected/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Live" })).toBeInTheDocument();
  });

  it("counts new lines while paused and reloads the buffer on resume", async () => {
    const readAppLogSnapshot = vi
      .fn()
      .mockResolvedValueOnce(snapshot([logLine(1, "info", "main", "old visible line")]))
      .mockResolvedValueOnce(
        snapshot(
          [
            logLine(1, "info", "main", "old visible line"),
            logLine(2, "error", "main", "arrived while paused"),
          ],
          { truncated: true },
        ),
      );
    const { emit } = installApi({ readAppLogSnapshot });

    render(<LogsWindow />);

    const viewport = await screen.findByLabelText("Log viewport");
    await screen.findByText(/old visible line/);
    scrollViewportAwayFromBottom(viewport);
    expect(screen.getByRole("button", { name: "Paused" })).toBeInTheDocument();

    emit(logLine(2, "error", "main", "arrived while paused"));

    expect(screen.queryByText(/arrived while paused/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "1 new line · 1 error" }));

    expect(await screen.findByText(/arrived while paused/)).toBeInTheDocument();
    expect(screen.getByText("Showing tail")).toBeInTheDocument();
    expect(readAppLogSnapshot).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Live" })).toBeInTheDocument();
  });

  it("marks the view as tail-only when the live renderer buffer wraps", async () => {
    const { emit } = installApi({
      entries: Array.from({ length: MAX_RENDERED_LOG_ENTRIES }, (_, index) => ({
        sequence: index + 1,
        timestamp: Date.now(),
        // Keep the ring full without asking jsdom to materialize 5,000
        // visible log rows. Debug is filtered by default; the first entry
        // remains visible so the live overwrite is still proven through the
        // component boundary.
        level: index === 0 ? "info" : "debug",
        line:
          index === 0
            ? "[2026-05-12 20:06:28.722] [info] (pwragent:main) oldest visible marker"
            : `[2026-05-12 20:06:28.722] [debug] (pwragent:main) line ${index + 1}`,
      })),
    });

    render(<LogsWindow />);

    await screen.findByText(/oldest visible marker/);
    expect(screen.queryByText("Showing tail")).not.toBeInTheDocument();

    emit({
      sequence: MAX_RENDERED_LOG_ENTRIES + 1,
      timestamp: Date.now(),
      level: "info",
      line: "[2026-05-12 20:06:29.000] [info] (pwragent:main) wrapped line",
    });

    expect(screen.getByText("Showing tail")).toBeInTheDocument();
    expect(screen.queryByText(/oldest visible marker/)).not.toBeInTheDocument();
    expect(screen.getByText(/wrapped line/)).toBeInTheDocument();
  });
});
