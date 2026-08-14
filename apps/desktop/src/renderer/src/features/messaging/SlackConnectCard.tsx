import { useState } from "react";
import { copyText } from "../../lib/copy-text";
import type { DesktopApi } from "../../lib/desktop-api";
import {
  SLACK_ADMIN_APPROVAL_COPY,
  SLACK_CONNECT_CHECKLIST,
} from "./slack-connect-copy";

export function SlackConnectCard(props: {
  desktopApi?: DesktopApi;
  variant: "settings" | "onboarding";
}) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const canOpen = Boolean(props.desktopApi?.openSlackCreateApp);

  const run = async (open: boolean): Promise<void> => {
    if (!props.desktopApi?.openSlackCreateApp || busy) return;
    setBusy(true);
    setError(undefined);
    setStatus(undefined);
    try {
      const result = await props.desktopApi.openSlackCreateApp({ open });
      if (open && result.oversized) {
        await copyText(result.manifestJson, props.desktopApi);
        setStatus(
          "The Slack create URL was too long, so the official manifest was copied. Open Slack, choose From a manifest, and paste it.",
        );
        return;
      }
      if (open) {
        setStatus("Opened Slack in your browser. Finish the checklist, then paste both tokens.");
        return;
      }
      await copyText(result.url, props.desktopApi);
      setStatus(
        result.oversized
          ? "Copied the bare Slack create-app link. The official manifest is too long for the URL; send the owner the copied link and the manifest JSON."
          : "Copied the Create Slack app link. Send it to a Workspace Owner if only they can install unpublished apps.",
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={`slack-connect slack-connect--${props.variant}`}
      data-testid="slack-connect-card"
    >
      <div className="slack-connect__intro">
        Create a customer-owned Slack app from PwrAgent&rsquo;s official
        manifest. Socket Mode stays on your computer — no PwrAgent Slack
        app, and no client secret in this desktop build.
      </div>
      <div className="slack-connect__actions">
        <button
          type="button"
          className={
            props.variant === "onboarding"
              ? "onboarding-wizard__btn onboarding-wizard__btn--ghost"
              : "button button--secondary"
          }
          disabled={busy || !canOpen}
          onClick={() => {
            void run(true);
          }}
        >
          {busy ? "Opening…" : "Create Slack app"}
        </button>
        <button
          type="button"
          className={
            props.variant === "onboarding"
              ? "onboarding-wizard__btn onboarding-wizard__btn--link"
              : "button button--ghost"
          }
          disabled={busy || !canOpen}
          onClick={() => {
            void run(false);
          }}
        >
          Copy Create Slack app link
        </button>
      </div>
      <ol className="slack-connect__checklist">
        {SLACK_CONNECT_CHECKLIST.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <p className="slack-connect__admin">{SLACK_ADMIN_APPROVAL_COPY}</p>
      {status ? (
        <p className="slack-connect__status" role="status">
          {status}
        </p>
      ) : null}
      {error ? (
        <p className="slack-connect__error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
