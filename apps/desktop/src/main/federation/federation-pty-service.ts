import { randomUUID } from "node:crypto";
import type {
  AppServerBackendKind,
  FederationCapability,
  FederationInstanceId,
  FederationRequestEnvelope,
} from "@pwragent/shared";
import type { FederationRouter } from "./federation-router";
import type { FederationRpcEndpoint } from "./federation-rpc";

/**
 * Remote PTY protocol for federated threads.
 *
 * Control plane (viewer → owner, capability-checked RPC requests):
 * `pty.open` / `pty.input` / `pty.resize` / `pty.ack` / `pty.close`.
 * Stream plane (owner → viewer, notifications): `pty.output` / `pty.exit` /
 * `pty.error`. Sessions are point-to-point with the owning instance — the
 * stream is never relayed through a gateway, and only the opener peer may
 * write input to or close a session.
 *
 * This module must stay importable outside Electron (no settings singleton,
 * no electron imports): the in-process E2E federation gateway harness runs the
 * owner service inside the Playwright test process.
 */

export const FEDERATION_PTY_METHODS = {
  open: "pty.open",
  input: "pty.input",
  resize: "pty.resize",
  ack: "pty.ack",
  close: "pty.close",
} as const;

export type FederationPtyMethod =
  (typeof FEDERATION_PTY_METHODS)[keyof typeof FEDERATION_PTY_METHODS];

export const FEDERATION_PTY_OUTPUT_METHOD = "pty.output";
export const FEDERATION_PTY_EXIT_METHOD = "pty.exit";
export const FEDERATION_PTY_ERROR_METHOD = "pty.error";

/** Every control method requires the dedicated capability — a direct shell
 *  stays revocable independently of `turn_control`. */
export const FEDERATION_PTY_METHOD_CAPABILITIES: Record<
  FederationPtyMethod,
  FederationCapability
> = {
  [FEDERATION_PTY_METHODS.open]: "remote_pty",
  [FEDERATION_PTY_METHODS.input]: "remote_pty",
  [FEDERATION_PTY_METHODS.resize]: "remote_pty",
  [FEDERATION_PTY_METHODS.ack]: "remote_pty",
  [FEDERATION_PTY_METHODS.close]: "remote_pty",
};

/** Output chunks are capped so a burst can't monopolize the shared socket. */
export const FEDERATION_PTY_OUTPUT_CHUNK_CHARS = 32 * 1024;
/** Unacked output bytes at which the owner pauses the PTY. */
export const FEDERATION_PTY_HIGH_WATER_BYTES = 1024 * 1024;
/** Unacked output bytes below which a paused PTY resumes. */
export const FEDERATION_PTY_LOW_WATER_BYTES = 256 * 1024;
/** The viewer acknowledges consumed output at this interval. */
export const FEDERATION_PTY_ACK_INTERVAL_BYTES = 256 * 1024;
/** Sessions survive a close/disconnect this long before the PTY is killed. */
export const FEDERATION_PTY_REAP_GRACE_MS = 10_000;
/** Ceiling on live + spawning sessions per peer. Well above anything the one
 *  pane-per-thread UI can produce; purely a runaway/abuse backstop. */
export const FEDERATION_PTY_MAX_SESSIONS_PER_PEER = 16;
/**
 * How long a session may sit paused at the high-water mark with no ack
 * before the peer is presumed dead and the session reaps. This is the
 * ssh ClientAlive analogue for the one link-failure mode the transport
 * cannot observe: a silently dropped connection (sleep, NAT timeout,
 * power loss) never fires a disconnect, so without this the shell would
 * park paused forever. A live viewer acks within a round trip; one that
 * takes a minute to drain 768 KiB is gone.
 */
export const FEDERATION_PTY_PAUSED_ACK_TIMEOUT_MS = 60_000;

export type FederationPtyOpenRequest = {
  backend: AppServerBackendKind;
  threadId: string;
  cols: number;
  rows: number;
};

export type FederationPtyOpenResponse = {
  sessionId: string;
  cwd: string;
  shell: string;
};

