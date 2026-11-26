import { useEffect, type Dispatch } from "react";
import type { HotCpuFinalCaptureFailedEvent, HotCpuProfileCapturedEvent } from "../../../../shared/hot-cpu-profile";
import type { DesktopApi } from "../../lib/desktop-api";
import type { AppNoticeToastNotice } from "./AppNoticeToast";
import type { AppNoticeAction } from "./app-notice-state";
import { buildHotCpuCaptureNotice, buildHotCpuPostCapNotice } from "./hot-cpu-profile-notice";

export function useHotCpuProfileNotices(
  desktopApi: Pick<
    DesktopApi,
    "listRearmableHotCpuProfiles" | "rearmHotCpuProfile" | "onHotCpuProfileCaptured"
    | "onHotCpuFinalCaptureFailed" | "onHotCpuPostCap"
  > | undefined,
  dispatchNotice: Dispatch<AppNoticeAction>,
): void {
  useEffect(() => {
    if (!desktopApi) return;
    let cancelled = false;
    // A live offer takes precedence over a snapshot already in flight for
    // that session, even if its notice has since been rearmed or dismissed.
    let liveSessions = desktopApi.listRearmableHotCpuProfiles ? new Set<string>() : undefined;
    const updateNotice = (notice: AppNoticeToastNotice) => dispatchNotice({ type: "update-durable", notice });
    const showCapture = (event: HotCpuProfileCapturedEvent | HotCpuFinalCaptureFailedEvent) => {
      dispatchNotice({
        type: "show",
        notice: buildHotCpuCaptureNotice(event, desktopApi.rearmHotCpuProfile, updateNotice),
      });
    };
    const showLiveCapture = (event: HotCpuProfileCapturedEvent | HotCpuFinalCaptureFailedEvent) => {
      if (event.captureLimit !== undefined) liveSessions?.add(event.sessionDirectoryName);
      showCapture(event);
    };
    const unsubscribeCapture = desktopApi.onHotCpuProfileCaptured?.(showLiveCapture);
    const unsubscribeFailure = desktopApi.onHotCpuFinalCaptureFailed?.(showLiveCapture);
    const unsubscribePostCap = desktopApi.onHotCpuPostCap?.((event) => {
      dispatchNotice({
        type: "show",
        notice: buildHotCpuPostCapNotice(event, desktopApi.rearmHotCpuProfile, updateNotice),
      });
    });
    void desktopApi.listRearmableHotCpuProfiles?.().then((captures) => {
      if (cancelled) return;
      for (const capture of captures) {
        if (!liveSessions?.has(capture.sessionDirectoryName)) showCapture(capture);
      }
    }).catch(() => {
      // Diagnostics can continue to deliver live notices if the snapshot fails.
    }).finally(() => {
      liveSessions = undefined;
    });
    return () => {
      cancelled = true;
      unsubscribeCapture?.();
      unsubscribeFailure?.();
      unsubscribePostCap?.();
    };
  }, [desktopApi, dispatchNotice]);
}
