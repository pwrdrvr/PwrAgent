import type { Socket } from "node:net";
import type { ServiceStreamClose, ServiceStreamData, ServiceStreamWindow } from "@pwragent/shared";
import { FEDERATION_SERVICE_V2_NOTIFICATIONS as FRAMES } from "@pwragent/shared";

const MiB = 1024 * 1024;
/** Largest data frame this build sends and accepts. */
export const SERVICE_STREAM_FRAME_BYTES = 64 * 1024;
/** Ceiling on a frame size a peer may ask for. */
export const SERVICE_STREAM_MAX_FRAME_BYTES = 256 * 1024;
/** Per-stream receive window: 4 MiB reaches ~20 MiB/s at 200 ms RTT. */
export const SERVICE_STREAM_WINDOW_BYTES = 4 * MiB;
/** Ceiling on the credit a peer may hold out to us at once. */
export const SERVICE_STREAM_MAX_WINDOW_BYTES = 64 * MiB;
/** Receive memory for every stream on one side: granted but not yet flushed bytes. */
export const SERVICE_STREAM_BUDGET_BYTES = 32 * MiB;
/** Send more credit once this share of the window has drained. */
const GRANT_FRACTION = 4;

/** Send one notification. A returned promise is transport backpressure. */
export type ServiceStreamSend = (method: string, params: unknown) => void | Promise<void>;

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** Strict base64 at O(1) beyond the decode: skipped characters shorten the output. */
export function decodeServiceStreamData(value: unknown, maxBytes: number): Buffer {
  if (typeof value !== "string" || value.length % 4 !== 0 || value.length > Math.ceil(maxBytes / 3) * 4) {
    throw new Error("Invalid service stream frame.");
  }
  const bytes = Buffer.from(value, "base64");
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  if (bytes.length !== (value.length / 4) * 3 - padding || bytes.length > maxBytes) {
    throw new Error("Invalid service stream frame.");
  }
  return bytes;
}

export function isServiceStreamSize(value: unknown, max: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max;
}

/**
 * Receive memory shared by every stream on one side. A stream holds what it
 * granted and has not yet flushed to its local socket. A stream that cannot
 * reach its window waits here, and waiting streams are served in turn as
 * memory frees, so a busy stream cannot take back what it just drained ahead
 * of one that is starved.
 */
export class ServiceStreamBudget {
  private used = 0;
  private readonly waiting = new Set<ServiceStreamEndpoint>();
  private serving?: ServiceStreamEndpoint;
  private refilling = false;

  constructor(readonly limit = SERVICE_STREAM_BUDGET_BYTES) {}

  get inUse(): number { return this.used; }

  /** Up to `bytes`; less, and a place in line, when memory is short or others wait. */
  take(endpoint: ServiceStreamEndpoint, bytes: number): number {
    const first = this.waiting.values().next().value;
    if (first !== undefined && first !== endpoint && this.serving !== endpoint) {
      this.waiting.add(endpoint);
      return 0;
    }
    const granted = Math.max(0, Math.min(bytes, this.limit - this.used));
    this.used += granted;
    if (granted < bytes) this.waiting.add(endpoint);
    else this.waiting.delete(endpoint);
    return granted;
  }

  give(bytes: number): void {
    this.used -= bytes;
    if (!this.waiting.size || this.refilling) return;
    this.refilling = true;
    queueMicrotask(() => {
      this.refilling = false;
      for (const endpoint of [...this.waiting]) {
        if (this.used >= this.limit) break;
        this.waiting.delete(endpoint);
        this.serving = endpoint;
        try { endpoint.grant(); } finally { this.serving = undefined; }
      }
    });
  }

  forget(endpoint: ServiceStreamEndpoint): void { this.waiting.delete(endpoint); }
}

/**
 * Sends one bounded frame per ready stream in turn and yields to the event
 * loop after each, so control traffic and other streams interleave with bulk
 * data. No timer and no rate cap: credit windows and transport backpressure
 * are the only brakes.
 */
export class ServiceStreamScheduler {
  private readonly ready: ServiceStreamEndpoint[] = [];
  private readonly queued = new Set<ServiceStreamEndpoint>();
  private running = false;

  wake(endpoint: ServiceStreamEndpoint): void {
    this.enqueue(endpoint);
    if (!this.running) void this.run();
  }

  private enqueue(endpoint: ServiceStreamEndpoint): void {
    if (this.queued.has(endpoint)) return;
    this.queued.add(endpoint);
    this.ready.push(endpoint);
  }

