import type { WebContents } from "electron";
import type {
  AppServerBackendKind,
  FederationRemoteTarget,
} from "@pwragent/shared";
import {
  isFederationInstanceId,
  isRemoteFederationTarget,
} from "@pwragent/shared";
import {
  INTEGRATED_TERMINAL_ERROR_CHANNEL,
  INTEGRATED_TERMINAL_EXIT_CHANNEL,
  INTEGRATED_TERMINAL_OUTPUT_CHANNEL,
  INTEGRATED_TERMINAL_SESSIONS_CHANNEL,
} from "../../shared/ipc";
import type {
  IntegratedTerminalCloseRequest,
  IntegratedTerminalCreateRequest,
  IntegratedTerminalCreateResponse,
  IntegratedTerminalRemoteInfo,
  IntegratedTerminalResizeRequest,
  IntegratedTerminalSessionSummary,
  IntegratedTerminalSetPanelHiddenRequest,
  IntegratedTerminalWriteRequest,
} from "../../shared/integrated-terminal";
import {
  FEDERATION_PTY_ACK_INTERVAL_BYTES,
  type FederationPtyStreamEvent,
} from "../federation/federation-pty-service";
import { getDesktopFederationRuntime } from "../federation/federation-runtime";
import { getMainLogger } from "../log";
import { federationWindowTargetForWebContents } from "../window";

const log = getMainLogger("pwragent:federation-terminal");

/** Mirrors the local service's replay buffer so a pane remount inside the
 *  viewer replays scrollback without any server-side persistence. */
const OUTPUT_BUFFER_LIMIT = 128 * 1024;

type RemoteTerminalSession = {
  sessionId: string;
  threadKey: string;
  target: FederationRemoteTarget;
  cwd: string;
  shell: string;
  buffer: string;
  panelHidden: boolean;
  createdAt: number;
  webContents: WebContents;
  /** Last stream sequence number seen; gaps are surfaced, never repaired. */
  lastSeq: number;
  /** Output bytes consumed since the last pty.ack. */
  consumedBytes: number;
};

/**
 * Viewer-side remote terminal sessions, one registry entry per federation
 * window pane. The renderer stays protocol-unaware: it speaks the exact
 * INTEGRATED_TERMINAL_* IPC surface it uses for local shells, and this bridge
 * translates to `pty.*` federation RPCs plus streamed notifications.
 */
type PendingRemoteOpen = {
  closeRequested: boolean;
  promise: Promise<IntegratedTerminalCreateResponse>;
};

export class FederationTerminalBridge {
  constructor(
    private readonly options: {
      /**
       * Local PTY sessions to merge into this window's session broadcasts.
       * The MAIN window hosts local and remote sessions side by side and
       * the renderer replaces its whole list per event; a federation window
       * passes nothing — local shells must never leak into peer branding.
       */
      localSessionsFor?: (
        webContents: WebContents,
      ) => IntegratedTerminalSessionSummary[];
    } = {},
  ) {}

  private readonly sessionsById = new Map<string, RemoteTerminalSession>();
  /** In-flight `pty.open`s keyed by `${webContentsId}:${threadKey}`. This is
   *  the remote analogue of the local service's close-during-spawn hardening:
   *  a close issued while the open is still in flight must kill the session
   *  the moment it exists, and a concurrent second create must attach to the
   *  first open instead of spawning a second owner-side shell. */
  private readonly pendingOpens = new Map<string, PendingRemoteOpen>();
  private readonly watchedWebContents = new Set<WebContents>();
  private unsubscribeStreamEvents?: () => void;

