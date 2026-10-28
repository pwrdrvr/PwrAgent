/**
 * PTY sizing: one set of dimension clamps and one resize pacer, shared by the
 * local integrated-terminal service, the federation remote-PTY service, and
 * the viewer-side federation terminal bridge.
 *
 * The two owner services used to carry their own copy of these bounds —
 * identical by coincidence rather than by construction — and a size that
 * clamps one way at spawn and another way at resize makes the deduplication
 * below silently wrong, so they are defined once here.
 */

const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 18;
const MAX_COLUMNS = 500;
const MAX_ROWS = 200;
const MIN_DIMENSION = 2;

/**
 * Minimum gap between resizes applied to one PTY.
 *
 * A resize is not a frame. It raises SIGWINCH, and a full-screen application
 * answers by repainting its entire screen back up the pipe — through
 * `onData`, the session buffer, and an IPC broadcast to every viewer. The
 * renderer already coalesces to one `requestAnimationFrame`, but a terminal
 * cell is about eight pixels wide, so dragging a window 400px in a second
 * crosses ~50 column boundaries: every one of those frames carries a
 * genuinely different size and so survives deduplication.
 *
 * 50ms caps that at 20 repaints per second. Because the pacer is
 * trailing-edge, the final size of a drag still lands within 50ms of the
 * gesture ending, which is below the threshold where a delay reads as lag.
 */
export const PTY_RESIZE_INTERVAL_MS = 50;

export function clampTerminalColumns(value: number): number {
  return clampInteger(value, DEFAULT_COLUMNS, MIN_DIMENSION, MAX_COLUMNS);
}

export function clampTerminalRows(value: number): number {
  return clampInteger(value, DEFAULT_ROWS, MIN_DIMENSION, MAX_ROWS);
}

