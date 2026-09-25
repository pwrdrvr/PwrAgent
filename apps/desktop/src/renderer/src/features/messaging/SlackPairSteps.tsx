import { useState } from "react";
import type { DesktopApi } from "../../lib/desktop-api";

/**
 * How to reach the app to pair. "Send it in a DM" was not enough: Slack lists
 * a new app under Apps, not with direct messages, and opening it lands on its
 * Home tab, so the operator also has to find the Messages tab.
 */
export function SlackPairSteps(props: {
  /** The saved agent name, which is what Slack lists the app as. */
  appName: string | undefined;
}) {
  const app = props.appName ? <strong>{props.appName}</strong> : "your app";
  return (
    <ol className="slack-connect__checklist">
      <li>
        Click <strong>Generate</strong>. PwrAgent copies a pairing message.
      </li>
      <li>
        Click <strong>Open in Slack</strong> to open a direct message with{" "}
        {app}. Or, in Slack, find {app} under <strong>Apps</strong> in the
        sidebar and switch to its <strong>Messages</strong> tab.
      </li>
      <li>Paste the message and send it.</li>
      <li>Approve the request that appears here.</li>
    </ol>
  );
}

/** Opens a direct message with the connected app through Slack's redirect. */
export function SlackOpenAppMessagesButton(props: {
  desktopApi?: DesktopApi;
  disabled?: boolean;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const openMessages = props.desktopApi?.openSlackAppMessages;

  const open = async (): Promise<void> => {
    if (!openMessages) return;
    setPending(true);
    setError(undefined);
    try {
      await openMessages();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className="button button--secondary"
        disabled={props.disabled || pending || !openMessages}
        onClick={() => {
          void open();
        }}
      >
        {pending ? "Opening…" : "Open in Slack"}
      </button>
      {error ? (
        <p className="slack-connect__error settings-pairing__action-note" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}