  async createOrAttach(
    request: IntegratedTerminalCreateRequest,
    webContents: WebContents,
  ): Promise<IntegratedTerminalCreateResponse> {
    const threadKey = request.threadKey.trim();
    if (!threadKey) {
      throw new Error("A thread key is required to start a remote terminal.");
    }
    // Reattach before target resolution so a pane remount never needs to
    // re-supply the target it created with.
    const existing = this.sessionForThread(webContents, threadKey);
    if (existing) {
      return this.toCreateResponse(existing);
    }
    const target = this.requireTarget(webContents, request);
    const pendingKey = this.pendingKey(webContents, threadKey);
    const inFlight = this.pendingOpens.get(pendingKey);
    if (inFlight) {
      return await inFlight.promise;
    }
    const separator = threadKey.indexOf(":");
    if (separator <= 0 || separator === threadKey.length - 1) {
      throw new Error("Remote terminal thread key is malformed.");
    }
    const backend = threadKey.slice(0, separator) as AppServerBackendKind;
    const threadId = threadKey.slice(separator + 1);
    const pending: PendingRemoteOpen = {
      closeRequested: false,
      promise: Promise.resolve() as unknown as Promise<IntegratedTerminalCreateResponse>,
    };
    pending.promise = (async () => {
      try {
        // The viewer sends only the thread identity and dimensions. Shell and
        // cwd are resolved by the owning instance from ITS thread state.
        const opened = await getDesktopFederationRuntime()
          .remotePty(target)
          .open({
            backend,
            threadId,
            cols: request.cols,
            rows: request.rows,
          });
        if (pending.closeRequested || webContents.isDestroyed()) {
          // The pane was dismissed (or the window died) while the open was in
          // flight. Registering + broadcasting the session anyway would make
          // the renderer re-adopt a shell the user already closed — the exact
          // regression the local service's pendingClose hardening fixed.
          void getDesktopFederationRuntime()
            .remotePty(target)
            .close({ sessionId: opened.sessionId })
            .catch(() => {
              // Peer unreachable — the owner's disconnect reap covers it.
            });
          throw new Error("Remote terminal was closed before it finished starting.");
        }
        const session: RemoteTerminalSession = {
          sessionId: opened.sessionId,
          threadKey,
          target,
          cwd: opened.cwd,
          shell: opened.shell,
          buffer: "",
          panelHidden: false,
          createdAt: Date.now(),
          webContents,
          lastSeq: 0,
          consumedBytes: 0,
        };
        this.sessionsById.set(session.sessionId, session);
        this.ensureStreamSubscription();
        this.watchWebContents(webContents);
        this.broadcastSessions(webContents);
        return this.toCreateResponse(session);
      } finally {
        this.pendingOpens.delete(pendingKey);
      }
    })();
    this.pendingOpens.set(pendingKey, pending);
    return await pending.promise;
  }

  write(request: IntegratedTerminalWriteRequest, webContents: WebContents): void {
    const session = this.ownedSession(webContents, request.sessionId);
    if (!session) return;
    void getDesktopFederationRuntime()
      .remotePty(session.target)
      .input({
        sessionId: session.sessionId,
        dataBase64: Buffer.from(request.data, "utf8").toString("base64"),
      })
      .catch((error) => {
        this.sendError(session, error);
      });
  }

