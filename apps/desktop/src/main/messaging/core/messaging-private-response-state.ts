export const PRIVATE_RESPONSE_HISTORY_LIMIT = 1_000;
export const PRIVATE_RESPONSE_TEXT_LIMIT = 256;

type Lifetime = "live" | "settled";
type ResponsePhase =
  | { readonly status: "available" }
  | { readonly status: "claimed"; readonly path: "tool" | "fallback" }
  | { readonly status: "completed" }
  | { readonly status: "fallbackHeld"; readonly text?: string; readonly textOrder?: number }
  | { readonly status: "fallbackAttempted" }
  | { readonly status: "terminal" };

// Terminal means that the provider visibly delivered the private body. Later
// cancellation or continuation failures cannot undo that evidence. Completion
// means an explicit attempt settled without visible delivery; source output is
// still allowed. Available is an admitted origin with no private attempt yet.
export type PrivateResponseState = ResponsePhase & {
  readonly lifetime: Lifetime;
  readonly replyCompletion: boolean;
  readonly pending: number;
};

export type PrivateResponseEvent =
  | { readonly type: "register"; readonly fallback: boolean; readonly replyCompletion: boolean }
  | { readonly type: "hold"; readonly text: string; readonly order: number }
  | { readonly type: "claimFallback" }
  | { readonly type: "beginTool"; readonly lifetime: Lifetime }
  | { readonly type: "delivered" }
  | { readonly type: "finishTool" }
  | { readonly type: "finishFallback" }
  | { readonly type: "retire" }
  | { readonly type: "completeReply" }
  | { readonly type: "evictText" }
  | { readonly type: "evict" }
  | { readonly type: "dispose" };

export type PrivateResponseEffect = "deliverFallback" | "remove";

function withPhase(state: PrivateResponseState, phase: ResponsePhase): PrivateResponseState {
  return { lifetime: state.lifetime, replyCompletion: state.replyCompletion, pending: state.pending, ...phase };
}

export function transitionPrivateResponse(
  state: PrivateResponseState | undefined,
  event: PrivateResponseEvent,
): { readonly state: PrivateResponseState | undefined; readonly effects: readonly PrivateResponseEffect[] } {
  if (event.type === "dispose") return { state: undefined, effects: ["remove"] };
  if (event.type === "register") {
    return {
      state: state
        ? { ...state, lifetime: "live", replyCompletion: state.replyCompletion || event.replyCompletion }
        : { status: event.fallback ? "fallbackHeld" : "available", lifetime: "live", replyCompletion: event.replyCompletion, pending: 0 },
      effects: [],
    };
  }
  if (event.type === "beginTool") {
    const base = state ?? { status: "available", lifetime: event.lifetime, replyCompletion: false, pending: 0 };
    return {
      state: {
        ...withPhase(base, state?.status === "terminal" ? { status: "terminal" } : {
          status: "claimed" as const,
          path: state?.status === "claimed" ? state.path : "tool",
        }),
        pending: base.pending + 1,
      },
      effects: [],
    };
  }
  if (!state) return { state, effects: [] };
  switch (event.type) {
    case "hold":
      return { state: state.status === "fallbackHeld" ? { ...state, text: event.text, textOrder: state.textOrder ?? event.order } : state, effects: [] };
    case "claimFallback":
      return state.status === "fallbackHeld"
        ? { state: withPhase(state, { status: "claimed", path: "fallback" }), effects: ["deliverFallback"] }
        : { state, effects: [] };
    case "delivered":
      return { state: withPhase(state, { status: "terminal" }), effects: [] };
    case "finishTool": {
      const pending = Math.max(0, state.pending - 1);
      return {
        state: state.status === "claimed" && pending === 0
          ? { ...withPhase(state, { status: state.path === "fallback" ? "fallbackAttempted" : "completed" }), pending }
          : { ...state, pending },
        effects: [],
      };
    }
    case "finishFallback":
      return {
        state: state.status === "claimed" && state.path === "fallback" && state.pending === 0
          ? withPhase(state, { status: "fallbackAttempted" }) : state,
        effects: [],
      };
    case "retire":
      return { state: { ...state, lifetime: "settled", replyCompletion: false }, effects: [] };
    case "completeReply":
      return { state: { ...state, replyCompletion: false }, effects: [] };
    case "evictText":
      return { state: state.status === "fallbackHeld" ? withPhase(state, { status: "fallbackHeld" }) : state, effects: [] };
    case "evict":
      return state.lifetime === "settled" && state.pending === 0
        ? { state: undefined, effects: ["remove"] }
        : { state, effects: [] };
  }
}

