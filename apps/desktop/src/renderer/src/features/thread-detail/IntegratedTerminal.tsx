import "@xterm/xterm/css/xterm.css";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DesktopApi } from "../../lib/desktop-api";
import type { Terminal } from "@xterm/xterm";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";

const TERMINAL_MIN_HEIGHT = 140;
const TERMINAL_MAX_HEIGHT = 560;
const TERMINAL_RESIZE_STEP = 16;

type IntegratedTerminalProps = {
  desktopApi?: DesktopApi;
  threadKey: string;
  cwd?: string;
  height: number;
  visible?: boolean;
  onHeightChange: (height: number) => void;
  onClose: () => void;
  onExit: () => void;
};

export function IntegratedTerminal({
  desktopApi,
  threadKey,
  cwd,
  height,
  visible = true,
  onHeightChange,
  onClose,
  onExit,
}: IntegratedTerminalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const sessionIdRef = useRef<string | undefined>(undefined);
  const pendingInputRef = useRef<string[]>([]);
  const replayingBufferedOutputRef = useRef(false);
  const fitAndResizeRef = useRef<() => void>(() => undefined);
  const visibleRef = useRef(visible);
  const [status, setStatus] = useState<string>("Starting shell...");

  useEffect(() => {
    visibleRef.current = visible;
  }, [visible]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || !desktopApi?.createIntegratedTerminal) {
      setStatus("Terminal IPC is unavailable.");
      return;
    }

    const createIntegratedTerminal = desktopApi.createIntegratedTerminal;
    let disposed = false;
    let cleanupTerminal: (() => void) | undefined;

    void Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")])
      .then(([xtermModule, fitModule]) => {
        if (disposed) return;

        const terminal = new xtermModule.Terminal({
          allowTransparency: true,
          cursorBlink: true,
          cursorStyle: "block",
          fontFamily: cssVariable("--font-mono"),
          fontSize: 12,
          lineHeight: 1.25,
          macOptionIsMeta: true,
          scrollback: 5_000,
          theme: {
            background: cssVariable("--terminal-bg"),
            foreground: cssVariable("--terminal-fg"),
            cursor: cssVariable("--terminal-cursor"),
            cursorAccent: cssVariable("--terminal-cursor-accent"),
            selectionBackground: cssVariable("--accent"),
            black: cssVariable("--terminal-ansi-black"),
            red: cssVariable("--terminal-ansi-red"),
            green: cssVariable("--terminal-ansi-green"),
            yellow: cssVariable("--terminal-ansi-yellow"),
            blue: cssVariable("--terminal-ansi-blue"),
            magenta: cssVariable("--terminal-ansi-magenta"),
            cyan: cssVariable("--terminal-ansi-cyan"),
            white: cssVariable("--terminal-ansi-white"),
            brightBlack: cssVariable("--terminal-ansi-bright-black"),
            brightRed: cssVariable("--terminal-ansi-bright-red"),
            brightGreen: cssVariable("--terminal-ansi-bright-green"),
            brightYellow: cssVariable("--terminal-ansi-bright-yellow"),
            brightBlue: cssVariable("--terminal-ansi-bright-blue"),
            brightMagenta: cssVariable("--terminal-ansi-bright-magenta"),
            brightCyan: cssVariable("--terminal-ansi-bright-cyan"),
            brightWhite: cssVariable("--terminal-ansi-bright-white"),
          },
        });
        const fitAddon = new fitModule.FitAddon();
        terminal.loadAddon(fitAddon);
        terminal.open(container);
        terminal.focus();
        terminalRef.current = terminal;

        const fitAndResize = () => {
          if (!visibleRef.current) return;
          if (disposed || !desktopApi.resizeIntegratedTerminal) return;
          fitAddon.fit();
          const sessionId = sessionIdRef.current;
          if (!sessionId) return;
          void desktopApi.resizeIntegratedTerminal({
            sessionId,
            cols: terminal.cols,
            rows: terminal.rows,
          });
        };
        fitAndResizeRef.current = fitAndResize;

        const dataDisposable = terminal.onData((data) => {
          if (replayingBufferedOutputRef.current) {
            if (isReplayGeneratedTerminalReply(data)) {
              return;
            }
            pendingInputRef.current.push(data);
            return;
          }
          const sessionId = sessionIdRef.current;
          if (!sessionId) {
            pendingInputRef.current.push(data);
            return;
          }
          if (!desktopApi.writeIntegratedTerminal) return;
          void desktopApi.writeIntegratedTerminal({ sessionId, data });
        });

        const resizeObserver = new ResizeObserver(() => {
          fitAndResize();
        });
        resizeObserver.observe(container);

        const dimensions = fitAddon.proposeDimensions();
        void createIntegratedTerminal({
          threadKey,
          cwd,
          cols: dimensions?.cols ?? terminal.cols,
          rows: dimensions?.rows ?? terminal.rows,
        })
          .then((response) => {
            if (disposed) return;
            sessionIdRef.current = response.sessionId;
            setStatus(response.cwd);
            const finishAttach = () => {
              if (disposed) return;
              const pendingInput = pendingInputRef.current.join("");
              pendingInputRef.current = [];
              if (pendingInput && desktopApi.writeIntegratedTerminal) {
                void desktopApi.writeIntegratedTerminal({
                  sessionId: response.sessionId,
                  data: pendingInput,
                });
              }
              fitAndResize();
              if (visibleRef.current) {
                terminal.focus();
              }
            };
            if (response.buffer) {
              replayingBufferedOutputRef.current = true;
              terminal.write(response.buffer, () => {
                replayingBufferedOutputRef.current = false;
                finishAttach();
              });
            } else {
              finishAttach();
            }
          })
          .catch((error) => {
            if (disposed) return;
            setStatus(error instanceof Error ? error.message : String(error));
          });

        cleanupTerminal = () => {
          resizeObserver.disconnect();
          dataDisposable.dispose();
          terminal.dispose();
          terminalRef.current = null;
        };
      })
      .catch((error) => {
        if (disposed) return;
        setStatus(error instanceof Error ? error.message : String(error));
      });

    return () => {
      disposed = true;
      sessionIdRef.current = undefined;
      pendingInputRef.current = [];
      replayingBufferedOutputRef.current = false;
      fitAndResizeRef.current = () => undefined;
      cleanupTerminal?.();
    };
  }, [cwd, desktopApi, threadKey]);

  useEffect(() => {
    if (!visible) {
      return;
    }
    fitAndResizeRef.current();
    terminalRef.current?.focus();
  }, [height, visible]);

  const resizeBy = (delta: number) => {
    onHeightChange(clampTerminalHeight(height + delta));
  };

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();

    const startY = event.clientY;
    const startHeight = height;

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const delta = startY - moveEvent.clientY;
      onHeightChange(clampTerminalHeight(startHeight + delta));
    };
    const stopResize = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResize, { once: true });
    window.addEventListener("pointercancel", stopResize, { once: true });
  };

  const handleResizeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowUp") {
      event.preventDefault();
      resizeBy(TERMINAL_RESIZE_STEP);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      resizeBy(-TERMINAL_RESIZE_STEP);
    }
  };

  useEffect(() => {
    if (!desktopApi?.onIntegratedTerminalOutput) return;
    return desktopApi.onIntegratedTerminalOutput((event) => {
      if (event.sessionId !== sessionIdRef.current) return;
      terminalRef.current?.write(event.data);
    });
  }, [desktopApi]);

  useEffect(() => {
    if (!desktopApi?.onIntegratedTerminalExit) return;
    return desktopApi.onIntegratedTerminalExit((event) => {
      if (event.sessionId !== sessionIdRef.current) return;
      const suffix =
        event.exitCode === null ? "" : ` with exit code ${event.exitCode}`;
      setStatus(`Shell exited${suffix}`);
      sessionIdRef.current = undefined;
      onExit();
    });
  }, [desktopApi, onExit]);

  useEffect(() => {
    if (!desktopApi?.onIntegratedTerminalError) return;
    return desktopApi.onIntegratedTerminalError((event) => {
      if (event.sessionId && event.sessionId !== sessionIdRef.current) return;
      setStatus(event.message);
    });
  }, [desktopApi]);

  return (
    <section
      className="integrated-terminal"
      aria-label="Integrated terminal"
      hidden={!visible}
      style={
        {
          "--integrated-terminal-height": `${clampTerminalHeight(height)}px`,
        } as CSSProperties
      }
    >
      <div
        aria-label="Resize terminal"
        aria-orientation="horizontal"
        aria-valuenow={clampTerminalHeight(height)}
        aria-valuemin={TERMINAL_MIN_HEIGHT}
        aria-valuemax={TERMINAL_MAX_HEIGHT}
        className="integrated-terminal__resize-handle"
        role="separator"
        tabIndex={0}
        onKeyDown={handleResizeKeyDown}
        onPointerDown={startResize}
      />
      <button
        type="button"
        className="integrated-terminal__close"
        aria-label="Close terminal"
        title="Close terminal"
        onClick={onClose}
        onPointerDown={(event) => {
          event.stopPropagation();
        }}
      >
        ×
      </button>
      <span className="integrated-terminal__status" role="status">
        {status}
      </span>
      <div className="integrated-terminal__body">
        <div ref={containerRef} className="integrated-terminal__viewport" />
      </div>
    </section>
  );
}

