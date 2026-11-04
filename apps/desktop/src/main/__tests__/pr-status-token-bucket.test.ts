import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PR_STATUS_TOKEN_BUCKET_CAPACITY,
  PR_STATUS_TOKEN_BUCKET_REFILL_PER_MINUTE,
  PrStatusTokenBucket,
} from "../pr-status/pr-status-token-bucket";

const START = 1_000_000;
const MS_PER_TOKEN = 60_000 / PR_STATUS_TOKEN_BUCKET_REFILL_PER_MINUTE;

describe("PR status token bucket", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("admits a full burst, then refuses until a token refills", () => {
    const bucket = new PrStatusTokenBucket();
    for (let index = 0; index < PR_STATUS_TOKEN_BUCKET_CAPACITY; index += 1) {
      expect(bucket.tryTake(START)).toBe(true);
    }
    expect(bucket.tryTake(START)).toBe(false);
    expect(bucket.availableTokens).toBe(0);

    expect(bucket.tryTake(START + MS_PER_TOKEN - 1)).toBe(false);
    expect(bucket.tryTake(START + MS_PER_TOKEN)).toBe(true);
  });

  it("peeks at the refilled balance without spending it", () => {
    const bucket = new PrStatusTokenBucket();
    for (let index = 0; index < PR_STATUS_TOKEN_BUCKET_CAPACITY; index += 1) {
      bucket.tryTake(START);
    }
    expect(bucket.peek(START + 3 * MS_PER_TOKEN)).toBe(3);
    expect(bucket.peek(START + 3 * MS_PER_TOKEN)).toBe(3);
    expect(bucket.availableTokens).toBe(0);
  });

  it("never refills past its capacity", () => {
    const bucket = new PrStatusTokenBucket();
    bucket.tryTake(START);
    expect(bucket.peek(START + 60 * 60_000)).toBe(PR_STATUS_TOKEN_BUCKET_CAPACITY);
  });

  it("does not refill when the clock moves backward", () => {
    const bucket = new PrStatusTokenBucket();
    for (let index = 0; index < PR_STATUS_TOKEN_BUCKET_CAPACITY; index += 1) {
      bucket.tryTake(START);
    }
    expect(bucket.tryTake(START - 60_000)).toBe(false);
  });
});