function clampInteger(
  value: number,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

type PtySize = { cols: number; rows: number };

export type PtyResizeCoalescerOptions = {
  /**
   * Applies a size to the PTY. A throw means the size was NOT applied; an
   * apply that only sends the size somewhere reports a later failure through
   * `forget` instead.
   */
  apply: (cols: number, rows: number) => void;
  /** The grid the PTY was spawned at, before clamping. */
  spawnedCols: number;
  spawnedRows: number;
  intervalMs?: number;
  now?: () => number;
  /**
   * Reports a throw from a deferred apply. A deferred resize has no caller
   * left to throw to, and an uncaught throw from a timer takes down the main
   * process.
   */
  onDeferredError?: (error: unknown) => void;
};

/**
 * Paces resizes for one PTY: drops what the shell is already running at, and
 * applies at most one size per interval, keeping the newest.
 *
 * The owner is the authority. Only it sees every viewer's stream whole, so
 * only its record means "what the PTY is running at" — a viewer's idea of
 * that is always one round trip stale, and must never be treated as the
 * shell's true size.
 *
 * A viewer may still run one of these over its own outbound requests, where
 * `applied` means "what I last sent" rather than "what the PTY is". That is a
 * claim a viewer can actually make, and it is only worth acting on while the
 * viewer is the PTY's sole writer: with a second writer, a repeat of a
 * viewer's own last size is exactly the request that takes the PTY back, and
 * dropping it would strand the shell at the other writer's size. The
 * federation terminal bridge is a sole writer, so it runs one of these and a
 * redundant fit costs no round trip; the owner clamps, deduplicates and paces
 * again on arrival regardless. A viewer's apply only sends, so its failure
 * arrives after `apply` has returned — it reports that through `forget`.
 *
 * The first request after a quiet period applies immediately, so opening a
 * pane sizes its shell at once; only a burst is paced. Whatever a burst ends
 * on is applied on the trailing edge, so the steady state is always the size
 * the viewer last asked for.
 */
export class PtyResizeCoalescer {
  private readonly apply: (cols: number, rows: number) => void;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly onDeferredError?: (error: unknown) => void;
  /**
   * What the PTY is running at — at an owner. Seeded with the spawn grid,
   * because that is what `spawnTerminalPty` already sized it to — `forkpty`
   * and `CreatePseudoConsole` both take the requested size verbatim, so this
   * is knowledge, not a guess. Unseeded, the renderer's first `fitAddon.fit()`
   * after attach — which usually proposes the spawn grid straight back — was
   * the one redundant resize that could never be caught.
   *
   * At a viewer it is only what that viewer last sent (see the class doc), and
   * `undefined` once `forget` withdrew a send that failed, so the next request
   * goes out whatever it is.
   *
   * Tracked here rather than read back off the PTY because node-pty can defer
   * a Windows resize before its own `cols` / `rows` getters change.
   */
  private applied?: PtySize;
  /** When `applied` was last written; `-Infinity` so the first one is free. */
  private appliedAt = Number.NEGATIVE_INFINITY;
  private pending?: PtySize;
  private timer?: ReturnType<typeof setTimeout>;

  private disposed = false;

  constructor(options: PtyResizeCoalescerOptions) {
    this.apply = options.apply;
    // A non-finite or negative interval would disable pacing silently, which
    // is the one failure mode this class exists to prevent.
    this.intervalMs =
      options.intervalMs !== undefined && Number.isFinite(options.intervalMs)
        ? Math.max(0, options.intervalMs)
        : PTY_RESIZE_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.onDeferredError = options.onDeferredError;
    this.applied = {
      cols: clampTerminalColumns(options.spawnedCols),
      rows: clampTerminalRows(options.spawnedRows),
    };
  }

  /**
   * Throws only when the request is applied synchronously and the PTY rejects
   * it — that throw belongs to the caller that asked. A deferred apply that
   * fails goes to `onDeferredError` instead.
   */
  request(cols: number, rows: number): void {
    // `dispose` is final. The session is dropped from its registry in the
    // same synchronous block, so nothing can reach this today — but the
    // guarantee that no resize follows teardown belongs here rather than
    // resting on that ordering.
    if (this.disposed) return;
    const next: PtySize = {
      cols: clampTerminalColumns(cols),
      rows: clampTerminalRows(rows),
    };
    if (this.matchesApplied(next)) {
      // A burst that lands back where the PTY already is leaves nothing to do,
      // so drop the queued size too rather than resizing away from the size
      // the viewer settled on.
      this.pending = undefined;
      return;
    }
    if (this.timer !== undefined) {
      this.pending = next;
      return;
    }
    const now = this.now();
    if (now - this.appliedAt >= this.intervalMs) {
      this.applyNow(next);
      return;
    }
    this.pending = next;
    this.arm(now);
  }

  /** Stops a queued resize from reaching a PTY that is being torn down. */
  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.pending = undefined;
  }

  /**
   * Withdraws a size that `apply` accepted but that failed to land after it
   * returned — a viewer's apply only sends a request, and the rejection comes
   * back later. Left recorded, it would suppress the retry that corrects it,
   * the same reason `applyNow` records nothing when `apply` throws. Takes the
   * size `apply` was called with, and leaves a newer size alone: a send that
   * has already been superseded says nothing about the one after it.
   */
  forget(cols: number, rows: number): void {
    if (this.applied?.cols === cols && this.applied.rows === rows) {
      this.applied = undefined;
    }
  }

  private matchesApplied(size: PtySize): boolean {
    return (
      this.applied !== undefined
      && size.cols === this.applied.cols
      && size.rows === this.applied.rows
    );
  }

  private arm(now: number): void {
    // Bounded by the interval at BOTH ends. `now - appliedAt` goes negative
    // whenever the wall clock steps backwards — an NTP correction, a resume
    // from sleep, an operator changing the clock — and an unbounded wait then
    // parks this PTY for the length of the jump, because every later request
    // only overwrites `pending` while a timer is armed. A one-hour step back
    // would freeze the terminal's size for an hour.
    const wait = Math.min(
      this.intervalMs,
      Math.max(0, this.intervalMs - (now - this.appliedAt)),
    );
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const next = this.pending;
      this.pending = undefined;
      if (!next || this.matchesApplied(next)) return;
      try {
        this.applyNow(next);
      } catch (error) {
        this.onDeferredError?.(error);
      }
    }, wait);
  }

  private applyNow(next: PtySize): void {
    this.apply(next.cols, next.rows);
    // Only once the apply returns. A rejected resize did not happen, and
    // recording it would suppress the retry that corrects it.
    this.applied = next;
    this.appliedAt = this.now();
  }
}