  private async run(): Promise<void> {
    this.running = true;
    try {
      while (this.ready.length) {
        const endpoint = this.ready.shift()!;
        this.queued.delete(endpoint);
        if (await endpoint.sendNext()) this.enqueue(endpoint);
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } finally {
      this.running = false;
    }
  }
}

export type ServiceStreamEndpointOptions = {
  streamId: string;
  /** The local half: non-flowing, read only as credit allows. */
  socket: Socket;
  scheduler: ServiceStreamScheduler;
  budget: ServiceStreamBudget;
  send: ServiceStreamSend;
  /** Target receive window. */
  window?: number;
  /** Largest frame this side sends and accepts. */
  frameBytes?: number;
  /** Throws to stop the stream, such as for a revoked lease. Runs per sent frame. */
  authorize?: () => void;
  onTransfer?: (sentBytes: number, receivedBytes: number) => void;
  onClosed?: (error?: string) => void;
};

/**
 * One side of a windowed service stream; the owner and the viewer run the
 * same code. Each direction is independent, so a blocked local write never
 * stops the other direction.
 */
export class ServiceStreamEndpoint {
  readonly streamId: string;
  /** Receive credit to advertise at open. */
  readonly initialWindow: number;
  readonly frameBytes: number;
  private readonly socket: Socket;
  private readonly window: number;
  private sendCredit = 0;
  private sendFrameBytes = 0;
  private sendSeq = 0;
  private receiveSeq = 0;
  private granted: number;
  private received = 0;
  private drained = 0;
  private started = false;
  private finSent = false;
  private remoteFin = false;
  /** The local socket closed after EOF: send FIN, then close. */
  private closeAfterFin = false;
  /** The peer closed after its FIN: flush local writes, then clean up. */
  private peerClosed = false;
  private localError?: string;
  private closed = false;

  constructor(private readonly options: ServiceStreamEndpointOptions) {
    this.streamId = options.streamId;
    this.socket = options.socket;
    this.window = options.window ?? SERVICE_STREAM_WINDOW_BYTES;
    this.frameBytes = options.frameBytes ?? SERVICE_STREAM_FRAME_BYTES;
    this.granted = options.budget.take(this, this.window);
    this.initialWindow = this.granted;
    this.socket.on("readable", this.readable);
    this.socket.on("end", this.wake);
    this.socket.on("error", this.failed);
    this.socket.on("close", this.localClosed);
  }

  /** Bytes the peer may send before we grant more. */
  get peerCredit(): number { return this.granted - this.received; }
  /** Bytes we may send before the peer grants more. */
  get credit(): number { return this.sendCredit; }
  get isClosed(): boolean { return this.closed; }

  /** Enable sending once the peer's window and frame size are known. */
  start(peerWindow: unknown, peerFrameBytes: unknown): void {
    if (this.closed) return;
    if (!isServiceStreamSize(peerWindow, SERVICE_STREAM_MAX_WINDOW_BYTES)
      || !isServiceStreamSize(peerFrameBytes, SERVICE_STREAM_MAX_FRAME_BYTES) || peerFrameBytes < 1024) {
      this.abort("Invalid service stream parameters.");
      return;
    }
    this.sendCredit = peerWindow;
    this.sendFrameBytes = Math.min(this.frameBytes, peerFrameBytes);
    this.started = true;
    this.wake();
  }

  receiveData(frame: Partial<ServiceStreamData>): void {
    if (this.closed || this.peerClosed) return;
    let bytes: Buffer;
    try {
      if (frame.seq !== this.receiveSeq || (frame.fin !== undefined && typeof frame.fin !== "boolean")) {
        throw new Error("Invalid service stream sequence.");
      }
      if (this.remoteFin) throw new Error("Service sent data after FIN.");
      bytes = decodeServiceStreamData(frame.data, this.frameBytes);
      if (bytes.length > this.peerCredit) throw new Error("Service exceeded its stream window.");
    } catch (error) {
      this.abort(message(error, "Invalid service stream frame."));
      return;
    }
    this.receiveSeq += 1;
    this.received += bytes.length;
    if (bytes.length) {
      this.options.onTransfer?.(0, bytes.length);
      if (this.socket.writable) {
        const length = bytes.length;
        this.socket.write(bytes, (error) => {
          if (this.closed) return;
          if (error) { this.abort("Service socket write failed."); return; }
          this.drained += length;
          this.options.budget.give(length);
          this.grant();
        });
      } else {
        this.drained += bytes.length;
        this.options.budget.give(bytes.length);
      }
    }
    if (frame.fin) {
      this.remoteFin = true;
      // Credit the peer can no longer use goes back to the budget.
      this.options.budget.forget(this);
      this.options.budget.give(this.granted - this.received);
      this.granted = this.received;
      if (!this.socket.writableEnded) this.socket.end();
    }
  }

  receiveWindow(frame: Partial<ServiceStreamWindow>): void {
    if (this.closed) return;
    if (!isServiceStreamSize(frame.bytes, SERVICE_STREAM_MAX_WINDOW_BYTES) || frame.bytes < 1
      || this.sendCredit + frame.bytes > SERVICE_STREAM_MAX_WINDOW_BYTES) {
      this.abort("Invalid service stream window.");
      return;
    }
    this.sendCredit += frame.bytes;
    this.wake();
  }

