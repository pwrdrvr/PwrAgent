import { useSyncExternalStore } from "react";
import type { DesktopApi } from "../../lib/desktop-api";
import type { AppNoticeToastNotice } from "../notifications/AppNoticeToast";
import { SettingsCopyValue } from "./SettingsCopyValue";
import { SettingsField, SettingsSection } from "./SettingsLayout";
import { renderingDiagnosticsCapture } from "./rendering-diagnostics-capture";

export function RenderingDiagnosticsSettings(props: {
  desktopApi?: DesktopApi;
  onShowNotice?: (notice: AppNoticeToastNotice) => void;
}) {
  const capture = useSyncExternalStore(
    renderingDiagnosticsCapture.subscribe,
    renderingDiagnosticsCapture.getSnapshot,
  );
  const available = Boolean(props.desktopApi?.captureRenderingDiagnostics);
  const busy = capture.phase === "staging" || capture.phase === "capturing";

  return (
    <SettingsSection eyebrow="Troubleshooting" title="Rendering diagnostics">
      <div className="settings-fields">
        <SettingsField
          label="Capture rendering activity"
          sub="Capture 10 seconds of rendering activity across this instance’s windows after a 5-second delay. No Developer Mode or restart needed."
          help="Close Settings and DevTools during the delay, leave the scene undisturbed, and return after capture. Tracing adds brief overhead. The sanitized summary excludes page text, URLs, screenshots, and trace arguments. Counts are not hardware GPU utilization and do not prove which component caused the activity."
          control={
            <div className="settings-hot-cpu-capture">
              <button
                type="button"
                className="button button--primary"
                disabled={!available || busy}
                onClick={() => {
                  if (props.desktopApi) {
                    renderingDiagnosticsCapture.start(props.desktopApi, props.onShowNotice);
                  }
                }}
              >
                Capture Rendering (10s)
              </button>
              {capture.phase === "staging" ? (
                <button
                  type="button"
                  className="button button--secondary"
                  onClick={renderingDiagnosticsCapture.cancel}
                >
                  Cancel Rendering Capture
                </button>
              ) : null}
              <span className="settings-hot-cpu-capture__status" role="status">
                {!available ? "Unavailable in this window"
                  : capture.phase === "staging" ? "Starting after 5s — close Settings and DevTools now"
                    : capture.phase === "capturing" ? "Capturing for 10s, then saving summary…"
                      : capture.phase === "complete" ? `Sanitized summary saved (${(capture.result.durationMs / 1_000).toFixed(1)}s recorded)`
                        : capture.phase === "error" ? "Capture failed — you can retry"
                          : "Not capturing"}
              </span>
            </div>
          }
        />
        <SettingsField
          label="Sanitized summary"
          sub="Saved locally in this profile’s state/diagnostics/rendering-*/summary.json."
          help="Copy the completed capture’s path and open it in a local editor. Share only relevant sanitized counts and capture conditions; keep raw traces and logs private."
          control={capture.phase === "complete" ? (
            <SettingsCopyValue
              desktopApi={props.desktopApi}
              label="rendering summary path"
              value={capture.result.summaryPath}
            />
          ) : (
            <span className="settings-hot-cpu-capture__status">
              Path available after capture
            </span>
          )}
        />
        {capture.phase === "error" ? (
          <p className="settings-row__error" role="alert">
            {capture.error} Only one capture or Chromium tracing session can run
            in this instance at a time. Finish it before retrying.
          </p>
        ) : null}
      </div>
    </SettingsSection>
  );
}