  resize(request: IntegratedTerminalResizeRequest, webContents: WebContents): void {
    const session = this.ownedSession(webContents, request.sessionId);
    if (!session) return;
    void getDesktopFederationRuntime()
      .remotePty(session.target)
      .resize({
        sessionId: session.sessionId,
        cols: request.cols,
        rows: request.rows,
      })
      .catch((error) => {
        log.warn("remote terminal resize failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  close(request: IntegratedTerminalCloseRequest, webContents: WebContents): void {
    const session =
      (request.sessionId
        ? this.ownedSession(webContents, request.sessionId)
        : undefined) ??
      (request.threadKey
        ? this.sessionForThread(webContents, request.threadKey)
        : undefined);
    if (!session) {
      // Nothing registered yet. If the open is still in flight, mark it so
      // the session is closed the moment it exists instead of the close
      // being silently lost.
      if (request.threadKey) {
        const pending = this.pendingOpens.get(
          this.pendingKey(webContents, request.threadKey.trim()),
        );
        if (pending) {
          pending.closeRequested = true;
        }
      }
      return;
    }
    this.dropSession(session);
    this.broadcastSessions(webContents);
    void getDesktopFederationRuntime()
      .remotePty(session.target)
      .close({ sessionId: session.sessionId })
      .catch((error) => {
        // The owner's disconnect reap covers an undeliverable close.
        log.warn("remote terminal close failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  setPanelHidden(
    request: IntegratedTerminalSetPanelHiddenRequest,
    webContents: WebContents,
  ): void {
    const session = this.sessionForThread(webContents, request.threadKey);
    if (!session || session.panelHidden === request.hidden) return;
    session.panelHidden = request.hidden;
    this.broadcastSessions(webContents);
  }

  listSessions(webContents: WebContents): IntegratedTerminalSessionSummary[] {
    // Resolve peer identity ONCE per list build: connectedPeerTargets walks
    // the gateway directory, the store, and live connections and composes
    // display labels, and this runs on every session broadcast.
    const identities = this.remoteIdentities();
    return this.sessionsForWindow(webContents)
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((session) => this.toSummary(session, identities));
  }

  /**
   * Every live remote session, across windows, for the quit blocker. Remote
   * shells cannot be foreground-filtered the way local ones are (the process
   * lives on the owner), so all of them count: quitting the viewer ends them,
   * and silently killing a shell mid-command is the failure this dialog
   * exists to prevent. A future `pty.status` round-trip could narrow it.
   *
   * Each row carries its owning peer: the quit dialog names a thread by
   * looking it up, and a remote thread is not in THIS instance's thread list,
   * so a peer-blind lookup can only fall back to the raw thread id.
   */
  quitSnapshotSessions(): Array<{
    sessionId: string;
    threadKey: string;
    target: FederationRemoteTarget;
    instanceLabel?: string;
  }> {
    const identities = this.remoteIdentities();
    return [...this.sessionsById.values()].map((session) => {
      const instanceLabel = identities.get(
        session.target.instanceId,
      )?.instanceLabel;
      return {
        sessionId: session.sessionId,
        threadKey: session.threadKey,
        target: session.target,
        ...(instanceLabel ? { instanceLabel } : {}),
      };
    });
  }

  /**
   * Un-hide a remote thread's terminal panel and report the windows that host
   * it. The local PTY registry knows nothing about these sessions, so asking
   * only it — as the quit dialog's row link once did — reports "no such
   * session" for every shell running on a peer and reveals nothing.
   */
  revealSession(threadKey: string, instanceId?: string): WebContents[] {
    const owners: WebContents[] = [];
    for (const session of this.sessionsById.values()) {
      if (session.threadKey !== threadKey || session.webContents.isDestroyed()) {
        continue;
      }
      // Two instances can hold the same `backend:threadId`. When the caller
      // knows which one it means, honor it rather than revealing a shell on
      // the wrong machine.
      if (instanceId && session.target.instanceId !== instanceId) {
        continue;
      }
      if (session.panelHidden) {
        session.panelHidden = false;
        this.broadcastSessions(session.webContents);
      }
      owners.push(session.webContents);
    }
    return owners;
  }

  dispose(): void {
    this.unsubscribeStreamEvents?.();
    this.unsubscribeStreamEvents = undefined;
    this.sessionsById.clear();
    this.watchedWebContents.clear();
  }

  private requireTarget(
    webContents: WebContents,
    request: IntegratedTerminalCreateRequest,
  ): FederationRemoteTarget {
    // The window's own target stays authoritative: a federation window can
    // never be steered at a different peer by a renderer-supplied field.
    const windowTarget = federationWindowTargetForWebContents(webContents);
    if (windowTarget) {
      return windowTarget;
    }
    // Main-window path: a remote-pinned thread's terminal names its owning
    // instance per request. The owner still resolves shell + cwd itself and
    // capability-checks remote_pty, exactly as for federation windows — but
    // main must not forward an unvalidated renderer-supplied id to the
    // transport, where an unknown peer falls through to the gateway relay
    // and surfaces as an opaque transport error. Same three checks
    // openFederationWindow applies to its target.
    const requested = request.federationTarget;
    if (requested && isRemoteFederationTarget(requested)) {
      if (!isFederationInstanceId(requested.instanceId)) {
        throw new Error("Invalid remote terminal federation target.");
      }
      const peer = getDesktopFederationRuntime()
        .connectedPeerTargets()
        .find(
          (candidate) => candidate.target.instanceId === requested.instanceId,
        );
      if (!peer) {
        throw new Error(
          `Federation peer ${requested.instanceId} is not connected.`,
        );
      }
      if (!peer.capabilities.includes("remote_pty")) {
        throw new Error(
          `Remote terminal not granted by ${peer.label} (remote_pty capability).`,
        );
      }
      return requested;
    }
    // Defense in depth: never fall through to spawning a LOCAL shell for a
    // request that meant to reach a peer.
    throw new Error(
      "Remote terminal sessions run on the owning instance; no federation target was provided.",
    );
  }

  /** Whether this bridge owns the given session for this window. */
  hasSession(webContents: WebContents, sessionId: string): boolean {
    return this.ownedSession(webContents, sessionId) !== undefined;
  }

  /**
   * Whether a close/panel request for this thread belongs to the bridge:
   * either a registered session or an open still in flight (which the close
   * path must be able to mark).
   */
  hasThreadSession(webContents: WebContents, threadKey: string): boolean {
    const trimmed = threadKey.trim();
    return (
      this.sessionForThread(webContents, trimmed) !== undefined
      || this.pendingOpens.has(this.pendingKey(webContents, trimmed))
    );
  }

  private ensureStreamSubscription(): void {
    this.unsubscribeStreamEvents ??= getDesktopFederationRuntime()
      .onRemotePtyEvent((event) => this.handleStreamEvent(event));
  }

  private handleStreamEvent(event: FederationPtyStreamEvent): void {
    const session = this.sessionsById.get(event.params.sessionId);
    // Only the owning peer may stream into a session it opened for us.
    if (!session || session.target.instanceId !== event.peerId) return;
    if (event.kind === "output") {
      const data = Buffer.from(event.params.dataBase64, "base64").toString("utf8");
      if (event.params.seq !== session.lastSeq + 1) {
        // The transport is ordered, so a gap means a bug — surface it.
        this.send(session, INTEGRATED_TERMINAL_ERROR_CHANNEL, {
          sessionId: session.sessionId,
          message: `Remote terminal stream skipped from frame ${session.lastSeq} to ${event.params.seq}.`,
        });
      }
      session.lastSeq = event.params.seq;
      session.buffer = trimBufferedOutput(session.buffer + data);
      this.send(session, INTEGRATED_TERMINAL_OUTPUT_CHANNEL, {
        sessionId: session.sessionId,
        data,
      });
      session.consumedBytes += Buffer.byteLength(data, "utf8");
      if (session.consumedBytes >= FEDERATION_PTY_ACK_INTERVAL_BYTES) {
        const bytes = session.consumedBytes;
        session.consumedBytes = 0;
        void getDesktopFederationRuntime()
          .remotePty(session.target)
          .ack({ sessionId: session.sessionId, bytes })
          .catch((error) => {
            log.warn("remote terminal ack failed", {
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }
      return;
    }
    if (event.kind === "exit") {
      this.send(session, INTEGRATED_TERMINAL_EXIT_CHANNEL, {
        sessionId: session.sessionId,
        exitCode: event.params.exitCode ?? null,
        signal: event.params.signal ?? null,
      });
      this.dropSession(session);
      this.broadcastSessions(session.webContents);
      return;
    }
    this.send(session, INTEGRATED_TERMINAL_ERROR_CHANNEL, {
      sessionId: session.sessionId,
      message: event.params.message,
    });
  }

  private watchWebContents(webContents: WebContents): void {
    if (this.watchedWebContents.has(webContents)) return;
    this.watchedWebContents.add(webContents);
    webContents.once("destroyed", () => {
      this.watchedWebContents.delete(webContents);
      for (const [key, pending] of this.pendingOpens) {
        if (key.startsWith(`${webContents.id}:`)) {
          pending.closeRequested = true;
        }
      }
      for (const session of Array.from(this.sessionsById.values())) {
        if (session.webContents !== webContents) continue;
        this.dropSession(session);
        // Closing the remote window ends the PTY (owner applies its grace).
        void getDesktopFederationRuntime()
          .remotePty(session.target)
          .close({ sessionId: session.sessionId })
          .catch(() => {
            // Peer unreachable — the owner's disconnect reap covers it.
          });
      }
    });
  }

  private pendingKey(webContents: WebContents, threadKey: string): string {
    return `${webContents.id}:${threadKey}`;
  }

  private ownedSession(
    webContents: WebContents,
    sessionId: string,
  ): RemoteTerminalSession | undefined {
    const session = this.sessionsById.get(sessionId);
    return session && session.webContents === webContents ? session : undefined;
  }

  private sessionForThread(
    webContents: WebContents,
    threadKey: string,
  ): RemoteTerminalSession | undefined {
    return this.sessionsForWindow(webContents).find(
      (session) => session.threadKey === threadKey,
    );
  }

  private sessionsForWindow(webContents: WebContents): RemoteTerminalSession[] {
    return [...this.sessionsById.values()].filter(
      (session) => session.webContents === webContents,
    );
  }

  private dropSession(session: RemoteTerminalSession): void {
    this.sessionsById.delete(session.sessionId);
  }

  private broadcastSessions(webContents: WebContents): void {
    if (webContents.isDestroyed()) return;
    // The renderer replaces its whole session list per event, so a window
    // hosting both kinds must always see both. Federation windows never get
    // local sessions merged in (see localSessionsFor).
    const localSessions = federationWindowTargetForWebContents(webContents)
      ? []
      : this.options.localSessionsFor?.(webContents) ?? [];
    webContents.send(INTEGRATED_TERMINAL_SESSIONS_CHANNEL, {
      sessions: sortSessionsByCreatedAt([
        ...localSessions,
        ...this.listSessions(webContents),
      ]),
    });
  }

  private send(
    session: RemoteTerminalSession,
    channel: string,
    payload: unknown,
  ): void {
    if (session.webContents.isDestroyed()) return;
    session.webContents.send(channel, payload);
  }

  private sendError(session: RemoteTerminalSession, error: unknown): void {
    this.send(session, INTEGRATED_TERMINAL_ERROR_CHANNEL, {
      sessionId: session.sessionId,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  private toCreateResponse(
    session: RemoteTerminalSession,
  ): IntegratedTerminalCreateResponse {
    return {
      sessionId: session.sessionId,
      threadKey: session.threadKey,
      cwd: session.cwd,
      shell: session.shell,
      buffer: session.buffer || undefined,
    };
  }

  private toSummary(
    session: RemoteTerminalSession,
    identities: Map<string, IntegratedTerminalRemoteInfo>,
  ): IntegratedTerminalSessionSummary {
    return {
      sessionId: session.sessionId,
      threadKey: session.threadKey,
      cwd: session.cwd,
      shell: session.shell,
      panelHidden: session.panelHidden,
      createdAt: session.createdAt,
      remote: identities.get(session.target.instanceId) ?? {
        instanceId: session.target.instanceId,
        instanceLabel: session.target.instanceId,
      },
    };
  }

  /**
   * Display identity per peer that owns a live session here. Best-effort:
   * during early boot (or in harnesses) the peer store / assignment map may
   * be absent, and the raw instance id still labels the session correctly.
   */
  private remoteIdentities(): Map<string, IntegratedTerminalRemoteInfo> {
    const identities = new Map<string, IntegratedTerminalRemoteInfo>();
    const instanceIds = new Set(
      [...this.sessionsById.values()].map(
        (session) => session.target.instanceId,
      ),
    );
    if (instanceIds.size === 0) {
      return identities;
    }
    const runtime = getDesktopFederationRuntime();
    let labelByInstanceId = new Map<string, string>();
    try {
      labelByInstanceId = new Map(
        runtime
          .connectedPeerTargets()
          .map((peer) => [peer.target.instanceId, peer.label]),
      );
    } catch {
      // Keep the bare-id fallback.
    }
    for (const instanceId of instanceIds) {
      const info: IntegratedTerminalRemoteInfo = {
        instanceId,
        instanceLabel: labelByInstanceId.get(instanceId) ?? instanceId,
      };
      try {
        info.celestialIcon = runtime.celestialIconFor(instanceId);
      } catch {
        // Assignment map unavailable — the chip falls back to its glyph.
      }
      identities.set(instanceId, info);
    }
    return identities;
  }
}

/**
 * One ordering across both registries. Each side sorts its own sessions by
 * age; a merged list must too, or local and remote shells render as two
 * blocks that reshuffle as sessions come and go.
 */
export function sortSessionsByCreatedAt(
  sessions: IntegratedTerminalSessionSummary[],
): IntegratedTerminalSessionSummary[] {
  return [...sessions].sort((left, right) => left.createdAt - right.createdAt);
}

function trimBufferedOutput(value: string): string {
  if (value.length <= OUTPUT_BUFFER_LIMIT) {
    return value;
  }
  return value.slice(value.length - OUTPUT_BUFFER_LIMIT);
}