export type FederationPtyInputRequest = {
  sessionId: string;
  dataBase64: string;
};

export type FederationPtyResizeRequest = {
  sessionId: string;
  cols: number;
  rows: number;
};

export type FederationPtyAckRequest = {
  sessionId: string;
  bytes: number;
};

export type FederationPtyCloseRequest = {
  sessionId: string;
};

export type FederationPtyOutputParams = {
  sessionId: string;
  /** Gapless per-session counter. The transport is ordered, so a gap on the
   *  viewer means a bug — surfaced, never silently repaired. */
  seq: number;
  dataBase64: string;
};

export type FederationPtyExitParams = {
  sessionId: string;
  exitCode: number | null;
  signal?: number | string | null;
};

export type FederationPtyErrorParams = {
  sessionId: string;
  message: string;
};

/** Owner → viewer stream event, dispatched by the runtime on the viewer. */
export type FederationPtyStreamEvent =
  | { kind: "output"; peerId: FederationInstanceId; params: FederationPtyOutputParams }
  | { kind: "exit"; peerId: FederationInstanceId; params: FederationPtyExitParams }
  | { kind: "error"; peerId: FederationInstanceId; params: FederationPtyErrorParams };

/** The slice of node-pty's IPty the owner service needs; narrow so unit tests
 *  and the E2E harness can substitute fakes. */
export type FederationPtyProcess = {
  pid?: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  pause(): void;
  resume(): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(
    listener: (event: { exitCode: number; signal?: number }) => void,
  ): { dispose(): void };
};

export type FederationPtySpawn = (params: {
  cwd?: string;
  cols: number;
  rows: number;
}) => Promise<{
  pty: FederationPtyProcess;
  cwd: string;
  shell: { file: string; args: string[] };
}>;

export type FederationPtyAuditEntry = {
  peerId: FederationInstanceId;
  kind: "remote_pty_open" | "remote_pty_close";
  sessionId: string;
  detail: string;
};

type FederationPtyServiceOptions = {
  /** Spawns the shell. The desktop runtime passes the shared
   *  integrated-terminal spawn core; harnesses inject their own. */
  spawnPty: FederationPtySpawn;
  /** Owner-side cwd resolution from the owner's OWN thread state. The viewer
   *  never sends a path or shell. */
  resolveThreadCwd: (params: {
    backend: AppServerBackendKind;
    threadId: string;
  }) => Promise<string | undefined>;
  /** Direct-to-peer notification send. MUST NOT fall back to gateway relay —
   *  returns false when the peer has no direct connection. */
  sendNotification: (
    peerId: FederationInstanceId,
    method: string,
    params: unknown,
  ) => boolean;
  onAudit?: (entry: FederationPtyAuditEntry) => void;
  log?: {
    info: (message: string, meta?: Record<string, unknown>) => void;
    warn: (message: string, meta?: Record<string, unknown>) => void;
  };
  graceMs?: number;
  pausedAckTimeoutMs?: number;
  now?: () => number;
};

type FederationPtySession = {
  sessionId: string;
  peerId: FederationInstanceId;
  backend: AppServerBackendKind;
  threadId: string;
  cwd: string;
  shell: string;
  pty: FederationPtyProcess;
  seq: number;
  unackedBytes: number;
  paused: boolean;
  disposables: { dispose(): void }[];
  reapTimer?: ReturnType<typeof setTimeout>;
  reapReason?: "close" | "disconnect";
  /** Armed while paused at the high-water mark; an ack re-arms or clears it. */
  ackWatchdog?: ReturnType<typeof setTimeout>;
};

const MIN_DIMENSION = 2;
const MAX_PTY_COLUMNS = 500;
const MAX_PTY_ROWS = 200;

function clampDimension(value: number, fallback: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(MIN_DIMENSION, Math.round(value)));
}

/**
 * Owner-side remote PTY sessions. Wraps the shared integrated-terminal spawn
 * core (injected as `spawnPty`) with per-peer session keying, ack-window flow
 * control, and grace-period reaping.
 */