export interface PrivateResponseReceipt {
  readonly key: string;
  readonly generation: object;
}

// Live origins and pending effects are never eviction candidates. Only settled
// history is bounded. A missing record cannot claim a fallback; evicting text
// drops a payload, never the turn's delivery evidence. No persistence or timers.
export class MessagingPrivateResponses {
  private readonly entries = new Map<string, { readonly generation: object; readonly state: PrivateResponseState }>();
  private disposed = false;
  private textSequence = 0;

  register(key: string, options: { fallback: boolean; replyCompletion: boolean }): void {
    this.apply(key, { type: "register", ...options });
  }

  state(key: string): PrivateResponseState | undefined {
    return this.entries.get(key)?.state;
  }

  isTerminal(key: string): boolean {
    return this.state(key)?.status === "terminal";
  }

  isFallback(key: string): boolean {
    const state = this.state(key);
    return state?.status === "fallbackHeld" || state?.status === "fallbackAttempted"
      || (state?.status === "claimed" && state.path === "fallback");
  }

  hold(key: string, text: string): void {
    this.apply(key, { type: "hold", text, order: ++this.textSequence });
    this.trim();
  }

  heldText(key: string): string | undefined {
    const state = this.state(key);
    return state?.status === "fallbackHeld" ? state.text : undefined;
  }

  claimFallback(key: string): boolean {
    return this.apply(key, { type: "claimFallback" }).includes("deliverFallback");
  }

  finishFallback(key: string): void { this.apply(key, { type: "finishFallback" }); }

  beginTool(key: string): PrivateResponseReceipt | undefined {
    this.apply(key, { type: "beginTool", lifetime: "settled" });
    const entry = this.entries.get(key);
    return entry ? { key, generation: entry.generation } : undefined;
  }

  delivered(receipt: PrivateResponseReceipt | undefined): void {
    if (this.matches(receipt)) this.apply(receipt.key, { type: "delivered" });
  }

  finishTool(receipt: PrivateResponseReceipt | undefined): void {
    if (!this.matches(receipt)) return;
    this.apply(receipt.key, { type: "finishTool" });
    this.trim();
  }

  retire(key: string): void {
    this.apply(key, { type: "retire" });
    this.trim();
  }

  completeReply(key: string): void { this.apply(key, { type: "completeReply" }); }

  dispose(): void {
    this.disposed = true;
    for (const key of this.entries.keys()) this.apply(key, { type: "dispose" });
  }

  private matches(receipt: PrivateResponseReceipt | undefined): receipt is PrivateResponseReceipt {
    return receipt !== undefined && this.entries.get(receipt.key)?.generation === receipt.generation;
  }

  private apply(key: string, event: PrivateResponseEvent): readonly PrivateResponseEffect[] {
    if (this.disposed && event.type !== "dispose") return [];
    const previous = this.entries.get(key);
    const result = transitionPrivateResponse(previous?.state, event);
    if (result.state) this.entries.set(key, { generation: previous?.generation ?? {}, state: result.state });
    else this.entries.delete(key);
    return result.effects;
  }

  private trim(): void {
    const history: string[] = [];
    const text: Array<{ key: string; order: number }> = [];
    for (const [key, { state }] of this.entries) {
      if (state.lifetime === "settled" && state.pending === 0) history.push(key);
      if (state.status === "fallbackHeld" && state.text !== undefined) text.push({ key, order: state.textOrder! });
    }
    for (const key of history.slice(0, Math.max(0, history.length - PRIVATE_RESPONSE_HISTORY_LIMIT))) this.apply(key, { type: "evict" });
    text.sort((a, b) => a.order - b.order);
    for (const { key } of text.slice(0, Math.max(0, text.length - PRIVATE_RESPONSE_TEXT_LIMIT))) this.apply(key, { type: "evictText" });
  }
}
