import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { CheckIcon, CloseIcon, ExpandIcon } from "../../icons";
import {
  threadHandoffCancelBlockedReason,
  threadHandoffEyebrow,
  threadHandoffMeter,
  threadHandoffSteps,
  threadHandoffVerb,
} from "./thread-handoff-copy";
import { threadHandoffPercent, type ThreadHandoffTransfer } from "./thread-handoff-transfer";
import {
  useRunningThreadHandoff,
  useThreadHandoffTransfer,
  type ThreadHandoffStore,
} from "./thread-handoff-store";

/**
 * Re-renders once a second while `active`, for "lost 0:14 ago" and the rate.
 * Byte reports re-render on their own; this covers a link with none coming.
 */
function useClock(active: boolean): { monotonic: number; wall: number } {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setTick((tick) => tick + 1), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return { monotonic: performance.now(), wall: Date.now() };
}

/** `.app-update-banner__track`, plus the held and resumed states a handoff has. */
export function ThreadHandoffTrack(props: { transfer: ThreadHandoffTransfer; label: string }) {
  const { transfer } = props;
  const sending = transfer.phase === "send" && transfer.bytesTotal;
  const percent = sending ? threadHandoffPercent(transfer) : undefined;
  const resumedPercent = sending && transfer.resumedFromBytes && transfer.bytesTotal
    ? Math.min(percent ?? 0, Math.floor((transfer.resumedFromBytes / transfer.bytesTotal) * 100))
    : undefined;
  const className = [
    "app-update-banner__track",
    "thread-handoff-track",
    percent === undefined ? "app-update-banner__track--indeterminate" : "",
    transfer.link === "waiting" ? "thread-handoff-track--held" : "",
    resumedPercent !== undefined ? "thread-handoff-track--resumed" : "",
  ].filter(Boolean).join(" ");
  return (
    <span
      className={className}
      role="progressbar"
      aria-live="off"
      aria-label={props.label}
      aria-valuemin={percent === undefined ? undefined : 0}
      aria-valuemax={percent === undefined ? undefined : 100}
      aria-valuenow={percent}
    >
      {resumedPercent !== undefined && percent !== undefined ? (
        <>
          {/* What the receiver already held when the link came back. */}
          <i className="thread-handoff-track__resumed" style={{ width: `${resumedPercent}%` }} />
          <i style={{ width: `${percent - resumedPercent}%` }} />
        </>
      ) : (
        <i style={percent === undefined ? undefined : { width: `${percent}%` }} />
      )}
    </span>
  );
}

/** The dialog's view of a running handoff: one row per step, then the meter. */
export function ThreadHandoffSteps(props: { transfer: ThreadHandoffTransfer }) {
  const { transfer } = props;
  const clock = useClock(transfer.status === "running" && (transfer.phase === "send"));
  return (
    <>
      <ol className="thread-handoff-steps" aria-label={`${threadHandoffVerb(transfer)} steps`}>
        {threadHandoffSteps(transfer).map((step) => (
          <li
            key={step.key}
            className={`thread-handoff-steps__step thread-handoff-steps__step--${step.state}`}
            aria-current={step.state === "now" || step.state === "held" ? "step" : undefined}
          >
            <span aria-hidden="true" className="thread-handoff-steps__mark">
              {step.state === "done" ? <CheckIcon size={10} strokeWidth={2.4} /> : null}
            </span>
            <span className="thread-handoff-steps__body">
              <span className="thread-handoff-steps__label">{step.label}</span>
              {step.key === "send" && (step.state === "now" || step.state === "held") ? (
                <ThreadHandoffTrack transfer={transfer} label={step.label} />
              ) : null}
            </span>
            {step.value ? (
              <span className="thread-handoff-steps__value" aria-live="off">{step.value}</span>
            ) : null}
          </li>
        ))}
      </ol>
      <p className="thread-handoff-meter" aria-live="off">{threadHandoffMeter(transfer, clock)}</p>
    </>
  );
}

/**
 * A minimised handoff in the toast stack. It reuses the update banner's card
 * (`.app-update-banner`): live work with no fixed duration, an eyebrow that
 * names the step, the 5px track and a mono meter. The close button is Cancel,
 * not Dismiss: a live transfer cannot be dismissed.
 */
