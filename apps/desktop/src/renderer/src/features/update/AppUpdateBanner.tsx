// The update surface outside Settings. Three jobs, all driven from main and
// all deliberately non-modal:
//
//  - A check the operator asked for (Help -> Check for Updates) gets a LIVE
//    card for as long as it is working: an indeterminate sweep while the
//    release read is out, then a real meter once bytes are moving, when
//    closing the card cancels the download. It carries no dismiss countdown,
//    because the work it reports has no fixed duration.
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
import { releaseNotesUrl } from "@pwragent/shared";
import type {
  AppUpdateCheckResult,
  AppUpdateStatus,
} from "../../../../shared/app-metadata";
import type { DesktopApi } from "../../lib/desktop-api";
import {
  AppNoticeToast,
  type AppNoticeToastNotice,
} from "../notifications/AppNoticeToast";
import { openReleaseNotes } from "./ReleaseNotesLink";
import {
  isUpdateCheckInProgress,
  updateCheckOutcomeCopy,
  updateProgressCopy,
} from "./update-progress";

/** One menu check, one notice: the slot replaces its own previous answer
 *  rather than stacking a second one beside it. */
export const UPDATE_CHECK_NOTICE_SLOT = "app-update-check";

/** The live card, through every phase of one check. */
export const UPDATE_PROGRESS_NOTICE_ID = "app-update-progress";

/** The sticky offer, suffixed with the version it would install. */
export const UPDATE_READY_NOTICE_ID_PREFIX = "app-update-ready:";

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
    // Omitted entirely for `skipped` and `error`, which name no version.
    actions: releaseNotesActions(copy.notesUrl),
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
  // The operator closed the live card before there was a download to
  // cancel. The check keeps being watched, so its outcome still arrives.
  const [liveHidden, setLiveHidden] = useState(false);
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
    if (status.status === "downloaded") {
      // Actionable, so the sticky card below carries it and a transient
      // notice repeating the answer would say it twice. Adopted as the status
      // because this can be the only place it arrives: a check that joins an
      // already-held download is answered from `heldDownloadedUpdate`, and
      // main broadcasts no status event for it.
      setUpdateStatus(status);
      return;
    }
    if (status.status === "idle" || isUpdateCheckInProgress(status)) {
      // Not an answer at all.
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
          setLiveHidden(false);
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
          //
          // Neither may a standing `downloaded` offer: main answers such a
          // check from `heldDownloadedUpdate` without re-broadcasting the
          // status, so overwriting it here tears the Restart card down for
          // good. `downloaded` is not a stale mid-flight value - it is an
          // offer that outlives the check.
          if (
            !isUpdateCheckInProgress(statusRef.current)
            && statusRef.current.status !== "downloaded"
          ) {
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
    const cancel = desktopApi?.cancelAppUpdateDownload;
    if (!cancel) {
      // A window whose preload predates this channel. Latching the button
      // would claim a cancel that was never requested.
      return;
    }
    setCanceling(true);
    // No state change on a `canceled: true` reply: main answers the click
    // with a status change either way, and a `canceled: false` race means the
    // download finished - which is about to raise the Restart card, not
    // un-press this. A rejection is different: nothing was asked, so the
    // button must go back to offering the action.
    void cancel().catch(() => {
      setCanceling(false);
    });
  };

  const progress =
    watching && !liveHidden && isUpdateCheckInProgress(updateStatus)
      ? updateProgressCopy(updateStatus)
      : undefined;
  const offered = version !== undefined && dismissedVersion !== version;
  const offerNotesUrl =
    version === undefined ? undefined : releaseNotesUrl(version);

  // One card for every phase of a check, so the offer takes the live card's
  // place rather than raising a second one. The offer has no bar or meter,
  // and the stack keeps a card from shrinking through that swap while the
  // pointer is on it (AppNoticeToast.tsx), which is what makes the close
  // button below a safe target: a click aimed at it
  // as Cancel, landing just after the download finished, dismisses the offer
  // and leaves the update uninstalled. Restart sits in the footer, never
  // under that pointer, and Release notes trails both cards' footers, so it
  // holds the same slot too.
  const notice: AppNoticeToastNotice | undefined = progress
    ? {
        id: UPDATE_PROGRESS_NOTICE_ID,
        autoDismiss: false,
        title: progress.eyebrow,
        message: progress.message,
        progress: {
          label: progress.eyebrow,
          percent: progress.percent,
          meter: progress.meter,
        },
        ...(canceling
          ? { status: { label: "Canceling...", state: "progress" as const } }
          : {}),
        // A download is the work this card reports, so closing it is
        // Cancel. While the release read is still out there is nothing to
        // stop, and closing only hides the card: the outcome still arrives
        // as a notice.
        ...(progress.cancelable
          ? { dismissLabel: "Cancel update download" }
          : {}),
        actions: releaseNotesActions(progress.notesUrl),
      }
    : offered
      ? {
          id: `${UPDATE_READY_NOTICE_ID_PREFIX}${version}`,
          autoDismiss: false,
          tone: "success",
          title: switchingBack ? "Switch ready" : "Update ready",
          message: switchingBack
            ? `Restart to switch to v${version}.`
            : `Restart to update to v${version}.`,
          ...(restartError
            ? { status: { label: restartError, state: "error" as const } }
            : {}),
          actions: [
            {
              label: restarting ? "Restarting..." : "Restart",
              onClick: () => {
                void handleRestart();
              },
              tone: "primary",
              disabled: restarting,
            },
            ...(releaseNotesActions(offerNotesUrl) ?? []),
          ],
        }
      : undefined;

  if (!notice) {
    return null;
  }

  return (
    <AppNoticeToast
      desktopApi={desktopApi}
      notice={notice}
      onDismiss={progress
        ? progress.cancelable ? handleCancel : () => setLiveHidden(true)
        : () => {
            // The old Dismiss was disabled through an install: dismissed
            // now, a failed restart would report its error to no one.
            if (!restarting) setDismissedVersion(version);
          }}
    />
  );
}

/** Every update surface that names a version links its release notes. A
 *  notice owns its action buttons, so the link rides as an action and shares
 *  `openReleaseNotes` rather than rendering `ReleaseNotesLink`. */
function releaseNotesActions(
  url: string | undefined,
): AppNoticeToastNotice["actions"] {
  return url === undefined
    ? undefined
    : [{ label: "Release notes", onClick: () => openReleaseNotes(url) }];
}
