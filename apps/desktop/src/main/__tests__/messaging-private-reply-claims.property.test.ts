import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { MessagingPrivateReplyClaims, transitionPrivateReplyClaim, type PrivateReplyClaimReceipt } from "../messaging/core/messaging-private-reply-claims";

describe("private reply request claims", () => {
  it("admits one reply or cancellation until failure releases its own receipt", () => {
    fc.assert(fc.property(fc.array(fc.tuple(fc.integer({ min: 0, max: 2 }), fc.constantFrom("claim", "complete", "release", "stale")), { maxLength: 40, size: "max" }), commands => {
      const owner = new MessagingPrivateReplyClaims();
      const pending = new Map<number, PrivateReplyClaimReceipt>();
      const completed = new Set<number>();
      const stale: PrivateReplyClaimReceipt[] = [];
      for (const [id, operation] of commands) {
        const receipt = pending.get(id);
        if (operation === "claim") {
          const actual = owner.claim(String(id));
          expect(Boolean(actual)).toBe(!receipt && !completed.has(id));
          if (actual) pending.set(id, actual);
        } else if (operation === "complete" && receipt) {
          owner.complete(receipt);
          pending.delete(id);
          completed.add(id);
          stale.push(receipt);
        } else if (operation === "release" && receipt) {
          owner.release(receipt);
          pending.delete(id);
          stale.push(receipt);
        } else if (operation === "stale") {
          for (const old of stale) owner.release(old);
        }
        for (let key = 0; key < 3; key += 1) expect(owner.has(String(key))).toBe(pending.has(key) || completed.has(key));
      }
      owner.dispose();
      for (const old of pending.values()) owner.complete(old);
      expect(owner.claim("after-shutdown")).toBeUndefined();
      for (let key = 0; key < 3; key += 1) expect(owner.has(String(key))).toBe(false);
    }));
  });

  it("does not evict a pending reply when 1,001 other requests complete", () => {
    expect(transitionPrivateReplyClaim("claimed", "evict")).toBe("claimed");
    const owner = new MessagingPrivateReplyClaims();
    const old = owner.claim("old-pending")!;
    for (let n = 0; n < 1_001; n += 1) owner.complete(owner.claim(`request-${n}`)!);
    expect(owner.has("request-0")).toBe(false);
    expect(owner.has("request-1")).toBe(true);
    expect(owner.claim("old-pending")).toBeUndefined();
    owner.release(old);
    const retry = owner.claim("old-pending");
    expect(retry).toBeDefined();
    owner.complete(old); // Stale completion cannot complete the retry.
    owner.release(retry!);
    expect(owner.has("old-pending")).toBe(false);
  });
});
