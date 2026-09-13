// The update surface outside Settings. Three jobs, all driven from main and
// all deliberately non-modal:
//
//  - A check the operator asked for (Help -> Check for Updates) gets a LIVE
//    card for as long as it is working: an indeterminate sweep while the
//    release read is out, then a real meter with a Cancel button once bytes
//    are moving. It carries no dismiss countdown, because the work it reports
//    has no fixed duration.
//  - When that check settles on something with nothing to act on - up to
//    date, unavailable, canceled, failed - it hands off to the ordinary
//    auto-dismissing notice stack, which is where a notice that has finished
//    talking belongs.
//  - A downloaded update is actionable, so it keeps its sticky card with
//    Restart on it. This is the one the operator meets without asking: a
//    background check found the update.
//
// Background (startup/periodic) checks raise no card at all. They never emit
// `onAppUpdateCheckResult`, and the live card is gated on having seen one.
// That gate is the whole reason this component listens to two channels
// instead of one - the status channel alone cannot tell a check the operator
// asked for from one the hour hand asked for. See AGENTS.md in this folder.

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AppUpdateCheckResult,
  AppUpdateStatus,
} from "../../../../shared/app-metadata";
import type { DesktopApi } from "../../lib/desktop-api";
import type { AppNoticeToastNotice } from "../notifications/AppNoticeToast";
import {
  isUpdateCheckInProgress,
  updateCheckOutcomeCopy,
  updateProgressCopy,
} from "./update-progress";

/** One menu check, one notice: the slot replaces its own previous answer
 *  rather than stacking a second one beside it. */
export const UPDATE_CHECK_NOTICE_SLOT = "app-update-check";

export function updateCheckOutcomeNotice(
  result: Parameters<typeof updateCheckOutcomeCopy>[0],
): AppNoticeToastNotice {
  const copy = updateCheckOutcomeCopy(result);
  return {
    // Status-keyed so a genuinely new outcome remounts the notice and
    // restarts its countdown, while a repeat of the same one is idempotent.
    id: `${UPDATE_CHECK_NOTICE_SLOT}:${result.status}`,
    transientSlot: UPDATE_CHECK_NOTICE_SLOT,
    title: copy.eyebrow,
    message: copy.message,
    tone: copy.tone,
  };
}

