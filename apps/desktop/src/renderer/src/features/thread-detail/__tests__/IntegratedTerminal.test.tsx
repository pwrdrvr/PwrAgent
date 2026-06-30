import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "../../../lib/desktop-api";
import { IntegratedTerminal } from "../IntegratedTerminal";

const xtermState = vi.hoisted(() => ({
  instances: [] as Array<{
    cols: number;
    rows: number;
    options: unknown;
    focus: ReturnType<typeof vi.fn>;
    handlers: Array<(data: string) => void>;
    emitData: (data: string) => void;
    write: ReturnType<typeof vi.fn>;
  }>,
  deferWriteCallbacks: false,
  pendingWriteCallbacks: [] as Array<() => void>,
  replayDataEvents: new Map<string, string[]>(),
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    focus = vi.fn();
    handlers: Array<(data: string) => void> = [];

    constructor(public options: unknown) {
      xtermState.instances.push(this);
    }

    loadAddon = vi.fn();
    open = vi.fn();
    write = vi.fn((data: string, callback?: () => void) => {
      const responses = xtermState.replayDataEvents.get(data) ?? [];
      for (const response of responses) {
        this.emitData(response);
      }
      if (!callback) {
        return;
      }
      if (xtermState.deferWriteCallbacks) {
        xtermState.pendingWriteCallbacks.push(callback);
      } else {
        callback();
      }
    });
    dispose = vi.fn();

    onData(callback: (data: string) => void) {
      this.handlers.push(callback);
      return { dispose: vi.fn() };
    }

    emitData(data: string) {
      for (const handler of this.handlers) {
        handler(data);
      }
    }
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit = vi.fn();
    proposeDimensions = vi.fn(() => ({ cols: 100, rows: 22 }));
  },
}));

class MockResizeObserver {
  observe = vi.fn();
  disconnect = vi.fn();
}

