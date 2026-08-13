export type MessagingRateLimitBucket = {
  id: string;
  intervalMs: number;
  limit: number;
  minIntervalMs?: number;
};

export type MessagingRateLimitAdmission =
  | { admitted: true }
  | { admitted: false; retryAt: number };

type MessagingRateLimitBucketState = {
  blockedUntil: number;
  timestamps: number[];
};

/**
 * In-memory, multi-bucket rate accounting for provider-specific API lanes.
 * Providers may track independent method/workspace budgets without coupling
 * those limits to the controller's visible-message delivery budget.
 */
export class MessagingRateLimitGate {
  private readonly states = new Map<string, MessagingRateLimitBucketState>();

  constructor(private readonly now: () => number = Date.now) {}

  admit(bucket: MessagingRateLimitBucket): MessagingRateLimitAdmission {
    const now = this.now();
    const state = this.stateFor(bucket.id);
    this.prune(state, bucket, now);
    const lastTimestamp = state.timestamps.at(-1);
    const intervalReadyAt = lastTimestamp === undefined
      ? now
      : lastTimestamp + Math.max(0, bucket.minIntervalMs ?? 0);
    const windowReadyAt = state.timestamps.length < bucket.limit
      ? now
      : (state.timestamps[0] ?? now) + bucket.intervalMs;
    const retryAt = Math.max(state.blockedUntil, intervalReadyAt, windowReadyAt);
    if (retryAt > now) {
      return { admitted: false, retryAt };
    }
    state.timestamps.push(now);
    return { admitted: true };
  }

  recordRateLimit(bucketId: string, retryAfterMs: number): void {
    const state = this.stateFor(bucketId);
    state.blockedUntil = Math.max(
      state.blockedUntil,
      this.now() + Math.max(0, retryAfterMs),
    );
  }

  clear(bucketId?: string): void {
    if (bucketId === undefined) {
      this.states.clear();
      return;
    }
    this.states.delete(bucketId);
  }

  private stateFor(id: string): MessagingRateLimitBucketState {
    let state = this.states.get(id);
    if (!state) {
      state = { blockedUntil: 0, timestamps: [] };
      this.states.set(id, state);
    }
    return state;
  }

  private prune(
    state: MessagingRateLimitBucketState,
    bucket: MessagingRateLimitBucket,
    now: number,
  ): void {
    const cutoff = now - bucket.intervalMs;
    while (state.timestamps.length > 0 && (state.timestamps[0] ?? now) <= cutoff) {
      state.timestamps.shift();
    }
  }
}
