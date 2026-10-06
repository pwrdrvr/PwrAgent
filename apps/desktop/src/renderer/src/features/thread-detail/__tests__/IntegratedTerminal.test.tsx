import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    keyHandler?: (event: KeyboardEvent) => boolean;
    selection: string;
  }>,
  deferWriteCallbacks: false,
  pendingWriteCallbacks: [] as Array<() => void>,
  replayDataEvents: new Map<string, string[]>(),
  fit: vi.fn(),
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    focus = vi.fn();
    handlers: Array<(data: string) => void> = [];
    keyHandler?: (event: KeyboardEvent) => boolean;
    selection = "";

    constructor(public options: unknown) {
      xtermState.instances.push(this);
    }

    loadAddon = vi.fn();
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
      this.keyHandler = handler;
    }
    hasSelection = () => this.selection.length > 0;
    getSelection = () => this.selection;
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
    fit = xtermState.fit;
    proposeDimensions = vi.fn(() => ({ cols: 100, rows: 22 }));
  },
}));

class MockResizeObserver {
  static instances: MockResizeObserver[] = [];
  constructor(readonly callback: () => void) {
    MockResizeObserver.instances.push(this);
  }
  observe = vi.fn();
  disconnect = vi.fn();
}

describe("IntegratedTerminal", () => {
  beforeEach(() => {
    xtermState.instances.length = 0;
    xtermState.deferWriteCallbacks = false;
    xtermState.pendingWriteCallbacks.length = 0;
    xtermState.replayDataEvents.clear();
    xtermState.fit.mockClear();
    MockResizeObserver.instances = [];
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

  it.each([
    ["linux", false],
    ["linux", true],
    ["win32", false],
    ["win32", true],
  ])("leaves native paste enabled without sending quoted-insert on %s (shift=%s)", async (platform, shiftKey) => {
    const writeIntegratedTerminal = vi.fn(async () => undefined);
    render(
      <IntegratedTerminal
        desktopApi={{
          platform,
          createIntegratedTerminal: vi.fn(async () => ({
            sessionId: "session-1", threadKey: "codex:thread-a", cwd: "/repo/a", shell: "/bin/bash",
          })),
          writeIntegratedTerminal,
        }}
        threadKey="codex:thread-a"
        height={260}
        onClose={() => undefined}
        onExit={() => undefined}
      />,
    );
    await waitFor(() => expect(xtermState.instances[0]?.keyHandler).toBeDefined());
    const terminal = xtermState.instances[0]!;
    for (const type of ["keydown", "keypress", "keyup"]) {
      const event = new KeyboardEvent(type, { key: "v", ctrlKey: true, shiftKey, cancelable: true });
      expect(terminal.keyHandler!(event)).toBe(false);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(writeIntegratedTerminal).not.toHaveBeenCalled();

    // xterm's native paste event emits one framed payload. Keep those frames:
    // Readline uses them to insert multiline commands without executing them.
    const paste = "\u001b[200~lsblk -o NAME,SIZE\r\u001b[201~";
    act(() => terminal.emitData(paste));
    expect(writeIntegratedTerminal).toHaveBeenCalledExactlyOnceWith({
      sessionId: "session-1", data: paste,
    });
    expect(terminal.keyHandler!(new KeyboardEvent("keydown", { key: "c", ctrlKey: true }))).toBe(true);
    expect(terminal.keyHandler!(new KeyboardEvent("keydown", { key: "v", ctrlKey: true, altKey: true }))).toBe(true);
  });

  it("preserves macOS Command+V paste and Ctrl+V shell input", async () => {
    render(
      <IntegratedTerminal
        desktopApi={{
          platform: "darwin",
          createIntegratedTerminal: vi.fn(async () => ({
            sessionId: "session-1", threadKey: "codex:thread-a", cwd: "/repo/a", shell: "/bin/zsh",
          })),
        }}
        threadKey="codex:thread-a"
        height={260}
        onClose={() => undefined}
        onExit={() => undefined}
      />,
    );
    await waitFor(() => expect(xtermState.instances[0]?.keyHandler).toBeDefined());
    const handler = xtermState.instances[0]!.keyHandler!;
    expect(handler(new KeyboardEvent("keydown", { key: "v", metaKey: true }))).toBe(true);
    expect(handler(new KeyboardEvent("keydown", { key: "v", ctrlKey: true }))).toBe(true);
    expect(handler(new KeyboardEvent("keydown", { key: "c", ctrlKey: true, shiftKey: true }))).toBe(true);
  });

  it("copies a Linux terminal selection with Ctrl+Shift+C and requests its own context menu", async () => {
    const copyText = vi.fn(async () => undefined);
    const showIntegratedTerminalContextMenu = vi.fn(async () => undefined);
    const { container } = render(
      <IntegratedTerminal
        desktopApi={{
          platform: "linux",
          copyText,
          showIntegratedTerminalContextMenu,
          createIntegratedTerminal: vi.fn(async () => ({
            sessionId: "session-1", threadKey: "codex:thread-a", cwd: "/repo/a", shell: "/bin/bash",
          })),
        }}
        threadKey="codex:thread-a"
        height={260}
        onClose={() => undefined}
        onExit={() => undefined}
      />,
    );
    await waitFor(() => expect(xtermState.instances[0]?.keyHandler).toBeDefined());
    const terminal = xtermState.instances[0]!;
    const viewport = container.querySelector(".integrated-terminal__viewport")!;
    fireEvent.contextMenu(viewport, { clientX: 20, clientY: 30 });
    expect(showIntegratedTerminalContextMenu).toHaveBeenLastCalledWith({ x: 20, y: 30, canCopy: false });

    terminal.selection = "selected shell output";
    for (const type of ["keydown", "keyup"]) {
      const event = new KeyboardEvent(type, { key: "C", ctrlKey: true, shiftKey: true, cancelable: true });
      expect(terminal.keyHandler!(event)).toBe(false);
      expect(event.defaultPrevented).toBe(true);
    }
    expect(copyText).toHaveBeenCalledExactlyOnceWith("selected shell output");
    fireEvent.contextMenu(viewport, { clientX: 20, clientY: 30 });
    expect(showIntegratedTerminalContextMenu).toHaveBeenLastCalledWith({ x: 20, y: 30, canCopy: true });
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

  it("repaints from the live tokens when the theme changes", async () => {
    // The pane's background follows the theme through CSS, but xterm draws
    // text from the palette it was handed. A terminal opened under Blue Dark
    // kept Blue Dark's pale ink on Blue Light's pale canvas.
    const root = document.documentElement;
    const setTokens = (tokens: Record<string, string>) => {
      for (const [token, value] of Object.entries(tokens)) {
        root.style.setProperty(token, value);
      }
    };
    setTokens({
      "--terminal-bg": "#0f1724",
      "--terminal-fg": "#c9d6ea",
      "--terminal-cursor": "#7fbcff",
      "--terminal-ansi-yellow": "#e5c06a",
    });
    root.setAttribute("data-color-theme", "blue-dark");

    const { unmount } = render(
      <IntegratedTerminal
        desktopApi={{
          createIntegratedTerminal: vi.fn(async () => ({
            sessionId: "session-1",
            threadKey: "codex:thread-a",
            cwd: "/repo/a",
            shell: "/bin/zsh",
          })),
          resizeIntegratedTerminal: vi.fn(async () => undefined),
        }}
        threadKey="codex:thread-a"
        height={260}
        onClose={() => undefined}
        onExit={() => undefined}
      />,
    );
    await waitFor(() => expect(xtermState.instances).toHaveLength(1));
    const options = xtermState.instances[0]!.options as {
      theme: Record<string, string>;
    };
    expect(options.theme).toMatchObject({ foreground: "#c9d6ea", yellow: "#e5c06a" });

    // `applyAppearanceAttributes` flips both attributes for a scheme change.
    setTokens({
      "--terminal-bg": "#f3f7fc",
      "--terminal-fg": "#1f2f47",
      "--terminal-cursor": "#1f5fbf",
      "--terminal-ansi-yellow": "#8a6100",
    });
    root.setAttribute("data-theme", "light");
    root.setAttribute("data-color-theme", "blue-light");
    await waitFor(() => expect(options.theme).toMatchObject({
      background: "#f3f7fc",
      foreground: "#1f2f47",
      cursor: "#1f5fbf",
      yellow: "#8a6100",
    }));

    // A switch between two themes of the same scheme changes only
    // `data-color-theme`, and must repaint too.
    setTokens({ "--terminal-fg": "#2e2e33" });
    root.setAttribute("data-color-theme", "gray-light");
    await waitFor(() => expect(options.theme.foreground).toBe("#2e2e33"));

    unmount();
    setTokens({ "--terminal-fg": "#333333" });
    root.removeAttribute("data-color-theme");
    await Promise.resolve();
    expect(options.theme.foreground).toBe("#2e2e33");
    root.removeAttribute("data-theme");
  });

  it("opens xterm only after the mono faces load", async () => {
    // xterm measures its cells once, at open(), and never again when a web
    // font arrives, so opening first would size the grid for the fallback.
    let resolveFonts: () => void = () => undefined;
    const fontsLoaded = new Promise<void>((resolve) => {
      resolveFonts = resolve;
    });
    const load = vi.fn(() => fontsLoaded.then(() => []));
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { load },
    });
    document.documentElement.style.setProperty("--font-mono", "\"Geist Mono\", monospace");

    try {
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

      await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
      expect(load).toHaveBeenCalledWith("12px \"Geist Mono\", monospace");
      expect(load).toHaveBeenCalledWith("bold 12px \"Geist Mono\", monospace");
      // Let the xterm imports settle: only the font load holds it back now.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(xtermState.instances).toHaveLength(0);

      await act(async () => {
        resolveFonts();
        await fontsLoaded;
      });
      await waitFor(() => expect(xtermState.instances).toHaveLength(1));
    } finally {
      delete (document as { fonts?: unknown }).fonts;
    }
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
      "\u001b[0n",
      "\u001b[12;34R",
      "\u001b[?12;34R",
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

  it("draws its own close and resize chrome when it is standalone", async () => {
    render(
      <IntegratedTerminal
        desktopApi={terminalApiStub()}
        threadKey="codex:thread-a"
        cwd="/repo/a"
        height={260}
        onHeightChange={() => undefined}
        onClose={() => undefined}
        onExit={() => undefined}
      />,
    );

    await waitFor(() => expect(xtermState.instances).toHaveLength(1));

    expect(screen.getByLabelText("Close terminal")).toBeInTheDocument();
    expect(screen.getByLabelText("Resize terminal")).toBeInTheDocument();
  });

  // A hosting card supplies a title bar with its own close button and its
  // own resize grip. Drawing the pane's too put a second close 3px under
  // the card's and a panel-colored dead band under the bar.
  it("draws no close, handle, or remote chip when a card hosts it", async () => {
    render(
      <IntegratedTerminal
        chrome="hosted"
        desktopApi={terminalApiStub()}
        threadKey="codex:thread-a"
        cwd="/repo/a"
        height={260}
        remote={{
          target: { instanceId: "peer-1", scope: "remote" },
          instanceId: "peer-1",
          instanceLabel: "Peer One",
        }}
        onClose={() => undefined}
        onExit={() => undefined}
      />,
    );

    await waitFor(() => expect(xtermState.instances).toHaveLength(1));

    expect(screen.queryByLabelText("Close terminal")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Resize terminal")).not.toBeInTheDocument();
    expect(screen.queryByText("Peer One")).not.toBeInTheDocument();
  });
  // The hosting card owns the resize affordance, so a height change must not
  // pull focus off the card's grip and into the shell.
  it("keeps focus off the shell when a hosted card resizes it", async () => {
    const api = terminalApiStub();
    const view = (height: number) => (
      <IntegratedTerminal
        chrome="hosted"
        desktopApi={api}
        threadKey="codex:thread-a"
        cwd="/repo/a"
        height={height}
        onClose={() => undefined}
        onExit={() => undefined}
      />
    );
    const { rerender } = render(view(260));

    await waitFor(() => expect(xtermState.instances).toHaveLength(1));
    const terminal = xtermState.instances[0]!;
    terminal.focus.mockClear();

    rerender(view(300));

    expect(terminal.focus).not.toHaveBeenCalled();
  });

  it("coalesces terminal fitting outside observer delivery", async () => {
    const api = terminalApiStub();
    render(<IntegratedTerminal desktopApi={api} threadKey="codex:resize" height={260}
      onClose={() => undefined} onExit={() => undefined} />);
    await waitFor(() => expect(api.resizeIntegratedTerminal).toHaveBeenCalled());
    const frames = mockAnimationFrames();
    const observer = MockResizeObserver.instances[0]!;
    xtermState.fit.mockClear();
    vi.mocked(api.resizeIntegratedTerminal!).mockClear();

    act(() => { observer.callback(); observer.callback(); });
    expect(xtermState.fit).not.toHaveBeenCalled();
    expect(api.resizeIntegratedTerminal).not.toHaveBeenCalled();
    act(() => frames.flush());
    expect(xtermState.fit).toHaveBeenCalledTimes(1);
    expect(api.resizeIntegratedTerminal).toHaveBeenCalledTimes(1);
    vi.mocked(api.resizeIntegratedTerminal!).mockClear();

    // Several pixel resizes can land in one frame; xterm's final grid is
    // the one the shared PTY owner needs.
    xtermState.instances[0]!.cols = 101;
    xtermState.instances[0]!.rows = 25;
    act(() => { observer.callback(); observer.callback(); });
    act(() => frames.flush());
    expect(api.resizeIntegratedTerminal).toHaveBeenCalledExactlyOnceWith({ sessionId: "session-1", cols: 101, rows: 25 });
  });

  it("cancels a queued fit when the terminal unmounts", async () => {
    const api = terminalApiStub();
    const { unmount } = render(<IntegratedTerminal desktopApi={api} threadKey="codex:resize" height={260}
      onClose={() => undefined} onExit={() => undefined} />);
    await waitFor(() => expect(api.resizeIntegratedTerminal).toHaveBeenCalled());
    const frames = mockAnimationFrames();
    const observer = MockResizeObserver.instances[0]!;
    xtermState.fit.mockClear();
    vi.mocked(api.resizeIntegratedTerminal!).mockClear();
    act(() => observer.callback());
    expect(frames.pending.size).toBe(1);
    unmount();
    expect(frames.pending.size).toBe(0);
    // A delivered callback retained by the browser must not revive work.
    act(() => { observer.callback(); frames.flush(); });
    expect(xtermState.fit).not.toHaveBeenCalled();
    expect(api.resizeIntegratedTerminal).not.toHaveBeenCalled();
  });

  it("skips a queued fit while hidden and fits the current grid when shown", async () => {
    const api = terminalApiStub();
    const view = (visible: boolean) => <IntegratedTerminal desktopApi={api} threadKey="codex:resize" height={260}
      visible={visible} onClose={() => undefined} onExit={() => undefined} />;
    const { rerender } = render(view(true));
    await waitFor(() => expect(api.resizeIntegratedTerminal).toHaveBeenCalled());
    const frames = mockAnimationFrames();
    xtermState.fit.mockClear();
    vi.mocked(api.resizeIntegratedTerminal!).mockClear();
    act(() => MockResizeObserver.instances[0]!.callback());
    rerender(view(false));
    act(() => frames.flush());
    expect(xtermState.fit).not.toHaveBeenCalled();
    expect(api.resizeIntegratedTerminal).not.toHaveBeenCalled();

    xtermState.instances[0]!.rows = 30;
    rerender(view(true));
    act(() => frames.flush());
    expect(xtermState.fit).toHaveBeenCalledTimes(1);
    expect(api.resizeIntegratedTerminal).toHaveBeenCalledExactlyOnceWith({ sessionId: "session-1", cols: 80, rows: 30 });
  });
});

function mockAnimationFrames() {
  let nextId = 0;
  const pending = new Map<number, FrameRequestCallback>();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    pending.set(++nextId, callback);
    return nextId;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { pending.delete(id); });
  return { pending, flush: () => {
    const callbacks = [...pending.values()];
    pending.clear();
    for (const callback of callbacks) callback(0);
  } };
}

function terminalApiStub(): DesktopApi {
  return {
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
  } as unknown as DesktopApi;
}
