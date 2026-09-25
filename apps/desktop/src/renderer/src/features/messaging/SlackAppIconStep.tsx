import { useState } from "react";
import type { DesktopApi } from "../../lib/desktop-api";
// The full-bleed master, not a copy: the padded macOS variants are the wrong
// mark outside macOS, and a renderer copy would drift from the shipped icon.
import pwragentAppIcon from "../../../../../build/icon.png";

/**
 * Slack's manifest has no icon field, and the only API that sets one works
 * for apps created through a Slack "manager" app, which a customer-owned app
 * is not. So the icon is one drag, offered in the Create step: creating the
 * app leaves the operator on its Basic Information page, which takes it.
 */
export function SlackAppIconStep(props: {
  desktopApi?: DesktopApi;
  variant: "settings" | "onboarding";
}) {
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
      <span className="slack-connect__label">App icon · optional</span>
      <p className="slack-connect__step">
        After <strong>Create</strong>, Slack opens your app&rsquo;s{" "}
        <strong>Basic Information</strong> page. Under{" "}
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
          className={
            props.variant === "onboarding"
              ? "onboarding-wizard__btn onboarding-wizard__btn--ghost"
              : "button button--secondary"
          }
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
