import { useLayoutEffect } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type {
  IntegratedTerminalErrorEvent,
  IntegratedTerminalExitEvent,
  IntegratedTerminalOutputEvent,
  IntegratedTerminalSessionSummary,
  IntegratedTerminalSessionsEvent,
} from "../src/shared/integrated-terminal";
import { ThreadTerminalPanel } from "../src/renderer/src/features/thread-detail/ThreadTerminalPanel";
import type { DesktopApi } from "../src/renderer/src/lib/desktop-api";
import { useIntegratedTerminals } from "../src/renderer/src/lib/useIntegratedTerminals";
import "../src/renderer/src/styles/app.css";
import { measureTerminalLayout } from "./terminal-oracles";

const threadKey = "terminal-layout-thread";
const composerHeight = 150;
const root = createRoot(document.getElementById("root")!);

function eventChannel<T>() {
  const listeners = new Set<(event: T) => void>();
  return {
    subscribe: (listener: (event: T) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    emit: (event: T) => {
      for (const listener of listeners) listener(event);
    },
  };
}

function makeTerminalBridge() {
  const sessions = new Map<string, IntegratedTerminalSessionSummary>();
  const ptyRows = new Map<string, number>();
  const sessionEvents = eventChannel<IntegratedTerminalSessionsEvent>();
  const output = eventChannel<IntegratedTerminalOutputEvent>();
  const exit = eventChannel<IntegratedTerminalExitEvent>();
  const error = eventChannel<IntegratedTerminalErrorEvent>();
  const publishSessions = () => sessionEvents.emit({ sessions: [...sessions.values()] });
  const api = {
    platform: "linux",
    createIntegratedTerminal: async ({ sessionId, rows, threadKey }) => {
      if (!sessionId) throw new Error("The terminal panel must address a session");
      const existing = sessions.get(sessionId);
      if (existing) return existing;
      const session = {
        sessionId, threadKey, cwd: "/example/project", shell: "/bin/zsh",
        panelHidden: false, createdAt: sessions.size, status: "running",
      } as const;
      sessions.set(sessionId, session);
      ptyRows.set(sessionId, rows);
      publishSessions();
      return { ...session, buffer: "fixture-ready" };
    },
    resizeIntegratedTerminal: async ({ sessionId, rows }) => { ptyRows.set(sessionId, rows); },
    onIntegratedTerminalSessions: sessionEvents.subscribe,
    onIntegratedTerminalOutput: output.subscribe,
    onIntegratedTerminalExit: exit.subscribe,
    onIntegratedTerminalError: error.subscribe,
  } satisfies Pick<DesktopApi,
    | "platform"
    | "createIntegratedTerminal"
    | "resizeIntegratedTerminal"
    | "onIntegratedTerminalSessions"
    | "onIntegratedTerminalOutput"
    | "onIntegratedTerminalExit"
    | "onIntegratedTerminalError"
  >;

  return {
    api: api as DesktopApi,
    ptyRows,
    write: (sessionId: string, data: string) => output.emit({ sessionId, data }),
    fail: (sessionId: string) => error.emit({ sessionId, message: "Fixture terminal IPC error" }),
    end: (sessionId: string) => {
      const session = sessions.get(sessionId);
      if (!session) throw new Error("Cannot exit an unattached session");
      sessions.set(sessionId, { ...session, status: "exited", exitCode: 1 });
      exit.emit({ sessionId, exitCode: 1, signal: null });
      publishSessions();
    },
  };
}

let bridge: ReturnType<typeof makeTerminalBridge>;
let setRememberedHeight: (height: number) => void;

function TerminalFixture({ initialHeight }: { initialHeight: number }) {
  const terminals = useIntegratedTerminals(bridge.api);
  const { createTerminal, setHeight } = terminals;
  useLayoutEffect(() => {
    setRememberedHeight = (height) => setHeight(threadKey, height);
    setRememberedHeight(initialHeight);
    createTerminal(threadKey);
  }, [createTerminal, initialHeight, setHeight]);

  return (
    <main className="thread-view__layout" style={{ height: "100%" }}>
      <div className="thread-view__primary">
        <div style={{ flex: "1 1 0", minHeight: 0 }} />
        <div className="thread-view__composer-slot">
          <div aria-hidden="true" style={{ flex: `0 0 ${composerHeight}px` }} />
        </div>
        <ThreadTerminalPanel
          desktopApi={bridge.api} terminals={terminals} threadKey={threadKey}
          panes={terminals.panes} visible={terminals.isPanelOpen(threadKey)}
        />
      </div>
    </main>
  );
}

const terminalLayout = {
  reset(initialHeight: number) {
    // Dispose xterm, its listeners, and pending RAF work before the next case.
    flushSync(() => root.render(null));
    bridge = makeTerminalBridge();
    flushSync(() => root.render(<TerminalFixture initialHeight={initialHeight} />));
  },
  setHeight: (height: number) => flushSync(() => setRememberedHeight(height)),
  write: (sessionId: string, data: string) => bridge.write(sessionId, data),
  fail: (sessionId: string) => flushSync(() => bridge.fail(sessionId)),
  end: (sessionId: string) => flushSync(() => bridge.end(sessionId)),
  async measure() {
    // ResizeObserver schedules fit on RAF, and xterm redraws the rows on RAF
    // after fitting. Read on the following frame to include both. Agreement
    // between PTY and DOM is checked by the oracle, independent of readiness.
    for (let frame = 0; frame < 3; frame += 1) {
      await new Promise(requestAnimationFrame);
    }
    return { ...measureTerminalLayout(bridge.ptyRows), availableHeight: window.innerHeight - composerHeight };
  },
};

declare global {
  interface Window {
    terminalLayout: typeof terminalLayout;
  }
}

window.terminalLayout = terminalLayout;
