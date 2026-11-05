import type {
  HandoffInstanceThreadResult,
  ThreadHandoffPhase,
  ThreadHandoffProgress,
} from "@pwragent/shared";

export type ThreadHandoffOperation = "copy" | "move";

/** What the operator chose in the dialog. Kept so a failed send can retry it. */
export type ThreadHandoffChoice = {
  targetInstanceId: string;
  operation: ThreadHandoffOperation;
  targetRepositoryPath?: string;
};

export type ThreadHandoffTransferStatus = "running" | "succeeded" | "failed" | "cancelled";

/** Where the transfer is drawn: the dialog, or a card in the toast stack. */
export type ThreadHandoffTransferView = "dialog" | "toast";

/**
 * One handoff started from this window, from the operator's confirmation to
 * its result. Main reports progress; this record turns those reports into
 * something that only moves forward.
 */
export type ThreadHandoffTransfer = {
  handoffId: string;
  sourceThreadId: string;
  /** The source row's identity key, so the window can find the thread again. */
  threadKey: string;
  title: string;
  targetLabel: string;
  choice: ThreadHandoffChoice;
  status: ThreadHandoffTransferStatus;
  view: ThreadHandoffTransferView;
  phase: ThreadHandoffPhase;
  bytesCommitted?: number;
  /**
   * Bytes the receiver has acknowledged, which the bar draws. It can fall back
   * to `bytesCommitted` when a dropped link loses unsaved bytes, never below.
   */
  bytesSent?: number;
  bytesTotal?: number;
  resumedFromBytes?: number;
  link: "connected" | "waiting";
  disconnectedAt?: string;
  cancelable: boolean;
  transport: "resumable" | "single_shot";
  cancelRequested: boolean;
  startedAt: number;
  /** Byte counts for the rate. Cleared while the link is down. */
  samples: readonly { at: number; bytes: number }[];
  result?: HandoffInstanceThreadResult;
  error?: string;
};

export type ThreadHandoffTransfers = Readonly<Record<string, ThreadHandoffTransfer>>;

export type ThreadHandoffTransferEvent =
  | {
      type: "started";
      at: number;
      handoffId: string;
      sourceThreadId: string;
      threadKey: string;
      title: string;
      targetLabel: string;
      choice: ThreadHandoffChoice;
    }
  | { type: "progress"; at: number; progress: ThreadHandoffProgress }
  | { type: "cancel-requested"; handoffId: string }
  | { type: "succeeded"; handoffId: string; result: HandoffInstanceThreadResult }
  | { type: "failed"; handoffId: string; error: string }
  | { type: "cancelled"; handoffId: string }
  | { type: "show"; handoffId: string; view: ThreadHandoffTransferView }
  | { type: "removed"; handoffId: string };

/** Rate samples older than this no longer describe the link. */
export const RATE_WINDOW_MS = 5_000;
/** Time left is a guess until the rate has this much history behind it. */
export const ETA_MIN_SAMPLE_MS = 2_000;
const MAX_SAMPLES = 64;

export const THREAD_HANDOFF_PHASE_ORDER: readonly ThreadHandoffPhase[] = [
  "package",
  "send",
  "import",
  "verify",
  "archive",
];

function phaseIndex(phase: ThreadHandoffPhase): number {
  return THREAD_HANDOFF_PHASE_ORDER.indexOf(phase);
}

function applyProgress(
  transfer: ThreadHandoffTransfer,
  progress: ThreadHandoffProgress,
  at: number,
): ThreadHandoffTransfer {
  if (transfer.status !== "running") return transfer;
  // Steps only move forward. A late event from an earlier step is stale.
  if (phaseIndex(progress.phase) < phaseIndex(transfer.phase)) return transfer;
  const bytesCommitted = progress.bytesCommitted === undefined
    ? transfer.bytesCommitted
    : Math.max(transfer.bytesCommitted ?? 0, progress.bytesCommitted);
  // Older peers report committed bytes only; those are what was sent.
  const reportedSent = progress.bytesSent ?? progress.bytesCommitted;
  const bytesSent = reportedSent === undefined
    ? transfer.bytesSent
    : Math.max(bytesCommitted ?? 0, reportedSent);
  const waiting = progress.link === "waiting";
  let samples = transfer.samples;
  if (waiting || (bytesSent !== undefined && bytesSent < (transfer.bytesSent ?? 0))) {
    // No rate across a gap, or across bytes the receiver lost.
    samples = [];
  } else if (bytesSent !== undefined && bytesSent !== transfer.bytesSent) {
    samples = [...samples, { at, bytes: bytesSent }]
      .filter((sample) => at - sample.at <= RATE_WINDOW_MS)
      .slice(-MAX_SAMPLES);
  }
  // Once the receiver may be creating the thread, nothing takes that back,
  // and a Cancel that raced the import was ignored: it is no longer pending.
  const cancelable = transfer.cancelable && progress.cancelable;
  const next: ThreadHandoffTransfer = {
    ...transfer,
    phase: progress.phase,
    link: progress.link,
    cancelable,
    cancelRequested: cancelable && transfer.cancelRequested,
    transport: progress.transport,
    samples,
  };
  if (bytesCommitted !== undefined) next.bytesCommitted = bytesCommitted;
  if (bytesSent !== undefined) next.bytesSent = bytesSent;
  if (progress.bytesTotal !== undefined) next.bytesTotal = progress.bytesTotal;
  if (progress.resumedFromBytes !== undefined) next.resumedFromBytes = progress.resumedFromBytes;
  if (waiting && progress.disconnectedAt !== undefined) {
    next.disconnectedAt = progress.disconnectedAt;
  } else if (!waiting) {
    delete next.disconnectedAt;
  }
  return next;
}

