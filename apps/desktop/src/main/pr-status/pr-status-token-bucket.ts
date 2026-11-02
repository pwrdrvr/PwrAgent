export const PR_STATUS_TOKEN_BUCKET_CAPACITY = 20;
export const PR_STATUS_TOKEN_BUCKET_REFILL_PER_MINUTE = 20;

/**
 * The shared PR request budget: scheduled lookups, by-URL fetches and agent
 * PR reads each spend one token, and tokens refill continuously up to the
 * capacity.
 */
export class PrStatusTokenBucket {
  private tokens = PR_STATUS_TOKEN_BUCKET_CAPACITY;
  private updatedAt = Date.now();

  get availableTokens(): number { return Math.floor(this.tokens); }

  /** The balance a take at `now` would see, without spending or refilling. */
  peek(now = Date.now()): number {
    return Math.floor(this.refilled(now));
  }

  tryTake(now = Date.now()): boolean {
    this.tokens = this.refilled(now);
    this.updatedAt = now;

    if (this.tokens < 1) {
      return false;
    }

    this.tokens -= 1;
    return true;
  }

  private refilled(now: number): number {
    const elapsedMs = Math.max(0, now - this.updatedAt);
    return Math.min(
      PR_STATUS_TOKEN_BUCKET_CAPACITY,
      this.tokens +
        (elapsedMs * PR_STATUS_TOKEN_BUCKET_REFILL_PER_MINUTE) / 60_000,
    );
  }
}
