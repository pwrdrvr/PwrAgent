import type { IntegratedTerminalOutputEvent } from "../../../shared/integrated-terminal";
import type { DesktopApi } from "./desktop-api";

type OutputListener = (event: IntegratedTerminalOutputEvent) => void;

export type IntegratedTerminalOutputRoute = {
  /** Main named the session (a pane that asked for none): route by it from now on. */
  setSessionId: (sessionId: string) => void;
  unsubscribe: () => void;
};

type Router = {
  bySession: Map<string, Set<OutputListener>>;
  /** Panes that have not learned their session id yet see every event. */
  unrouted: Set<OutputListener>;
  routes: number;
  unsubscribeBridge?: () => void;
};

const routers = new WeakMap<DesktopApi, Router>();

/**
 * Delivers one session's terminal output to one pane through a single
 * bridge listener per window.
 *
 * Every pane of every thread stays mounted (most of them hidden), and each
 * used to register its own `onIntegratedTerminalOutput` listener. Each chunk
 * of output from one shell then crossed the context bridge once per mounted
 * pane, copying the chunk every time, only for all but one pane to drop it:
 * N panes times every byte of output. Here a chunk crosses once and goes to
 * the panes showing that session.
 */
export function routeIntegratedTerminalOutput(
  desktopApi: DesktopApi,
  sessionId: string | undefined,
  listener: OutputListener,
): IntegratedTerminalOutputRoute | undefined {
  const subscribe = desktopApi.onIntegratedTerminalOutput;
  if (!subscribe) return undefined;
  let router = routers.get(desktopApi);
  if (!router) {
    router = { bySession: new Map(), unrouted: new Set(), routes: 0 };
    routers.set(desktopApi, router);
  }
  const owner = router;
  if (owner.routes === 0) {
    owner.unsubscribeBridge = subscribe((event) => dispatch(owner, event));
  }
  owner.routes += 1;

  let current = sessionId;
  add(owner, current, listener);
  let active = true;
  return {
    setSessionId(next) {
      if (!active || next === current) return;
      remove(owner, current, listener);
      current = next;
      add(owner, current, listener);
    },
    unsubscribe() {
      if (!active) return;
      active = false;
      remove(owner, current, listener);
      owner.routes -= 1;
      if (owner.routes === 0) {
        owner.unsubscribeBridge?.();
        owner.unsubscribeBridge = undefined;
      }
    },
  };
}

function add(router: Router, sessionId: string | undefined, listener: OutputListener): void {
  if (sessionId === undefined) {
    router.unrouted.add(listener);
    return;
  }
  let listeners = router.bySession.get(sessionId);
  if (!listeners) {
    listeners = new Set();
    router.bySession.set(sessionId, listeners);
  }
  listeners.add(listener);
}

function remove(router: Router, sessionId: string | undefined, listener: OutputListener): void {
  if (sessionId === undefined) {
    router.unrouted.delete(listener);
    return;
  }
  const listeners = router.bySession.get(sessionId);
  listeners?.delete(listener);
  if (listeners?.size === 0) router.bySession.delete(sessionId);
}

function dispatch(router: Router, event: IntegratedTerminalOutputEvent): void {
  const listeners = router.bySession.get(event.sessionId);
  // Copies: a listener may close its pane, or re-key itself, mid-dispatch.
  if (listeners) for (const listener of [...listeners]) listener(event);
  if (router.unrouted.size) for (const listener of [...router.unrouted]) listener(event);
}
