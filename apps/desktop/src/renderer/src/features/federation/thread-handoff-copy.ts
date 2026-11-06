import { formatByteCount } from "../../lib/format-bytes";
import { formatElapsedMs } from "../../lib/format-duration";
import {
  threadHandoffBytesSent,
  threadHandoffPercent,
  threadHandoffRate,
  threadHandoffSecondsLeft,
  type ThreadHandoffTransfer,
} from "./thread-handoff-transfer";

export type ThreadHandoffStepState = "done" | "now" | "held" | "pending";

export type ThreadHandoffStep = {
  key: "package" | "send" | "import" | "finish";
  label: string;
  state: ThreadHandoffStepState;
  /** Mono figure at the row's end: a percent while sending, the size once sent. */
  value?: string;
};

/**
 * The rows the dialog lists. Copy ends when the receiver has created and
 * checked the thread; Move adds the source-side check and archive as one row,
 * since the operator sees one outcome from them.
 */
export function threadHandoffSteps(transfer: ThreadHandoffTransfer): ThreadHandoffStep[] {
  const label = transfer.targetLabel;
  const keys: ThreadHandoffStep["key"][] = transfer.choice.operation === "move"
    ? ["package", "send", "import", "finish"]
    : ["package", "send", "import"];
  const current = transfer.phase === "verify" || transfer.phase === "archive"
    ? "finish"
    : transfer.phase;
  const currentIndex = keys.indexOf(current);
  const percent = threadHandoffPercent(transfer);
  const done = transfer.status === "succeeded";
  return keys.map((key, index): ThreadHandoffStep => {
    const state: ThreadHandoffStepState = done || index < currentIndex
      ? "done"
      : index === currentIndex
        ? key === "send" && transfer.link === "waiting" ? "held" : "now"
        : "pending";
    const step: ThreadHandoffStep = {
      key,
      state,
      label: key === "package"
        ? "Package history"
        : key === "send"
          ? `Send to ${label}`
          : key === "import"
            ? `Open the thread on ${label}`
            : "Verify and archive here",
    };
    if (key === "send") {
      if (state === "done" && transfer.bytesTotal) {
        step.value = formatByteCount(transfer.bytesTotal);
      } else if ((state === "now" || state === "held") && percent !== undefined) {
        step.value = `${percent}%`;
      }
    }
    return step;
  });
}

/** The mono line under the steps and on the card, as the update banner's meter. */
export function threadHandoffMeter(
  transfer: ThreadHandoffTransfer,
  now: { monotonic: number; wall: number },
): string {
  const label = transfer.targetLabel;
  switch (transfer.phase) {
    case "package":
      return "Reading the thread's history";
    case "import":
      return transfer.choice.targetRepositoryPath
        ? `${label} is creating the thread in a new worktree`
        : `${label} is creating the thread`;
    case "verify":
    case "archive":
      return "Checking this thread's history before archiving it";
    case "send":
      break;
  }
  if (!transfer.bytesTotal) return `Connecting to ${label}`;
  const sent = `${formatByteCount(threadHandoffBytesSent(transfer))} of ${formatByteCount(transfer.bytesTotal)}`;
  if (transfer.link === "waiting") {
    const lostAt = transfer.disconnectedAt ? Date.parse(transfer.disconnectedAt) : Number.NaN;
    return Number.isFinite(lostAt)
      ? `${sent} on ${label} · lost ${formatElapsedMs(now.wall - lostAt)} ago`
      : `${sent} on ${label}`;
  }
  const parts = [sent];
  if (transfer.resumedFromBytes) parts.push(`resumed at ${formatByteCount(transfer.resumedFromBytes)}`);
  const rate = threadHandoffRate(transfer, now.monotonic);
  if (rate && rate.bytesPerSecond > 0) parts.push(`${formatByteCount(Math.round(rate.bytesPerSecond))}/s`);
  const left = threadHandoffSecondsLeft(transfer, now.monotonic);
  if (left !== undefined && !transfer.resumedFromBytes) {
    parts.push(left < 60 ? `about ${Math.max(1, left)} s left` : `about ${Math.ceil(left / 60)} min left`);
  }
  return parts.join(" · ");
}

/** "Copying" / "Moving", for titles and the composer band. */
export function threadHandoffVerb(transfer: ThreadHandoffTransfer): string {
  return transfer.choice.operation === "move" ? "Moving" : "Copying";
}

/**
 * The card's uppercase eyebrow: the step alone. The card is a polite live
 * region and announces each step change; the percent beside it ticks and
 * stays out of the announcement.
 */
export function threadHandoffEyebrow(transfer: ThreadHandoffTransfer): string {
  if (transfer.cancelRequested) return "Cancelling";
  if (transfer.link === "waiting") return `Waiting for ${transfer.targetLabel}`;
  switch (transfer.phase) {
    case "package":
      return "Packaging";
    case "send":
      return "Sending";
    case "import":
      return `Opening on ${transfer.targetLabel}`;
    case "verify":
    case "archive":
      return "Archiving here";
  }
}

/** Why Cancel is off, for its tooltip. */
export function threadHandoffCancelBlockedReason(transfer: ThreadHandoffTransfer): string | undefined {
  if (transfer.cancelable) return undefined;
  return `${transfer.targetLabel} is creating the thread. Cancelling now could leave a copy there.`;
}