export class FederationPtyService {
  private readonly sessionsById = new Map<string, FederationPtySession>();
  /** Bumped per peer on disconnect so an in-flight spawn can detect that its
   *  requester went away and kill the shell instead of leaking it. */
  private readonly peerEpochs = new Map<FederationInstanceId, number>();
  /** Spawns that have not registered a session yet, counted toward the
   *  per-peer cap so concurrent opens cannot slip past it. */
  private readonly spawningCountByPeer = new Map<FederationInstanceId, number>();
  private disposed = false;

  constructor(private readonly options: FederationPtyServiceOptions) {}

  async open(
    peerId: FederationInstanceId,
    request: FederationPtyOpenRequest,
  ): Promise<FederationPtyOpenResponse> {
    if (this.disposed) {
      throw new Error("Remote terminal service is shutting down.");
    }
    const threadId = typeof request.threadId === "string" ? request.threadId.trim() : "";
    if (!threadId) {
      throw new Error("A thread id is required to open a remote terminal.");
    }
    if (
      this.sessionCountForPeer(peerId)
        + (this.spawningCountByPeer.get(peerId) ?? 0)
      >= FEDERATION_PTY_MAX_SESSIONS_PER_PEER
    ) {
      throw new Error("Remote terminal session limit reached for this peer.");
    }
    const epoch = this.peerEpochs.get(peerId) ?? 0;
    this.spawningCountByPeer.set(
      peerId,
      (this.spawningCountByPeer.get(peerId) ?? 0) + 1,
    );
    let spawned;
    try {
      const cwd = await this.options.resolveThreadCwd({
        backend: request.backend,
        threadId,
      });
      spawned = await this.options.spawnPty({
        cwd,
        cols: clampDimension(request.cols, 80, MAX_PTY_COLUMNS),
        rows: clampDimension(request.rows, 18, MAX_PTY_ROWS),
      });
    } finally {
      const remaining = (this.spawningCountByPeer.get(peerId) ?? 1) - 1;
      if (remaining > 0) {
        this.spawningCountByPeer.set(peerId, remaining);
      } else {
        this.spawningCountByPeer.delete(peerId);
      }
    }
    // The requester disconnected (or the service shut down) while the shell
    // was spawning: nobody can ever learn this sessionId, so a live shell
    // here is a leak, not a session.
    if (this.disposed || (this.peerEpochs.get(peerId) ?? 0) !== epoch) {
      try {
        spawned.pty.kill();
      } catch (error) {
        this.options.log?.warn("remote pty abort-kill failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      throw new Error("Federation peer disconnected while the terminal was starting.");
    }
    const session: FederationPtySession = {
      sessionId: randomUUID(),
      peerId,
      backend: request.backend,
      threadId,
      cwd: spawned.cwd,
      shell: spawned.shell.file,
      pty: spawned.pty,
      seq: 0,
      unackedBytes: 0,
      paused: false,
      disposables: [],
    };
    this.sessionsById.set(session.sessionId, session);
    session.disposables.push(
      spawned.pty.onData((data) => this.handleOutput(session, data)),
      spawned.pty.onExit((event) =>
        this.handleExit(session, event.exitCode, event.signal),
      ),
    );
    this.options.log?.info("remote pty opened", {
      peerId,
      pid: spawned.pty.pid,
      sessionId: session.sessionId,
      threadId,
    });
    this.options.onAudit?.({
      peerId,
      kind: "remote_pty_open",
      sessionId: session.sessionId,
      detail: `${request.backend}:${threadId}`,
    });
    return {
      sessionId: session.sessionId,
      cwd: session.cwd,
      shell: session.shell,
    };
  }

  input(peerId: FederationInstanceId, request: FederationPtyInputRequest): void {
    const session = this.requireSession(peerId, request.sessionId);
    session.pty.write(Buffer.from(request.dataBase64, "base64").toString("utf8"));
  }

  resize(peerId: FederationInstanceId, request: FederationPtyResizeRequest): void {
    const session = this.requireSession(peerId, request.sessionId);
    session.pty.resize(
      clampDimension(request.cols, 80, MAX_PTY_COLUMNS),
      clampDimension(request.rows, 18, MAX_PTY_ROWS),
    );
  }

  ack(peerId: FederationInstanceId, request: FederationPtyAckRequest): void {
    const session = this.requireSession(peerId, request.sessionId);
    const bytes = Number.isFinite(request.bytes) ? Math.max(0, request.bytes) : 0;
    session.unackedBytes = Math.max(0, session.unackedBytes - bytes);
    if (session.paused && session.unackedBytes <= FEDERATION_PTY_LOW_WATER_BYTES) {
      session.paused = false;
      session.pty.resume();
    }
    // Any ack proves the peer is alive and draining: clear the dead-peer
    // watchdog, re-arming it only if the session is still parked.
    this.clearAckWatchdog(session);
    if (session.paused) {
      this.armAckWatchdog(session);
    }
  }

  close(peerId: FederationInstanceId, request: FederationPtyCloseRequest): void {
    const session = this.requireSession(peerId, request.sessionId);
    this.scheduleReap(session, "close");
  }

  /** Live session count for a peer (diagnostics/tests). */
  sessionCountForPeer(peerId: FederationInstanceId): number {
    let count = 0;
    for (const session of this.sessionsById.values()) {
      if (session.peerId === peerId) count += 1;
    }
    return count;
  }

  notifyPeerDisconnected(peerId: FederationInstanceId): void {
    this.peerEpochs.set(peerId, (this.peerEpochs.get(peerId) ?? 0) + 1);
    for (const session of this.sessionsById.values()) {
      if (session.peerId === peerId) {
        this.scheduleReap(session, "disconnect");
      }
    }
  }

  notifyPeerConnected(peerId: FederationInstanceId): void {
    for (const session of this.sessionsById.values()) {
      if (
        session.peerId === peerId &&
        session.reapTimer &&
        session.reapReason === "disconnect"
      ) {
        // A transport blip healed inside the grace window: the viewer's
        // renderer still holds this sessionId and resumes on it directly.
        clearTimeout(session.reapTimer);
        session.reapTimer = undefined;
        session.reapReason = undefined;
      }
    }
  }

  /** Owner shutdown: kill every remote session immediately. */
  disposeAll(): void {
    this.disposed = true;
    for (const session of Array.from(this.sessionsById.values())) {
      this.killSession(session, "owner_shutdown");
    }
  }

  private requireSession(
    peerId: FederationInstanceId,
    sessionId: string,
  ): FederationPtySession {
    const session = this.sessionsById.get(sessionId);
    // One message for "unknown" and "not yours": a peer probing session ids
    // learns nothing about sessions it does not own.
    if (!session || session.peerId !== peerId) {
      throw new Error("Remote terminal session not found for this peer.");
    }
    return session;
  }

  private scheduleReap(
    session: FederationPtySession,
    reason: "close" | "disconnect",
  ): void {
    if (session.reapTimer) {
      // An explicit close outranks a disconnect reap; never downgrade.
      if (session.reapReason === "close" || reason === "disconnect") {
        return;
      }
      clearTimeout(session.reapTimer);
    }
    session.reapReason = reason;
    const timer = setTimeout(() => {
      session.reapTimer = undefined;
      this.killSession(session, reason);
    }, this.options.graceMs ?? FEDERATION_PTY_REAP_GRACE_MS);
    if (timer.unref) timer.unref();
    session.reapTimer = timer;
  }

  private handleOutput(session: FederationPtySession, data: string): void {
    if (this.sessionsById.get(session.sessionId) !== session) return;
    // Chunk on character boundaries (never mid-code-point) but meter flow
    // control in transported bytes, matching the viewer's ack accounting.
    for (
      let offset = 0;
      offset < data.length;
      offset += FEDERATION_PTY_OUTPUT_CHUNK_CHARS
    ) {
      const chunk = data.slice(offset, offset + FEDERATION_PTY_OUTPUT_CHUNK_CHARS);
      const bytes = Buffer.from(chunk, "utf8");
      session.seq += 1;
      session.unackedBytes += bytes.length;
      // A false return means the peer link is down: the frame is lost (the
      // viewer surfaces the seq gap on resume, we never repair it) and the
      // disconnect reap owns cleanup. Unacked bytes still accrue, which is
      // exactly what parks the PTY at the high-water mark instead of letting
      // it burn CPU into a dead link.
      this.options.sendNotification(
        session.peerId,
        FEDERATION_PTY_OUTPUT_METHOD,
        {
          sessionId: session.sessionId,
          seq: session.seq,
          dataBase64: bytes.toString("base64"),
        } satisfies FederationPtyOutputParams,
      );
    }
    if (
      !session.paused &&
      session.unackedBytes >= FEDERATION_PTY_HIGH_WATER_BYTES
    ) {
      session.paused = true;
      session.pty.pause();
      this.armAckWatchdog(session);
    }
  }

  private armAckWatchdog(session: FederationPtySession): void {
    if (session.ackWatchdog) return;
    const timer = setTimeout(() => {
      session.ackWatchdog = undefined;
      // Still paused with a full window and not one ack in the whole
      // timeout: the peer's link died without a disconnect event. Reap so
      // the shell cannot sit orphaned forever (the transport never observes
      // this failure mode — this is the ssh ClientAlive analogue).
      this.killSession(session, "ack_timeout");
    }, this.options.pausedAckTimeoutMs ?? FEDERATION_PTY_PAUSED_ACK_TIMEOUT_MS);
    if (timer.unref) timer.unref();
    session.ackWatchdog = timer;
  }

  private clearAckWatchdog(session: FederationPtySession): void {
    if (session.ackWatchdog) {
      clearTimeout(session.ackWatchdog);
      session.ackWatchdog = undefined;
    }
  }

  private handleExit(
    session: FederationPtySession,
    exitCode: number | undefined,
    signal: number | undefined,
  ): void {
    if (this.sessionsById.get(session.sessionId) !== session) return;
    this.options.sendNotification(session.peerId, FEDERATION_PTY_EXIT_METHOD, {
      sessionId: session.sessionId,
      exitCode: exitCode ?? null,
      signal: signal ?? null,
    } satisfies FederationPtyExitParams);
    this.deleteSession(session, "exit");
  }

  private killSession(session: FederationPtySession, reason: string): void {
    if (this.sessionsById.get(session.sessionId) !== session) return;
    // Best-effort exit frame first: a still-connected viewer (reconnected
    // inside the grace, or an ack-timeout on a wedged-but-live link) should
    // see its pane end rather than a stale prompt. Returns false harmlessly
    // when the peer is truly gone.
    this.options.sendNotification(session.peerId, FEDERATION_PTY_EXIT_METHOD, {
      sessionId: session.sessionId,
      exitCode: null,
      signal: null,
    } satisfies FederationPtyExitParams);
    // Drop the session first so the kill's own exit event can't re-notify.
    this.deleteSession(session, reason);
    try {
      session.pty.kill();
    } catch (error) {
      this.options.log?.warn("remote pty kill failed", {
        error: error instanceof Error ? error.message : String(error),
        sessionId: session.sessionId,
      });
      this.options.sendNotification(session.peerId, FEDERATION_PTY_ERROR_METHOD, {
        sessionId: session.sessionId,
        message: error instanceof Error ? error.message : String(error),
      } satisfies FederationPtyErrorParams);
    }
  }

  private deleteSession(session: FederationPtySession, reason: string): void {
    if (session.reapTimer) {
      clearTimeout(session.reapTimer);
      session.reapTimer = undefined;
    }
    this.clearAckWatchdog(session);
    for (const disposable of session.disposables.splice(0)) {
      try {
        disposable.dispose();
      } catch (error) {
        this.options.log?.warn("remote pty listener dispose failed", {
          error: error instanceof Error ? error.message : String(error),
          sessionId: session.sessionId,
        });
      }
    }
    this.sessionsById.delete(session.sessionId);
    this.options.log?.info("remote pty closed", {
      peerId: session.peerId,
      reason,
      sessionId: session.sessionId,
    });
    this.options.onAudit?.({
      peerId: session.peerId,
      kind: "remote_pty_close",
      sessionId: session.sessionId,
      detail: reason,
    });
  }
}

/**
 * Register the owner-side control handlers. The stream is point-to-point:
 * a request that reached this instance through a gateway relay (its
 * authenticated source peer differs from the envelope's origin) is rejected
 * outright rather than opening a session whose output could never be
 * delivered without relaying.
 */
export function registerFederationPtyHandlers(params: {
  router: FederationRouter;
  service: FederationPtyService;
}): void {
  const direct = (
    envelope: FederationRequestEnvelope,
    sourcePeerId: FederationInstanceId | undefined,
  ): FederationInstanceId => {
    if (!sourcePeerId || sourcePeerId !== envelope.sourceInstanceId) {
      throw new Error(
        "Remote terminal sessions are point-to-point; gateway relay is not supported.",
      );
    }
    return sourcePeerId;
  };
  params.router.registerHandler(
    FEDERATION_PTY_METHODS.open,
    async (envelope, sourcePeerId) =>
      await params.service.open(
        direct(envelope, sourcePeerId),
        envelope.params as FederationPtyOpenRequest,
      ),
  );
  params.router.registerHandler(
    FEDERATION_PTY_METHODS.input,
    (envelope, sourcePeerId) => {
      params.service.input(
        direct(envelope, sourcePeerId),
        envelope.params as FederationPtyInputRequest,
      );
      return {};
    },
  );
  params.router.registerHandler(
    FEDERATION_PTY_METHODS.resize,
    (envelope, sourcePeerId) => {
      params.service.resize(
        direct(envelope, sourcePeerId),
        envelope.params as FederationPtyResizeRequest,
      );
      return {};
    },
  );
  params.router.registerHandler(
    FEDERATION_PTY_METHODS.ack,
    (envelope, sourcePeerId) => {
      params.service.ack(
        direct(envelope, sourcePeerId),
        envelope.params as FederationPtyAckRequest,
      );
      return {};
    },
  );
  params.router.registerHandler(
    FEDERATION_PTY_METHODS.close,
    (envelope, sourcePeerId) => {
      params.service.close(
        direct(envelope, sourcePeerId),
        envelope.params as FederationPtyCloseRequest,
      );
      return {};
    },
  );
}

export type FederationRemotePtyOperations = {
  open(request: FederationPtyOpenRequest): Promise<FederationPtyOpenResponse>;
  input(request: FederationPtyInputRequest): Promise<void>;
  resize(request: FederationPtyResizeRequest): Promise<void>;
  ack(request: FederationPtyAckRequest): Promise<void>;
  close(request: FederationPtyCloseRequest): Promise<void>;
};

/** Viewer-side control client over the peer's RPC endpoint. */
export class FederationRemotePtyClient implements FederationRemotePtyOperations {
  constructor(private readonly rpc: FederationRpcEndpoint) {}

  async open(request: FederationPtyOpenRequest): Promise<FederationPtyOpenResponse> {
    return await this.rpc.request<FederationPtyOpenResponse>({
      method: FEDERATION_PTY_METHODS.open,
      params: request,
    });
  }

  async input(request: FederationPtyInputRequest): Promise<void> {
    await this.rpc.request({
      method: FEDERATION_PTY_METHODS.input,
      params: request,
    });
  }

  async resize(request: FederationPtyResizeRequest): Promise<void> {
    await this.rpc.request({
      method: FEDERATION_PTY_METHODS.resize,
      params: request,
    });
  }

  async ack(request: FederationPtyAckRequest): Promise<void> {
    await this.rpc.request({
      method: FEDERATION_PTY_METHODS.ack,
      params: request,
    });
  }

  async close(request: FederationPtyCloseRequest): Promise<void> {
    await this.rpc.request({
      method: FEDERATION_PTY_METHODS.close,
      params: request,
    });
  }
}

export function isFederationPtyStreamMethod(method: string): boolean {
  return (
    method === FEDERATION_PTY_OUTPUT_METHOD ||
    method === FEDERATION_PTY_EXIT_METHOD ||
    method === FEDERATION_PTY_ERROR_METHOD
  );
}