describe("IntegratedTerminal", () => {
  beforeEach(() => {
    xtermState.instances.length = 0;
    xtermState.deferWriteCallbacks = false;
    xtermState.pendingWriteCallbacks.length = 0;
    xtermState.replayDataEvents.clear();
    Object.defineProperty(window, "ResizeObserver", {
      configurable: true,
      value: MockResizeObserver,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    document.documentElement.removeAttribute("style");
  });

  it("passes concrete terminal palette colors to xterm", async () => {
    const terminalTokens = {
      "--font-mono": "IBM Plex Mono",
      "--terminal-bg": "#ffffff",
      "--terminal-fg": "#333333",
      "--terminal-cursor": "#d96d00",
      "--terminal-cursor-accent": "#ffffff",
      "--terminal-ansi-black": "#000000",
      "--terminal-ansi-red": "#cd3131",
      "--terminal-ansi-green": "#107c10",
      "--terminal-ansi-yellow": "#949800",
      "--terminal-ansi-blue": "#0451a5",
      "--terminal-ansi-magenta": "#bc05bc",
      "--terminal-ansi-cyan": "#0598bc",
      "--terminal-ansi-white": "#555555",
      "--terminal-ansi-bright-black": "#666666",
      "--terminal-ansi-bright-red": "#cd3131",
      "--terminal-ansi-bright-green": "#14ce14",
      "--terminal-ansi-bright-yellow": "#b5ba00",
      "--terminal-ansi-bright-blue": "#0451a5",
      "--terminal-ansi-bright-magenta": "#bc05bc",
      "--terminal-ansi-bright-cyan": "#0598bc",
      "--terminal-ansi-bright-white": "#a5a5a5",
      "--accent": "#c45200",
    };
    for (const [token, value] of Object.entries(terminalTokens)) {
      document.documentElement.style.setProperty(token, value);
    }

    render(
      <IntegratedTerminal
        desktopApi={{
          createIntegratedTerminal: vi.fn(async () => ({
            sessionId: "session-1",
            threadKey: "codex:thread-a",
            cwd: "/repo/a",
            shell: "/bin/zsh",
          })),
          writeIntegratedTerminal: vi.fn(async () => undefined),
          resizeIntegratedTerminal: vi.fn(async () => undefined),
          onIntegratedTerminalOutput: vi.fn(() => () => undefined),
          onIntegratedTerminalExit: vi.fn(() => () => undefined),
          onIntegratedTerminalError: vi.fn(() => () => undefined),
        }}
        threadKey="codex:thread-a"
        cwd="/repo/a"
        height={260}
        onHeightChange={() => undefined}
        onClose={() => undefined}
        onExit={() => undefined}
      />,
    );

    await waitFor(() => expect(xtermState.instances).toHaveLength(1));

    const options = xtermState.instances[0]!.options as {
      theme: Record<string, string>;
    };
    expect(options.theme).toMatchObject({
      background: "#ffffff",
      foreground: "#333333",
      cursor: "#d96d00",
      cursorAccent: "#ffffff",
      selectionBackground: "#c45200",
      black: "#000000",
      red: "#cd3131",
      green: "#107c10",
      yellow: "#949800",
      blue: "#0451a5",
      magenta: "#bc05bc",
      cyan: "#0598bc",
      white: "#555555",
      brightBlack: "#666666",
      brightWhite: "#a5a5a5",
    });
  });

  it("buffers user input until the pty session attaches", async () => {
    let resolveCreate: (
      value: Awaited<ReturnType<NonNullable<DesktopApi["createIntegratedTerminal"]>>>,
    ) => void = () => undefined;
    const createIntegratedTerminal = vi.fn(
      () =>
        new Promise<
          Awaited<ReturnType<NonNullable<DesktopApi["createIntegratedTerminal"]>>>
        >((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const writeIntegratedTerminal = vi.fn(async () => undefined);

    render(
      <IntegratedTerminal
        desktopApi={{
          createIntegratedTerminal,
          writeIntegratedTerminal,
          resizeIntegratedTerminal: vi.fn(async () => undefined),
          onIntegratedTerminalOutput: vi.fn(() => () => undefined),
          onIntegratedTerminalExit: vi.fn(() => () => undefined),
          onIntegratedTerminalError: vi.fn(() => () => undefined),
        }}
        threadKey="codex:thread-a"
        cwd="/repo/a"
        height={260}
        onHeightChange={() => undefined}
        onClose={() => undefined}
        onExit={() => undefined}
      />,
    );

    await waitFor(() => expect(xtermState.instances).toHaveLength(1));

    act(() => {
      xtermState.instances[0]!.emitData("exit\r");
    });
    expect(writeIntegratedTerminal).not.toHaveBeenCalled();

    await act(async () => {
      resolveCreate({
        sessionId: "session-1",
        threadKey: "codex:thread-a",
        cwd: "/repo/a",
        shell: "/bin/zsh",
      });
    });

    await waitFor(() => {
      expect(writeIntegratedTerminal).toHaveBeenCalledWith({
        sessionId: "session-1",
        data: "exit\r",
      });
    });
  });

  it("does not send terminal replies from replayed output back to the pty", async () => {
    xtermState.replayDataEvents.set("saved terminal output", [
      "\u001b[>0;276;0c\u001b]10;rgb:cccc/cccc/cccc\u001b\\",
    ]);
    const writeIntegratedTerminal = vi.fn(async () => undefined);

    render(
      <IntegratedTerminal
        desktopApi={{
          createIntegratedTerminal: vi.fn(async () => ({
            sessionId: "session-1",
            threadKey: "codex:thread-a",
            cwd: "/repo/a",
            shell: "/bin/zsh",
            buffer: "saved terminal output",
          })),
          writeIntegratedTerminal,
          resizeIntegratedTerminal: vi.fn(async () => undefined),
          onIntegratedTerminalOutput: vi.fn(() => () => undefined),
          onIntegratedTerminalExit: vi.fn(() => () => undefined),
          onIntegratedTerminalError: vi.fn(() => () => undefined),
        }}
        threadKey="codex:thread-a"
        cwd="/repo/a"
        height={260}
        onHeightChange={() => undefined}
        onClose={() => undefined}
        onExit={() => undefined}
      />,
    );

    await waitFor(() => expect(xtermState.instances).toHaveLength(1));
    await waitFor(() => {
      expect(xtermState.instances[0]!.write).toHaveBeenCalled();
    });
    expect(xtermState.instances[0]!.write.mock.calls[0]?.[0]).toBe(
      "saved terminal output",
    );

    expect(writeIntegratedTerminal).not.toHaveBeenCalled();

    act(() => {
      xtermState.instances[0]!.emitData("echo still forwards\r");
    });

    await waitFor(() => {
      expect(writeIntegratedTerminal).toHaveBeenCalledWith({
        sessionId: "session-1",
        data: "echo still forwards\r",
      });
    });
  });

  it("queues user input typed while replayed output is still rendering", async () => {
    xtermState.deferWriteCallbacks = true;
    xtermState.replayDataEvents.set("saved terminal output", [
      "\u001b[>0;276;0c",
      "echo typed during replay\r",
    ]);
    const writeIntegratedTerminal = vi.fn(async () => undefined);

    render(
      <IntegratedTerminal
        desktopApi={{
          createIntegratedTerminal: vi.fn(async () => ({
            sessionId: "session-1",
            threadKey: "codex:thread-a",
            cwd: "/repo/a",
            shell: "/bin/zsh",
            buffer: "saved terminal output",
          })),
          writeIntegratedTerminal,
          resizeIntegratedTerminal: vi.fn(async () => undefined),
          onIntegratedTerminalOutput: vi.fn(() => () => undefined),
          onIntegratedTerminalExit: vi.fn(() => () => undefined),
          onIntegratedTerminalError: vi.fn(() => () => undefined),
        }}
        threadKey="codex:thread-a"
        cwd="/repo/a"
        height={260}
        onHeightChange={() => undefined}
        onClose={() => undefined}
        onExit={() => undefined}
      />,
    );

    await waitFor(() => expect(xtermState.instances).toHaveLength(1));
    await waitFor(() => {
      expect(xtermState.pendingWriteCallbacks).toHaveLength(1);
    });

    expect(writeIntegratedTerminal).not.toHaveBeenCalled();

    act(() => {
      xtermState.pendingWriteCallbacks.shift()?.();
    });

    await waitFor(() => {
      expect(writeIntegratedTerminal).toHaveBeenCalledTimes(1);
      expect(writeIntegratedTerminal).toHaveBeenCalledWith({
        sessionId: "session-1",
        data: "echo typed during replay\r",
      });
    });
  });
});
