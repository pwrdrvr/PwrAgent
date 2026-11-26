import {
  buildHotCpuProfileHandoffMessage,
  formatHotCpuProfileTriggerSummary,
  type HotCpuFinalCaptureFailedEvent,
  type HotCpuPostCapEvent,
  type HotCpuProfileCapturedEvent,
  type RearmHotCpuProfileRequest,
} from "../../../../shared/hot-cpu-profile";
import type { AppNoticeToastNotice } from "./AppNoticeToast";

const CPU_PROFILE_DISMISS_GROUP = { key: "hot-cpu-profile", label: "CPU profile notices" };

function formatObservationTime(timestamp: string): string {
  return new Date(timestamp).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  });
}

export function buildHotCpuCaptureNotice(
  event: HotCpuProfileCapturedEvent | HotCpuFinalCaptureFailedEvent,
  rearm?: (request: RearmHotCpuProfileRequest) => Promise<boolean>,
  updateNotice?: (notice: AppNoticeToastNotice) => void,
): AppNoticeToastNotice {
  const capture = "profilePath" in event ? event : undefined;
  const heapSnapshotCount = capture?.heapSnapshotArtifacts?.length ?? 0;
  const process = event.target === "main" ? "Main" : "Renderer";
  const captureLimit = event.captureLimit;
  const captureMessage = capture ? [
    `Matched ${formatHotCpuProfileTriggerSummary(capture)}. Saved ${event.profileFilename}.`,
    heapSnapshotCount > 0 ? ` ${heapSnapshotCount} heap snapshots captured.` : "",
  ].join("") : "The final capture did not complete.";
  const notice: AppNoticeToastNotice = {
    autoDismiss: false,
    copyText: capture ? buildHotCpuProfileHandoffMessage(capture) : undefined,
    facts: [
      {
        label: "Source",
        value: `Local app${capture?.sourceHostname ? ` on ${capture.sourceHostname}` : ""}`,
      },
      { label: capture ? "Captured" : "Attempted", value: formatObservationTime(event.capturedAt) },
      { label: "Session", value: event.sessionDirectoryName },
    ],
    dismissGroup: CPU_PROFILE_DISMISS_GROUP,
    id: `hot-cpu-profile:${event.sessionDirectoryName}:${event.profileFilename}`,
    title: capture ? `${process} CPU profile captured` : `${process} CPU profile capture failed`,
    tone: capture ? undefined : "warning",
    message: captureLimit === undefined ? captureMessage
      : `${captureMessage} The capture limit (${captureLimit}) has been reached. CPU sampling continues.`,
  };
  if (captureLimit === undefined || !rearm || !updateNotice) return notice;
  return withRearmAction(notice, {
    captureLimit,
    rearm,
    rearmedMessage: captureMessage,
    request: { sessionDirectoryName: event.sessionDirectoryName, profileFilename: event.profileFilename },
    updateNotice,
  });
}

/** Every CPU profile notice offers Rearm, and reports its progress, the same way. */
function withRearmAction(notice: AppNoticeToastNotice, options: {
  captureLimit: number;
  rearm: (request: RearmHotCpuProfileRequest) => Promise<boolean>;
  rearmedMessage: string;
  request: RearmHotCpuProfileRequest;
  updateNotice: (notice: AppNoticeToastNotice) => void;
}): AppNoticeToastNotice {
  const { captureLimit, rearm, rearmedMessage, request, updateNotice } = options;
  const rearmableNotice = { ...notice, revealOnArrival: true };
  const rearmCapture = async () => {
    updateNotice({ ...rearmableNotice, status: { label: "Rearming CPU profiling…", state: "progress" } });
    try {
      const rearmed = await rearm(request);
      updateNotice({
        ...rearmableNotice,
        message: rearmed ? rearmedMessage : rearmableNotice.message,
        status: rearmed
          ? { label: `Rearmed for up to ${captureLimit} more captures.`, state: "success" }
          : { label: "This capture can no longer be rearmed.", state: "error" },
      });
    } catch {
      updateNotice({
        ...rearmableNotice,
        actions: [{ label: "Rearm", onClick: rearmCapture }],
        status: { label: "Could not rearm CPU profiling.", state: "error" },
      });
    }
  };
  return { ...rearmableNotice, actions: [{ label: "Rearm", onClick: rearmCapture }] };
}

export function buildHotCpuPostCapNotice(
  event: HotCpuPostCapEvent,
  rearm?: (request: RearmHotCpuProfileRequest) => Promise<boolean>,
  updateNotice?: (notice: AppNoticeToastNotice) => void,
): AppNoticeToastNotice {
  const process = event.target === "main" ? "Main process" : "Renderer";
  const rearmedMessage = "CPU sampling continues.";
  const message = `${rearmedMessage} This batch reached its capture limit.`;
  const notice: AppNoticeToastNotice = {
    autoDismiss: false,
    dismissGroup: CPU_PROFILE_DISMISS_GROUP,
    facts: [{ label: "Detected", value: formatObservationTime(event.capturedAt) }],
    id: `hot-cpu-post-cap:${event.target}:${event.sessionId}:${event.captureCount}`,
    revealOnArrival: true,
    tone: "warning",
    title: `${process} high CPU detected after capture limit`,
    message,
  };
  if (!event.rearm || !rearm || !updateNotice) return notice;
  const { captureLimit, ...request } = event.rearm;
  return withRearmAction(notice, { captureLimit, rearm, rearmedMessage, request, updateNotice });
}