  receiveClose(frame: Partial<ServiceStreamClose>): void {
    if (this.closed) return;
    const error = typeof frame.error === "string" ? frame.error.slice(0, 240) : undefined;
    if (this.remoteFin && !error) {
      // The peer sent everything it had. Let our writes of it finish.
      this.peerClosed = true;
      if (this.socket.writableFinished || !this.socket.writable) this.cleanup();
      else this.socket.once("finish", () => this.cleanup());
      return;
    }
    this.cleanup(error ?? "Service stream closed by the other side.");
  }

  /** Grant more receive credit as the local socket drains. */
  grant(): void {
    if (this.closed || this.remoteFin || this.peerClosed) return;
    const deficit = this.window - (this.granted - this.drained);
    if (deficit < this.window / GRANT_FRACTION) return;
    const bytes = this.options.budget.take(this, deficit);
    if (!bytes) return;
    this.granted += bytes;
    this.notify(FRAMES.window, { streamId: this.streamId, bytes } satisfies ServiceStreamWindow);
  }

  /** Send at most one frame. Resolves whether the stream has more to send now. */
  async sendNext(): Promise<boolean> {
    if (this.closed || this.peerClosed || !this.started || this.finSent) return false;
    try { this.options.authorize?.(); }
    catch (error) { this.abort(message(error, "Service forwarding permission expired or was revoked.")); return false; }
    const take = Math.min(this.socket.readableLength, this.sendCredit, this.sendFrameBytes);
    const chunk = take > 0 ? this.socket.read(take) as Buffer | null : null;
    const bytes = chunk?.length ?? 0;
    const fin = this.socket.readableEnded && this.socket.readableLength === 0;
    if (!bytes && !fin) return false;
    this.sendCredit -= bytes;
    this.finSent = fin;
    const frame: ServiceStreamData = { streamId: this.streamId, seq: this.sendSeq, data: chunk ? chunk.toString("base64") : "" };
    if (fin) frame.fin = true;
    this.sendSeq += 1;
    try { await this.options.send(FRAMES.data, frame); }
    catch { this.cleanup("Service stream peer is unavailable."); return false; }
    if (this.closed) return false;
    if (bytes) this.options.onTransfer?.(bytes, 0);
    if (fin && this.closeAfterFin) { this.finishLocalClose(); return false; }
    return this.ready();
  }

  /**
   * Give the socket back untouched, before `start`, so another protocol can
   * carry it. Nothing has been read from it or sent to the peer.
   */
  detach(): void {
    if (this.closed || this.started) return;
    this.closed = true;
    this.options.budget.forget(this);
    this.options.budget.give(this.granted - this.drained);
    this.removeListeners();
  }

  /** Stop the stream now and tell the peer why. */
  abort(error: string): void {
    if (this.closed) return;
    this.notify(FRAMES.close, { streamId: this.streamId, error } satisfies ServiceStreamClose);
    this.cleanup(error);
  }

  private ready(): boolean {
    return !this.closed && !this.peerClosed && this.started && !this.finSent
      && ((this.socket.readableLength > 0 && this.sendCredit > 0) || this.socket.readableEnded);
  }

  /** EOF on an empty buffer emits `end` only after a read. */
  private readonly readable = (): void => {
    if (!this.closed && this.socket.readableLength === 0) this.socket.read(0);
    this.wake();
  };

  private readonly wake = (): void => {
    if (this.ready()) this.options.scheduler.wake(this);
  };

  private readonly failed = (error: Error): void => {
    this.localError ??= message(error, "Service connection failed.");
  };

  private readonly localClosed = (): void => {
    if (this.closed) return;
    if (this.peerClosed) { this.cleanup(); return; }
    if (this.localError || !this.socket.readableEnded) {
      // Only a socket error is news to this side; a dropped client is not.
      this.notify(FRAMES.close, { streamId: this.streamId, error: this.localError ?? "Service connection closed." } satisfies ServiceStreamClose);
      this.cleanup(this.localError);
      return;
    }
    // Every byte was read before EOF; only the FIN may still be queued.
    if (this.finSent) this.finishLocalClose();
    else {
      this.closeAfterFin = true;
      // Before open completes there is no FIN to order behind.
      if (this.started) this.wake();
      else {
        this.notify(FRAMES.close, { streamId: this.streamId, error: "Service connection closed." } satisfies ServiceStreamClose);
        this.cleanup();
      }
    }
  };

  private removeListeners(): void {
    this.socket.off("readable", this.readable);
    this.socket.off("end", this.wake);
    this.socket.off("error", this.failed);
    this.socket.off("close", this.localClosed);
  }

  private finishLocalClose(): void {
    this.notify(FRAMES.close, { streamId: this.streamId } satisfies ServiceStreamClose);
    this.cleanup();
  }

  private notify(method: string, params: unknown): void {
    try {
      void Promise.resolve(this.options.send(method, params)).catch(() => undefined);
    } catch { /* The peer is gone; local cleanup still runs. */ }
  }

  private cleanup(error?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.options.budget.forget(this);
    this.options.budget.give(this.granted - this.drained);
    this.removeListeners();
    this.socket.on("error", () => undefined);
    this.socket.destroy();
    this.options.onClosed?.(error);
  }
}