function settle(
  transfers: ThreadHandoffTransfers,
  handoffId: string,
  patch: Partial<ThreadHandoffTransfer> & { status: ThreadHandoffTransferStatus },
): ThreadHandoffTransfers {
  const transfer = transfers[handoffId];
  if (!transfer || transfer.status !== "running") return transfers;
  return { ...transfers, [handoffId]: { ...transfer, ...patch, cancelRequested: false } };
}

export function reduceThreadHandoffTransfers(
  transfers: ThreadHandoffTransfers,
  event: ThreadHandoffTransferEvent,
): ThreadHandoffTransfers {
  switch (event.type) {
    case "started": {
      if (transfers[event.handoffId]) return transfers;
      return {
        ...transfers,
        [event.handoffId]: {
          handoffId: event.handoffId,
          sourceThreadId: event.sourceThreadId,
          threadKey: event.threadKey,
          title: event.title,
          targetLabel: event.targetLabel,
          choice: event.choice,
          status: "running",
          view: "dialog",
          phase: "package",
          link: "connected",
          cancelable: true,
          transport: "single_shot",
          cancelRequested: false,
          startedAt: event.at,
          samples: [],
        },
      };
    }
    case "progress": {
      const transfer = transfers[event.progress.handoffId];
      if (!transfer || transfer.sourceThreadId !== event.progress.sourceThreadId) return transfers;
      const next = applyProgress(transfer, event.progress, event.at);
      return next === transfer ? transfers : { ...transfers, [transfer.handoffId]: next };
    }
    case "cancel-requested": {
      const transfer = transfers[event.handoffId];
      if (!transfer || transfer.status !== "running" || !transfer.cancelable || transfer.cancelRequested) {
        return transfers;
      }
      return { ...transfers, [event.handoffId]: { ...transfer, cancelRequested: true } };
    }
    case "succeeded":
      return settle(transfers, event.handoffId, { status: "succeeded", result: event.result });
    case "failed":
      return settle(transfers, event.handoffId, { status: "failed", error: event.error });
    case "cancelled":
      return settle(transfers, event.handoffId, { status: "cancelled" });
    case "show": {
      const transfer = transfers[event.handoffId];
      if (!transfer || transfer.view === event.view) return transfers;
      return { ...transfers, [event.handoffId]: { ...transfer, view: event.view } };
    }
    case "removed": {
      if (!transfers[event.handoffId]) return transfers;
      const { [event.handoffId]: _removed, ...rest } = transfers;
      return rest;
    }
  }
}

/** The bytes the bar draws: acknowledged, else committed for an older peer. */
export function threadHandoffBytesSent(transfer: ThreadHandoffTransfer): number {
  return transfer.bytesSent ?? transfer.bytesCommitted ?? 0;
}

/** Whole percent of the send, or undefined before a total is known. */
export function threadHandoffPercent(transfer: ThreadHandoffTransfer): number | undefined {
  if (!transfer.bytesTotal) return undefined;
  const ratio = threadHandoffBytesSent(transfer) / transfer.bytesTotal;
  return Math.max(0, Math.min(100, Math.floor(ratio * 100)));
}

/** Bytes per second over the recent window, or undefined without two samples. */
export function threadHandoffRate(
  transfer: ThreadHandoffTransfer,
  now: number,
): { bytesPerSecond: number; spanMs: number } | undefined {
  const recent = transfer.samples.filter((sample) => now - sample.at <= RATE_WINDOW_MS);
  if (recent.length < 2) return undefined;
  const first = recent[0]!;
  const last = recent[recent.length - 1]!;
  const spanMs = last.at - first.at;
  if (spanMs <= 0) return undefined;
  return { bytesPerSecond: ((last.bytes - first.bytes) * 1000) / spanMs, spanMs };
}

/** Seconds left at the recent rate, once the rate has enough history. */
export function threadHandoffSecondsLeft(
  transfer: ThreadHandoffTransfer,
  now: number,
): number | undefined {
  if (!transfer.bytesTotal || transfer.link !== "connected" || transfer.phase !== "send") return undefined;
  const rate = threadHandoffRate(transfer, now);
  if (!rate || rate.spanMs < ETA_MIN_SAMPLE_MS || rate.bytesPerSecond <= 0) return undefined;
  const left = transfer.bytesTotal - threadHandoffBytesSent(transfer);
  return Math.max(0, Math.ceil(left / rate.bytesPerSecond));
}
