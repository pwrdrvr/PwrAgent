// What the in-flight half of the update banner says, as pure functions.
//
// Split out of the component because the interesting part of a progress card
// is the wording and the arithmetic, and neither needs a DOM to be checked.

import { releaseNotesUrl } from "@pwragent/shared";
import type { AppUpdateStatus } from "../../../../shared/app-metadata";
import { formatByteCount } from "../../lib/format-bytes";

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
  message: string;
  /** 0-100 for a determinate bar, `undefined` for the indeterminate sweep. */
  percent: number | undefined;
  /** Byte counts and rate, or `undefined` when the feed reports neither. */
  meter: string | undefined;
  /** A download is running, so there is something for Cancel to stop. */
  cancelable: boolean;
  /** The release page for the version being fetched, when it names one.
   *  `undefined` while `checking`, which has no version yet. */
  notesUrl: string | undefined;
};

export function updateProgressCopy(
  status: AppUpdateProgressStatus,
): UpdateProgressCopy {
  if (status.status === "checking") {
    return {
      eyebrow: "Checking for updates",
      message: "Asking GitHub for the latest release...",
      percent: undefined,
      meter: undefined,
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
      message: `Starting download of v${status.version}...`,
      percent: undefined,
      meter: undefined,
      cancelable: true,
      notesUrl: releaseNotesUrl(status.version),
    };
  }
  // A provider that sends no content length gives electron-updater nothing to
  // compute a percent from. Fall back to the sweep rather than pinning the bar
  // at 0% for the length of the download. The message reads the clamped value
  // too, so an overshooting feed cannot print "104%" beside a full bar.
  const percent = clampPercent(status.percent);
  return {
    eyebrow: switchingBack ? "Downloading switch" : "Downloading update",
    message: `PwrAgent v${status.version}${
      percent === undefined ? "" : ` - ${Math.round(percent)}%`
    }`,
    percent,
    meter: downloadMeter(status),
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

/** `24.1 MB of 113 MB - 3.2 MB/s`, dropping whichever half is unknown.
 *  Byte figures go through the shared `formatByteCount` so this meter cannot
 *  round differently from the rest of the app. */
export function downloadMeter(status: {
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
}): string | undefined {
  const parts: string[] = [];
  if (isPositive(status.total) && isCount(status.transferred)) {
    parts.push(
      `${formatByteCount(status.transferred)} of ${formatByteCount(status.total)}`,
    );
  } else if (isCount(status.transferred)) {
    parts.push(`${formatByteCount(status.transferred)} transferred`);
  }
  if (isPositive(status.bytesPerSecond)) {
    parts.push(`${formatByteCount(status.bytesPerSecond)}/s`);
  }
  return parts.length === 0 ? undefined : parts.join(" - ");
}

function isCount(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0;
}

function isPositive(value: number | undefined): value is number {
  return isCount(value) && value > 0;
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
