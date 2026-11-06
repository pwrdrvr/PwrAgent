/**
 * When PwrAgent may start the Codex app server again after it exits on its
 * own. The client restarts lazily: the next request that needs Codex starts
 * it, after waiting out the delay this policy sets. Every start goes through
 * that one gate, so a server that dies on launch cannot be respawned faster
 * than the backoff however many callers are waiting.
 *
 * - Each consecutive exit doubles the delay from `initialDelayMs` up to
 *   `maxDelayMs`, less up to `jitterRatio` of it so windows that crashed
 *   together do not restart together.
 * - A server that stayed up for `stableUptimeMs` starts the doubling over.
 * - `breakerExitCount` exits within `breakerWindowMs` stop restarts until
 *   `reset()`. Uptime does not forgive those: a server that runs for a few
 *   minutes and then dies, over and over, is still crash-looping.
 *
 * Pure in-memory state; no timers and no SQLite writes.
 */
export type CodexAppServerRestartPolicyOptions = {
  initialDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
  breakerExitCount?: number;
  breakerWindowMs?: number;
  stableUptimeMs?: number;
  now?: () => number;
  random?: () => number;
};

export type CodexAppServerRestartDecision =
  | { kind: "restart"; attempt: number; delayMs: number }
  | { kind: "stopped"; exits: number; windowMs: number };

const DEFAULT_INITIAL_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 30_000;
const DEFAULT_JITTER_RATIO = 0.2;
const DEFAULT_BREAKER_EXIT_COUNT = 5;
const DEFAULT_BREAKER_WINDOW_MS = 10 * 60_000;
const DEFAULT_STABLE_UPTIME_MS = 2 * 60_000;

export class CodexAppServerRestartPolicy {
  private readonly initialDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly jitterRatio: number;
  private readonly breakerExitCount: number;
  private readonly breakerWindowMs: number;
  private readonly stableUptimeMs: number;
  private readonly now: () => number;
  private readonly random: () => number;
  private exitTimes: number[] = [];
  private consecutiveExits = 0;
  private startedAt?: number;
  private restartAt = 0;
  private stopped = false;

  constructor(options: CodexAppServerRestartPolicyOptions = {}) {
    this.initialDelayMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
    this.maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.jitterRatio = options.jitterRatio ?? DEFAULT_JITTER_RATIO;
    this.breakerExitCount = options.breakerExitCount ?? DEFAULT_BREAKER_EXIT_COUNT;
    this.breakerWindowMs = options.breakerWindowMs ?? DEFAULT_BREAKER_WINDOW_MS;
    this.stableUptimeMs = options.stableUptimeMs ?? DEFAULT_STABLE_UPTIME_MS;
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? (() => Math.random());
  }

  /** The server finished its handshake. */
  recordStarted(): void {
    this.startedAt = this.now();
  }

  /** The server exited without PwrAgent asking it to. */
  recordExit(): CodexAppServerRestartDecision {
    const now = this.now();
    if (this.startedAt !== undefined && now - this.startedAt >= this.stableUptimeMs) {
      this.consecutiveExits = 0;
    }
    this.startedAt = undefined;
    this.exitTimes = this.exitTimes.filter((at) => now - at < this.breakerWindowMs);
    this.exitTimes.push(now);
    if (this.exitTimes.length >= this.breakerExitCount) {
      this.stopped = true;
      return {
        kind: "stopped",
        exits: this.exitTimes.length,
        windowMs: this.breakerWindowMs,
      };
    }
    const ceiling = Math.min(
      this.maxDelayMs,
      this.initialDelayMs * 2 ** this.consecutiveExits,
    );
    const delayMs = Math.round(ceiling * (1 - this.jitterRatio * this.random()));
    this.consecutiveExits += 1;
    this.restartAt = now + delayMs;
    return { kind: "restart", attempt: this.consecutiveExits, delayMs };
  }

  remainingDelayMs(): number {
    return Math.max(0, this.restartAt - this.now());
  }

  isStopped(): boolean {
    return this.stopped;
  }

  /** The operator asked for a restart: forget the exit history. */
  reset(): void {
    this.exitTimes = [];
    this.consecutiveExits = 0;
    this.startedAt = undefined;
    this.restartAt = 0;
    this.stopped = false;
  }
}
