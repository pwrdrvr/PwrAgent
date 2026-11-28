// What the in-flight half of the update banner says, as pure functions.
//
// Split out of the component because the interesting part of a progress card
// is the wording and the arithmetic, and neither needs a DOM to be checked.

import { releaseNotesUrl } from "@pwragent/shared/release-notes";
import type { AppUpdateStatus } from "../../../../shared/app-metadata";
import type { ProgressStripStep } from "../../components/ProgressStrip";
import { formatDownloadMeter } from "../../lib/download-meter";

/**
 * The statuses a check passes through before it has an answer.
 *
 * While the status is one of these the banner shows a live card instead of
 * handing the outcome to the auto-dismissing notice stack. A 9-second
 * countdown draining toward a dismissal that has nothing to do with the work
 * is the bug this file exists to fix.
 *
 * `available` counts as in-flight: PwrAgent's check returns there and lets the
 * updater's own events carry the download, so it is the middle of the work,
 * not the end of it.
 */
export type AppUpdateProgressStatus = Extract<
  AppUpdateStatus,
  { status: "checking" | "available" | "downloading" }
>;

export function isUpdateCheckInProgress(
  status: AppUpdateStatus,
): status is AppUpdateProgressStatus {
  return (
    status.status === "checking"
    || status.status === "available"
    || status.status === "downloading"
  );
}

export type UpdateProgressCopy = {
  eyebrow: string;
  /** The version being fetched, once the check has named one. */
  tag: string | undefined;
  /** The status line, or `undefined` while the byte meter holds it. */
  message: string | undefined;
  /** 0-100 for a determinate bar, `undefined` for the indeterminate sweep. */
  percent: number | undefined;
  /** Byte counts and rate, or `undefined` when the feed reports neither. */
  meter: string | undefined;
  /** Check, Download, Restart: the stages an update passes through. */
  steps: ProgressStripStep[];
  /** A download is running, so there is something for Cancel to stop. */
  cancelable: boolean;
  /** The release page for the version being fetched, when it names one.
   *  `undefined` while `checking`, which has no version yet. */
  notesUrl: string | undefined;
};

const CHECKING_LINE = "Asking GitHub for the latest release…";
const STARTING_LINE = "Starting the download…";
const DOWNLOADING_LINE = "Downloading…";

/**
 * Every line the live card's status line can show, so the shared strip holds
 * the longest one from `checking` on. The version sits in the tag, not in
 * these lines, so they are known before the check names one.
 */
export const UPDATE_PROGRESS_STATUS_LINES: readonly string[] = [
  CHECKING_LINE,
  STARTING_LINE,
  DOWNLOADING_LINE,
  "100% downloaded",
];

function updateSteps(at: "check" | "download"): ProgressStripStep[] {
  const download = at === "download";
  return [
    { key: "check", label: "Check", state: download ? "done" : "now" },
    { key: "download", label: "Download", state: download ? "now" : "todo" },
    { key: "restart", label: "Restart", state: "todo" },
  ];
}

export function updateProgressCopy(
  status: AppUpdateProgressStatus,
): UpdateProgressCopy {
  if (status.status === "checking") {
    return {
      eyebrow: "Checking for updates",
      tag: undefined,
      message: CHECKING_LINE,
      percent: undefined,
      meter: undefined,
      steps: updateSteps("check"),
      cancelable: false,
      // The one in-flight phase with no version yet, so the one card that
      // deliberately offers no link.
      notesUrl: undefined,
    };
  }
  // A resolved selection older than the running build is the operator moving
  // back onto their own channel, not an update landing on them — the same
  // distinction the downloaded card already draws.
  const switchingBack = status.direction === "downgrade";
  if (status.status === "available") {
    return {
      eyebrow: switchingBack ? "Switch available" : "Update available",
      tag: `v${status.version}`,
      message: STARTING_LINE,
      percent: undefined,
      meter: undefined,
      steps: updateSteps("download"),
      cancelable: true,
      notesUrl: releaseNotesUrl(status.version),
    };
  }
  // A provider that sends no content length gives electron-updater nothing to
  // compute a percent from. Fall back to the sweep rather than pinning the bar
  // at 0% for the length of the download. The line reads the clamped value
  // too, so an overshooting feed cannot print "104%" beside a full bar.
  const percent = clampPercent(status.percent);
  const meter = downloadMeter(status);
  return {
    eyebrow: switchingBack ? "Downloading switch" : "Downloading update",
    tag: `v${status.version}`,
    message: meter !== undefined
      ? undefined
      : percent === undefined
        ? DOWNLOADING_LINE
        : `${Math.round(percent)}% downloaded`,
    percent,
    meter,
    steps: updateSteps("download"),
    cancelable: true,
    notesUrl: releaseNotesUrl(status.version),
  };
}

function clampPercent(percent: number | undefined): number | undefined {
  if (percent === undefined || !Number.isFinite(percent)) {
    return undefined;
  }
  return Math.min(100, Math.max(0, percent));
}

/** The shared download meter, fed from electron-updater's field names. */
export function downloadMeter(status: {
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
}): string | undefined {
  return formatDownloadMeter({
    receivedBytes: status.transferred,
    totalBytes: status.total,
    bytesPerSecond: status.bytesPerSecond,
  });
}


export type UpdateCheckOutcomeCopy = {
  eyebrow: string;
  message: string;
  tone: "neutral" | "error";
  /** The release page for whichever version the outcome names. `undefined`
   *  for `skipped` and `error`, which name none. */
  notesUrl: string | undefined;
};

/**
 * Wording for a menu check that has finished and left nothing to act on.
 *
 * Kept parallel to Settings -> Updates, which answers the same
 * results inline. The in-flight statuses are not here: they are the live
 * card's, and `updateProgressCopy` words those. Neither is `downloaded` —
 * that outcome is actionable, so the sticky Restart card carries it.
 */
export function updateCheckOutcomeCopy(
  result: Exclude<
    AppUpdateStatus,
    { status: "idle" | "checking" | "available" | "downloading" | "downloaded" }
  >,
): UpdateCheckOutcomeCopy {
  if (result.status === "skipped") {
    return {
      eyebrow: "Updates unavailable",
      message: result.reason,
      tone: "neutral",
      notesUrl: undefined,
    };
  }
  if (result.status === "error") {
    return {
      eyebrow: "Update check failed",
      message: result.message,
      tone: "error",
      notesUrl: undefined,
    };
  }
  if (result.status === "canceled") {
    // Not a failure: nothing broke, and the release is still published. An
    // error tone here would put a red card in front of someone who got
    // exactly what they asked for.
    return {
      eyebrow: "Download canceled",
      message: `PwrAgent v${result.version} is still available - check again to download it.`,
      tone: "neutral",
      // The operator stopped a download and is now deciding whether to ask
      // for it again. What is in the build is the question they are holding.
      notesUrl: releaseNotesUrl(result.version),
    };
  }
  return {
    eyebrow: "PwrAgent is up to date",
    message: `You're running v${result.version}.`,
    tone: "neutral",
    // The running version, and the one case where Settings -> About's
    // bundled changelog CAN answer "what did I get?" — but it opens a second
    // window to do it, so the link stays for symmetry.
    notesUrl: releaseNotesUrl(result.version),
  };
}
