import { useState } from "react";
import type { DesktopApi } from "../../lib/desktop-api";
// The full-bleed master, not a copy: the padded macOS variants are the wrong
// mark outside macOS, and a renderer copy would drift from the shipped icon.
import pwragentAppIcon from "../../../../../build/icon.png";

/**
 * Slack's manifest has no icon field, and the only API that sets one works
 * for apps created through a Slack "manager" app, which a customer-owned app
 * is not. So the icon is one drag: open the app's Basic Information page, and
 * drop the file on Slack's upload window.
 */
export function SlackAppIconStep(props: { desktopApi?: DesktopApi }) {
  const [opening, setOpening] = useState(false);
  const [feedback, setFeedback] = useState<
    { kind: "status" | "error"; message: string } | undefined
  >(undefined);
  const startDrag = props.desktopApi?.startAppIconDrag;
  const openSettings = props.desktopApi?.openSlackAppSettings;

  const open = async (): Promise<void> => {
    if (!openSettings || opening) return;
    setOpening(true);
    setFeedback(undefined);
    try {
      const result = await openSettings();
      if (!result.appSpecific) {
        setFeedback({
          kind: "status",
          message:
            "Opened your Slack apps. Choose the PwrAgent app, then Basic Information. Once the App Token is saved, this opens the app directly.",
        });
      }
    } catch (caught) {
      setFeedback({
        kind: "error",
        message: caught instanceof Error ? caught.message : String(caught),
      });
    } finally {
      setOpening(false);
    }
  };

  return (
    <div className="slack-icon-step">
      <p className="slack-connect__step">
        Optional. On <strong>Basic Information</strong>, under{" "}
        <strong>Display Information</strong>, click{" "}
        <strong>Add App Icon</strong>, then drag this icon into Slack&rsquo;s
        upload window or file picker.
      </p>
      <div className="slack-icon-step__row">
        <img
          alt="PwrAgent app icon"
          className={`slack-icon-step__icon${startDrag ? " is-draggable" : ""}`}
          draggable={Boolean(startDrag)}
          src={pwragentAppIcon}
          title={startDrag ? "Drag into Slack" : undefined}
          onDragStart={(event) => {
            if (!startDrag) return;
            // Chromium's own image drag carries a renderer URL, which an
            // upload field cannot take; main starts a drag of the file.
            event.preventDefault();
            startDrag();
          }}
        />
        <button
          className="button button--secondary"
          disabled={!openSettings || opening}
          type="button"
          onClick={() => {
            void open();
          }}
        >
          {opening ? "Opening…" : "Open Basic Information"}
        </button>
      </div>
      {feedback ? (
        <p
          className={feedback.kind === "error" ? "slack-connect__error" : "slack-connect__status"}
          role={feedback.kind === "error" ? "alert" : "status"}
        >
          {feedback.message}
        </p>
      ) : null}
    </div>
  );
}
