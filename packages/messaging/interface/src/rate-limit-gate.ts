export type MessagingRateLimitBucket = {
  id: string;
  intervalMs: number;
  limit: number;
  minIntervalMs?: number;
};

export type MessagingRateLimitAdmission =
  | { admitted: true }
  | { admitted: false; retryAt: number };

/** A provider-recorded Retry-After that has not yet expired. */
export type MessagingRateLimitBlock = {
  id: string;
  blockedUntil: number;
};

/**
 * Provider throttle state an adapter hands to the adapter that replaces it.
 * The runtime keeps this in memory across an adapter restart, so a provider
 * that is still limiting the bot is not sent to early by the new instance.
 */
export type MessagingRateLimitCarryover = {
  blocks: readonly MessagingRateLimitBlock[];
};

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

  /** Every Retry-After block that has not yet expired. */
  activeBlocks(): MessagingRateLimitBlock[] {
    const now = this.now();
    const blocks: MessagingRateLimitBlock[] = [];
    for (const [id, state] of this.states) {
      if (state.blockedUntil > now) {
        blocks.push({ id, blockedUntil: state.blockedUntil });
      }
    }
    return blocks;
  }

  /**
   * Adopt blocks from an earlier gate. A restored block never shortens a
   * longer one this gate already holds.
   */
  restoreBlocks(blocks: readonly MessagingRateLimitBlock[]): void {
    for (const block of blocks) {
      if (!Number.isFinite(block.blockedUntil)) continue;
      const state = this.stateFor(block.id);
      state.blockedUntil = Math.max(state.blockedUntil, block.blockedUntil);
    }
  }

  /**
   * Fold one bucket into another, keeping the later block and every admitted
   * timestamp. Used when a provider learns the real id of a bucket it had to
   * key by a fallback.
   */
  moveBucket(fromId: string, toId: string): void {
    if (fromId === toId) return;
    const from = this.states.get(fromId);
    if (!from) return;
    this.states.delete(fromId);
    const to = this.stateFor(toId);
    to.blockedUntil = Math.max(to.blockedUntil, from.blockedUntil);
    to.timestamps = [...to.timestamps, ...from.timestamps].sort((a, b) => a - b);
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
