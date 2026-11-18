import { randomUUID } from "node:crypto";
import type { AppServerTurnInputItem, MessagingCausalSourceRef } from "@pwragent/shared";
import type { MessagingBindingRecord, MessagingInboundEvent, MessagingSurfaceRef } from "@pwragent/messaging-interface";
import type { PendingPdfAttachment } from "../../pdf/pdf-attachment-store";

// Presentation metadata for an owner's queue entry, or input whose owner
// cancellation succeeded but whose steer and replacement admission failed.
// Neither kind admits or orders work. Only the owner's ThreadTurnQueue does.
export type MessagingQueuedTurnEntry = {
  binding: MessagingBindingRecord;
  createdAt: number;
  event?: MessagingInboundEvent;
  id: string;
  input: AppServerTurnInputItem[];
  ownerQueueEntryId?: string;
  manualRetryRequired?: boolean;
  pdfAttachments?: PendingPdfAttachment[];
  pdfSourceRequest?: MessagingCausalSourceRef;
  privateResponseRequested?: boolean;
  preview: string;
  status: "queued" | "steering" | "cancelled" | "submitted" | "failed";
  surface?: MessagingSurfaceRef;
  threadKey: string;
  updatedAt: number;
};

export type QueueRecoveryState =
  | { readonly phase: "held"; readonly entry: MessagingQueuedTurnEntry }
  | { readonly phase: "retrying"; readonly entry: MessagingQueuedTurnEntry; readonly receipt: symbol }
  | { readonly phase: "terminal"; readonly entry: MessagingQueuedTurnEntry; readonly outcome: "accepted" | "cancelled" | "disposed" };

export type QueueRecoveryEvent =
  | { readonly type: "hold"; readonly entry: MessagingQueuedTurnEntry }
  | { readonly type: "claim"; readonly receipt: symbol }
  | { readonly type: "settled"; readonly receipt: symbol; readonly accepted: boolean }
  | { readonly type: "surface"; readonly surface: MessagingSurfaceRef }
  | { readonly type: "cancel" | "dispose" };

export function transitionQueueRecovery(state: QueueRecoveryState | undefined, event: QueueRecoveryEvent): QueueRecoveryState | undefined {
  if (event.type === "hold") return state ?? { phase: "held", entry: event.entry };
  if (!state || state.phase === "terminal") return state;
  switch (event.type) {
    case "claim": return state.phase === "held" ? { phase: "retrying", entry: state.entry, receipt: event.receipt } : state;
    case "settled": return state.phase !== "retrying" || state.receipt !== event.receipt ? state
      : event.accepted ? { phase: "terminal", entry: state.entry, outcome: "accepted" } : { phase: "held", entry: state.entry };
    case "surface": return { ...state, entry: { ...state.entry, surface: event.surface } };
    case "cancel": return state.phase === "held" ? { phase: "terminal", entry: state.entry, outcome: "cancelled" } : state;
    case "dispose": return { phase: "terminal", entry: state.entry, outcome: "disposed" };
  }
}

export class MessagingQueueRecoveries {
  private readonly states = new Map<string, QueueRecoveryState>();
  private disposed = false;

  constructor(private readonly context: { readonly now: () => number }) {}

  get size(): number {
    return this.states.size;
  }

  hold(input: Omit<MessagingQueuedTurnEntry, "id" | "createdAt" | "updatedAt" | "status" | "manualRetryRequired" | "ownerQueueEntryId">): MessagingQueuedTurnEntry | undefined {
    if (this.disposed) return undefined;
    const now = this.context.now();
    const entry: MessagingQueuedTurnEntry = { ...input, id: `queued:${randomUUID()}`, createdAt: now, updatedAt: now, status: "queued", manualRetryRequired: true };
    this.commit(entry.id, { type: "hold", entry });
    return entry;
  }

  get(id: string): MessagingQueuedTurnEntry | undefined {
    const state = this.states.get(id);
    return state?.phase === "held" ? state.entry : undefined;
  }

  claim(id: string): { readonly entry: MessagingQueuedTurnEntry; readonly receipt: symbol } | undefined {
    const receipt = Symbol();
    const state = this.commit(id, { type: "claim", receipt });
    return state?.phase === "retrying" && state.receipt === receipt ? state : undefined;
  }

  settle(id: string, receipt: symbol, accepted: boolean): MessagingQueuedTurnEntry | undefined {
    const state = this.commit(id, { type: "settled", receipt, accepted });
    // Return the terminal projection before cleanup loses a surface that
    // arrived while the claimed operation was awaiting backend acceptance.
    return state?.phase === "terminal" && state.outcome === "accepted" ? state.entry : undefined;
  }

  cancel(id: string): boolean {
    return this.commit(id, { type: "cancel" })?.phase === "terminal";
  }

  surface(id: string, surface: MessagingSurfaceRef): void {
    this.commit(id, { type: "surface", surface });
  }

  dispose(): void {
    this.disposed = true;
    for (const id of this.states.keys()) this.commit(id, { type: "dispose" });
  }

  private commit(id: string, event: QueueRecoveryEvent): QueueRecoveryState | undefined {
    const state = transitionQueueRecovery(this.states.get(id), event);
    if (state?.phase === "terminal") this.states.delete(id);
    else if (state) this.states.set(id, state);
    return state;
  }
}