export function AppUpdateBanner(props: {
  desktopApi?: DesktopApi;
  /** Where a settled menu check hands its outcome off to. Absent in surfaces
   *  that mount the banner without a notice stack; the live card and the
   *  sticky offer still work. */
  showNotice?: (notice: AppNoticeToastNotice) => void;
  dismissNotice?: (id: string) => void;
}) {
  const [updateStatus, setUpdateStatus] = useState<AppUpdateStatus>({
    status: "idle",
  });
  const [dismissedVersion, setDismissedVersion] = useState<string | undefined>();
  const [restartError, setRestartError] = useState<string | undefined>();
  const [restarting, setRestarting] = useState(false);
  // A check the operator asked for is running. Only then does the live card
  // show: hourly background checks move the same statuses and must stay
  // silent.
  const [watching, setWatching] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const desktopApi = props.desktopApi;

  // Read inside the subscriptions without making them depend on the values -
  // resubscribing on every progress tick would drop events between the
  // unsubscribe and the re-subscribe. Written during render rather than in an
  // effect so they are never a commit behind; they are only ever read from an
  // event callback, never during render, so there is nothing to tear.
  const watchingRef = useRef(false);
  const statusRef = useRef(updateStatus);
  statusRef.current = updateStatus;
  const showNoticeRef = useRef(props.showNotice);
  showNoticeRef.current = props.showNotice;
  const dismissNoticeRef = useRef(props.dismissNotice);
  dismissNoticeRef.current = props.dismissNotice;
  /** The outcome notice this component last raised, so a fresh check takes
   *  down the previous answer instead of leaving it beside the new card. */
  const outcomeNoticeIdRef = useRef<string | undefined>(undefined);

  const settle = useCallback((status: AppUpdateStatus): void => {
    watchingRef.current = false;
    setWatching(false);
    setCanceling(false);
    if (
      status.status === "idle"
      || status.status === "downloaded"
      || isUpdateCheckInProgress(status)
    ) {
      // `downloaded` is actionable, so the sticky card below carries it and a
      // transient notice repeating the answer would say it twice. `idle` is
      // not an answer at all.
      return;
    }
    const notice = updateCheckOutcomeNotice(status);
    outcomeNoticeIdRef.current = notice.id;
    showNoticeRef.current?.(notice);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let receivedEvent = false;
    const unsubscribe = desktopApi?.onAppUpdateStatus?.((status) => {
      receivedEvent = true;
      setUpdateStatus(status);
      // The check returns at `available` and lets the updater's own events
      // carry the download, so the status channel - not the result channel -
      // is where a watched download finishes, fails, or stops.
      if (watchingRef.current && !isUpdateCheckInProgress(status)) {
        settle(status);
      }
    });
    void desktopApi?.readAppUpdateStatus?.().then((status) => {
      if (!cancelled && !receivedEvent) {
        setUpdateStatus(status);
      }
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [desktopApi, settle]);

  useEffect(() => {
    const unsubscribe = desktopApi?.onAppUpdateCheckResult?.(
      (result: AppUpdateCheckResult) => {
        if (result.status === "checking") {
          // The only mid-flight tick on this channel; everything after it is
          // an outcome. The live card takes over from here, driven by the
          // status channel.
          //
          // Asking again is asking to see the answer again: an update the
          // operator dismissed earlier comes back rather than the check
          // looking dead, and it comes back without the failed restart that
          // preceded it.
          watchingRef.current = true;
          setWatching(true);
          setCanceling(false);
          setDismissedVersion(undefined);
          setRestartError(undefined);
          setRestarting(false);
          if (outcomeNoticeIdRef.current !== undefined) {
            dismissNoticeRef.current?.(outcomeNoticeIdRef.current);
            outcomeNoticeIdRef.current = undefined;
          }
          // This tick outruns the status event it mirrors, and a card rendered
          // from a stale `idle` would flash the wrong copy - but a check that
          // JOINED one already downloading is further along than `checking`
          // and must not be walked backwards.
          if (!isUpdateCheckInProgress(statusRef.current)) {
            setUpdateStatus(result);
          }
          return;
        }
        if (isUpdateCheckInProgress(result)) {
          // `available` is where PwrAgent's check returns while the download
          // it started keeps running. The card stays up; the status channel
          // carries the rest.
          return;
        }
        settle(result);
      },
    );
    return () => {
      unsubscribe?.();
    };
  }, [desktopApi, settle]);

  const version =
    updateStatus.status === "downloaded" ? updateStatus.version : undefined;
  // A downgrade is the operator moving back onto the channel they picked, not
  // an update landing on them, so it gets its own wording.
  const switchingBack =
    updateStatus.status === "downloaded"
    && updateStatus.direction === "downgrade";

  useEffect(() => {
    if (!version || dismissedVersion === version) {
      return;
    }
    setRestartError(undefined);
    setRestarting(false);
  }, [dismissedVersion, version]);

  const handleRestart = async () => {
    if (!desktopApi?.installAppUpdate) {
      setRestartError("Restart is not available in this build.");
      return;
    }
    setRestarting(true);
    setRestartError(undefined);
    const result = await desktopApi.installAppUpdate();
    if (result.status === "error") {
      setRestartError(result.message);
      setRestarting(false);
    }
  };

  const handleCancel = (): void => {
    if (canceling) {
      return;
    }
    setCanceling(true);
    void desktopApi?.cancelAppUpdateDownload?.();
    // No state change on the reply: main answers the click with a status
    // change either way, and a `canceled: false` race means the download
    // finished - which is about to raise the Restart card, not un-press this.
  };

  const progress =
    watching && isUpdateCheckInProgress(updateStatus)
      ? updateProgressCopy(updateStatus)
      : undefined;
  const offered = version !== undefined && dismissedVersion !== version;

  if (!progress && !offered) {
    return null;
  }

  return (
    <>
      {progress ? (
        <aside
          className="app-update-banner app-update-banner--progress"
          role="status"
          aria-live="polite"
        >
          <div className="app-update-banner__content">
            <p className="app-update-banner__eyebrow">{progress.eyebrow}</p>
            {/* `role="status"` above makes this card a polite live region, so
                the eyebrow announces each phase - which is what a screen
                reader user wants to hear. The percent, the bar and the byte
                meter change about once a second, and announcing every tick
                would bury the phase changes under "42%... 44%... 47%". They
                opt out; the progressbar keeps its value for anyone who asks
                for it. */}
            <p className="app-update-banner__message" aria-live="off">
              {progress.message}
            </p>
            <span
              className={
                progress.percent === undefined
                  ? "app-update-banner__track app-update-banner__track--indeterminate"
                  : "app-update-banner__track"
              }
              role="progressbar"
              aria-live="off"
              aria-label={progress.eyebrow}
              aria-valuemin={progress.percent === undefined ? undefined : 0}
              aria-valuemax={progress.percent === undefined ? undefined : 100}
              aria-valuenow={progress.percent}
            >
              <i
                style={
                  progress.percent === undefined
                    ? undefined
                    : { width: `${progress.percent}%` }
                }
              />
            </span>
            {progress.meter ? (
              <p className="app-update-banner__meter" aria-live="off">
                {progress.meter}
              </p>
            ) : null}
          </div>
          {progress.cancelable ? (
            <div className="app-update-banner__actions">
              <button
                className="button button--ghost app-update-banner__cancel"
                type="button"
                disabled={canceling}
                onClick={handleCancel}
              >
                {canceling ? "Canceling..." : "Cancel"}
              </button>
            </div>
          ) : null}
        </aside>
      ) : null}
      {offered ? (
        <aside className="app-update-banner" role="status" aria-live="polite">
          <div className="app-update-banner__content">
            <p className="app-update-banner__eyebrow">
              {switchingBack ? "Switch ready" : "Update ready"}
            </p>
            <p className="app-update-banner__message">
              {switchingBack
                ? `Restart to switch to v${version}.`
                : `Restart to update to v${version}.`}
            </p>
            {restartError ? (
              <p className="app-update-banner__error">{restartError}</p>
            ) : null}
          </div>
          <div className="app-update-banner__actions">
            <button
              className="button button--primary app-update-banner__restart"
              type="button"
              disabled={restarting}
              onClick={() => {
                void handleRestart();
              }}
            >
              {restarting ? "Restarting..." : "Restart"}
            </button>
            <button
              className="button button--ghost app-update-banner__dismiss"
              type="button"
              disabled={restarting}
              aria-label={
                switchingBack
                  ? "Dismiss channel switch notification"
                  : "Dismiss update notification"
              }
              onClick={() => setDismissedVersion(version)}
            >
              Dismiss
            </button>
          </div>
        </aside>
      ) : null}
    </>
  );
}