function cssVariable(name: string): string {
  return getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
}

function clampTerminalHeight(value: number): number {
  if (!Number.isFinite(value)) {
    return 260;
  }
  const viewportMax =
    typeof window === "undefined"
      ? TERMINAL_MAX_HEIGHT
      : Math.max(TERMINAL_MIN_HEIGHT, Math.floor(window.innerHeight * 0.68));
  return Math.min(
    Math.min(TERMINAL_MAX_HEIGHT, viewportMax),
    Math.max(TERMINAL_MIN_HEIGHT, Math.round(value)),
  );
}

function isReplayGeneratedTerminalReply(data: string): boolean {
  return REPLAY_GENERATED_TERMINAL_REPLY_PATTERN.test(data);
}

const replayGeneratedTerminalReplyToken =
  "(?:\\x1b\\[(?:\\?[0-9;]*|>[0-9;]*|[0-9;]*)c)"
  + "|(?:\\x1b\\[0n)"
  + "|(?:\\x1b\\[\\??[0-9]+;[0-9]+R)"
  + "|(?:\\x1b\\[\\??[0-9;]+;[0-9]+\\$y)"
  + "|(?:\\x1b\\](?:1[012]|4;[0-9]+);rgb:[0-9a-fA-F]{1,4}/[0-9a-fA-F]{1,4}/[0-9a-fA-F]{1,4}(?:\\x07|\\x1b\\\\))";

const REPLAY_GENERATED_TERMINAL_REPLY_PATTERN = new RegExp(
  `^(?:${replayGeneratedTerminalReplyToken})+$`,
);
