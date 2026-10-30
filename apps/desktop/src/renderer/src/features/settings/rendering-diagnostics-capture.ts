import type { RenderingCaptureResult } from "../../../../shared/rendering-diagnostics";
import type { DesktopApi } from "../../lib/desktop-api";
import type { AppNoticeToastNotice } from "../notifications/AppNoticeToast";

type CaptureState =
  | { phase: "idle" | "staging" | "capturing" }
  | { phase: "complete"; result: RenderingCaptureResult }
  | { phase: "error"; error: string };

/** In-memory, window-local state survives leaving Settings. No work until Start. */
export function createRenderingDiagnosticsCapture() {
  let state: CaptureState = { phase: "idle" };
  let stagingTimer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();
  const publish = (next: CaptureState) => {
    state = next;
    for (const listener of listeners) listener();
  };

  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    cancel: () => {
      if (state.phase !== "staging") return;
      clearTimeout(stagingTimer);
      stagingTimer = undefined;
      publish({ phase: "idle" });
    },
    start: (
      desktopApi: DesktopApi,
      onShowNotice?: (notice: AppNoticeToastNotice) => void,
    ) => {
      if (!desktopApi.captureRenderingDiagnostics
        || state.phase === "staging" || state.phase === "capturing") return;
      publish({ phase: "staging" });
      stagingTimer = setTimeout(async () => {
        stagingTimer = undefined;
        publish({ phase: "capturing" });
        let notice: AppNoticeToastNotice;
        try {
          // Only the staging delay belongs to the renderer. The existing main
          // process owns the capture deadline, even if this renderer stalls.
          const result = await desktopApi.captureRenderingDiagnostics!(10);
          publish({ phase: "complete", result });
          notice = {
            id: "rendering-diagnostics-result",
            autoDismiss: false,
            title: "Rendering summary saved",
            message: "Find the sanitized summary in Settings → Troubleshooting → Rendering diagnostics. Copy its path to open it locally. Share only relevant sanitized counts and capture conditions; keep raw traces and logs private.",
            facts: [{ label: "Summary", value: result.summaryPath }],
            copyText: result.summaryPath,
            tone: "success",
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          publish({ phase: "error", error: message });
          notice = {
            id: "rendering-diagnostics-result",
            autoDismiss: false,
            title: "Rendering capture failed",
            message: "Return to Settings → Troubleshooting to retry. Only one capture or Chromium tracing session can run in this instance at a time.",
            detail: message,
            tone: "error",
          };
        }
        onShowNotice?.(notice);
      }, 5_000);
    },
  };
}

export const renderingDiagnosticsCapture = createRenderingDiagnosticsCapture();