export function ThreadHandoffToastCard(props: {
  transfer: ThreadHandoffTransfer;
  onExpand: () => void;
  onCancel: () => void;
  onRetryNow: () => void;
}) {
  const { transfer } = props;
  const waiting = transfer.link === "waiting";
  const clock = useClock(transfer.phase === "send");
  const verb = threadHandoffVerb(transfer);
  const cancelLabel = `Cancel ${transfer.choice.operation === "move" ? "Move" : "Copy"}`;
  const blocked = threadHandoffCancelBlockedReason(transfer);
  const cancelDisabled = !transfer.cancelable || transfer.cancelRequested;
  return (
    <aside
      className={`app-update-banner thread-handoff-card${waiting ? " thread-handoff-card--held" : ""}`}
      data-thread-handoff-card={transfer.handoffId}
      role="status"
      aria-live="polite"
    >
      <div className="thread-handoff-card__head">
        <div className="app-update-banner__content">
          <p className="app-update-banner__eyebrow">
            {threadHandoffEyebrow(transfer)}
            {/* Ticks several times a second; a live region would read each one. */}
            {transfer.phase === "send" && transfer.link === "connected" && !transfer.cancelRequested
              && threadHandoffPercent(transfer) !== undefined ? (
              <span aria-live="off"> · {threadHandoffPercent(transfer)}%</span>
            ) : null}
          </p>
          <button
            className="thread-handoff-card__title"
            type="button"
            aria-live="off"
            onClick={props.onExpand}
          >
            {verb} &ldquo;{transfer.title}&rdquo; to {transfer.targetLabel}
          </button>
        </div>
        <div className="thread-handoff-card__icons">
          <button
            aria-label="Show progress"
            className="app-notice-toast__icon-button tooltip-target"
            data-tooltip="Show progress"
            type="button"
            onClick={props.onExpand}
          >
            <ExpandIcon size={13} />
          </button>
          <button
            aria-label={cancelLabel}
            className="app-notice-toast__icon-button tooltip-target"
            data-tooltip={blocked ?? cancelLabel}
            disabled={cancelDisabled}
            type="button"
            onClick={props.onCancel}
          >
            <CloseIcon size={13} />
          </button>
        </div>
      </div>
      <div>
        <ThreadHandoffTrack transfer={transfer} label={threadHandoffEyebrow(transfer)} />
        <p className="app-update-banner__meter" aria-live="off">{threadHandoffMeter(transfer, clock)}</p>
      </div>
      {waiting ? (
        <>
          <p className="thread-handoff-card__note">
            The {transfer.choice.operation} continues from{" "}
            {transfer.bytesCommitted ? "the last saved point" : "the start"} when{" "}
            {transfer.targetLabel} reconnects. Nothing it already has is sent again.
          </p>
          <div className="app-update-banner__actions">
            <div className="app-update-banner__buttons">
              <button
                className="button button--ghost app-update-banner__cancel"
                type="button"
                onClick={props.onRetryNow}
              >
                Retry Now
              </button>
              <button
                className="button button--ghost app-update-banner__cancel"
                disabled={cancelDisabled}
                type="button"
                onClick={props.onCancel}
              >
                {transfer.cancelRequested ? "Cancelling…" : cancelLabel}
              </button>
            </div>
          </div>
        </>
      ) : null}
    </aside>
  );
}

/**
 * Draws one handoff's live state. Only this subtree subscribes to the
 * handoff's progress, so a byte report re-renders it and not its parent.
 */
export function LiveThreadHandoff(props: {
  store: ThreadHandoffStore;
  handoffId: string | undefined;
  children: (transfer: ThreadHandoffTransfer | undefined) => ReactNode;
}) {
  return <>{props.children(useThreadHandoffTransfer(props.store, props.handoffId))}</>;
}

/** A toast card for one handoff, reading its own progress from the store. */
export function LiveThreadHandoffToastCard(props: {
  store: ThreadHandoffStore;
  handoffId: string;
  onExpand: () => void;
  onCancel: () => void;
  onRetryNow: () => void;
}) {
  const transfer = useThreadHandoffTransfer(props.store, props.handoffId);
  if (!transfer) return null;
  return (
    <ThreadHandoffToastCard
      transfer={transfer}
      onExpand={props.onExpand}
      onCancel={props.onCancel}
      onRetryNow={props.onRetryNow}
    />
  );
}

export type ThreadHandoffBandValue = {
  store: ThreadHandoffStore;
  showProgress: (handoffId: string) => void;
};

export const ThreadHandoffBandContext = createContext<ThreadHandoffBandValue | undefined>(undefined);

/**
 * The composer band row of a thread being sent. The thread takes no turns
 * until the send finishes, and with the send minimised nothing else on the
 * thread says why. It subscribes to the store itself, so a byte count
 * re-renders this row and not the composer around it.
 */
export function ThreadHandoffComposerBand(props: { threadKey: string | undefined }) {
  const band = useContext(ThreadHandoffBandContext);
  const transfer = useRunningThreadHandoff(band?.store, props.threadKey);
  if (!band || !transfer) return null;
  const percent = threadHandoffPercent(transfer);
  return (
    <div className="thread-handoff-band" role="status">
      <span className="thread-handoff-band__text">
        {threadHandoffVerb(transfer)} to <b>{transfer.targetLabel}</b>
        {transfer.link === "waiting" ? " · waiting to reconnect" : ""}
      </span>
      {transfer.phase === "send" && percent !== undefined ? (
        <>
          <ThreadHandoffTrack transfer={transfer} label={`${threadHandoffVerb(transfer)} progress`} />
          <span className="thread-handoff-band__value" aria-live="off">{percent}%</span>
        </>
      ) : null}
      <button
        className="thread-handoff-band__action"
        type="button"
        onClick={() => band.showProgress(transfer.handoffId)}
      >
        Show Progress
      </button>
    </div>
  );
}
