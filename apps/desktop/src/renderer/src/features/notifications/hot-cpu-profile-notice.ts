import {
  buildHotCpuProfileHandoffMessage,
  formatHotCpuProfileTriggerSummary,
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
  event: HotCpuProfileCapturedEvent,
  rearm?: (request: RearmHotCpuProfileRequest) => Promise<boolean>,
  updateNotice?: (notice: AppNoticeToastNotice) => void,
): AppNoticeToastNotice {
  const heapSnapshotCount = event.heapSnapshotArtifacts?.length ?? 0;
  const process = event.target === "main" ? "Main" : "Renderer";
  const captureLimit = event.captureLimit;
  const captureMessage = [
    `Matched ${formatHotCpuProfileTriggerSummary(event)}. Saved ${event.profileFilename}.`,
    heapSnapshotCount > 0 ? ` ${heapSnapshotCount} heap snapshots captured.` : "",
  ].join("");
  const notice: AppNoticeToastNotice = {
    autoDismiss: false,
    copyText: buildHotCpuProfileHandoffMessage(event),
    facts: [
      {
        label: "Source",
        value: `Local app${event.sourceHostname ? ` on ${event.sourceHostname}` : ""}`,
      },
      { label: "Captured", value: formatObservationTime(event.capturedAt) },
      { label: "Session", value: event.sessionDirectoryName },
    ],
    dismissGroup: CPU_PROFILE_DISMISS_GROUP,
    id: `hot-cpu-profile:${event.sessionDirectoryName}:${event.profileFilename}`,
    title: `${process} CPU profile captured`,
    message: captureLimit === undefined ? captureMessage
      : `${captureMessage} The capture limit (${captureLimit}) has been reached. CPU sampling continues.`,
  };
  if (captureLimit === undefined || !rearm || !updateNotice) return notice;

  const rearmableNotice = { ...notice, revealOnArrival: true };
  const rearmCapture = async () => {
    updateNotice({ ...rearmableNotice, status: { label: "Rearming CPU profiling…", state: "progress" } });
    try {
      const rearmed = await rearm({
        sessionDirectoryName: event.sessionDirectoryName,
        profileFilename: event.profileFilename,
      });
      updateNotice({
        ...rearmableNotice,
        message: rearmed ? captureMessage : rearmableNotice.message,
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

export function buildHotCpuPostCapNotice(event: HotCpuPostCapEvent): AppNoticeToastNotice {
  const process = event.target === "main" ? "Main process" : "Renderer";
  return {
    autoDismiss: false,
    dismissGroup: CPU_PROFILE_DISMISS_GROUP,
    facts: [{ label: "Detected", value: formatObservationTime(event.capturedAt) }],
    id: `hot-cpu-post-cap:${event.target}:${event.sessionId}:${event.captureCount}`,
    revealOnArrival: true,
    tone: "warning",
    title: `${process} high CPU detected after capture limit`,
    message: "CPU sampling continues. This batch reached its capture limit.",
  };
}
