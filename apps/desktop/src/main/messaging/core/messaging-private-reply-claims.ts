const PRIVATE_REPLY_HISTORY_LIMIT = 1_000;

export type PrivateReplyClaimState = "claimed" | "completed";
export type PrivateReplyClaimEvent = "claim" | "complete" | "release" | "evict" | "dispose";

export function transitionPrivateReplyClaim(state: PrivateReplyClaimState | undefined, event: PrivateReplyClaimEvent): PrivateReplyClaimState | undefined {
  switch (event) {
    case "claim": return state ?? "claimed";
    case "complete": return state === "claimed" ? "completed" : state;
    case "release": return state === "claimed" ? undefined : state;
    case "evict": return state === "completed" ? undefined : state;
    case "dispose": return undefined;
  }
}

export interface PrivateReplyClaimReceipt {
  readonly requestId: string;
  readonly generation: object;
}

// Continuation request IDs are not turn IDs. A reply and Cancel contend for
// one request receipt before their first await. Eviction cannot free a live
// claim; a failed append/revoke releases only the receipt that made the claim.
export class MessagingPrivateReplyClaims {
  private readonly entries = new Map<string, { readonly generation: object; readonly state: PrivateReplyClaimState }>();
  private disposed = false;

  has(requestId: string): boolean { return this.entries.has(requestId); }

  claim(requestId: string): PrivateReplyClaimReceipt | undefined {
    if (this.disposed || this.has(requestId)) return undefined;
    const generation = {};
    this.entries.set(requestId, { generation, state: transitionPrivateReplyClaim(undefined, "claim")! });
    return { requestId, generation };
  }

  complete(receipt: PrivateReplyClaimReceipt): void {
    this.apply(receipt, "complete");
    const completed = [...this.entries].filter(([, entry]) => entry.state === "completed");
    for (const [requestId, entry] of completed.slice(0, Math.max(0, completed.length - PRIVATE_REPLY_HISTORY_LIMIT))) {
      this.apply({ requestId, generation: entry.generation }, "evict");
    }
  }

  release(receipt: PrivateReplyClaimReceipt): void { this.apply(receipt, "release"); }

  dispose(): void {
    this.disposed = true;
    for (const [requestId, entry] of this.entries) this.apply({ requestId, generation: entry.generation }, "dispose");
  }

  private apply(receipt: PrivateReplyClaimReceipt, event: PrivateReplyClaimEvent): void {
    const entry = this.entries.get(receipt.requestId);
    if (entry?.generation !== receipt.generation) return;
    const state = transitionPrivateReplyClaim(entry.state, event);
    if (state) this.entries.set(receipt.requestId, { ...entry, state });
    else this.entries.delete(receipt.requestId);
  }
}
