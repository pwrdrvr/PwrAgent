import { useEffect, useId, useRef, useState } from "react";
import type { DesktopSettingsValue } from "@pwragent/shared";
import { copyText } from "../../lib/copy-text";
import type { DesktopApi } from "../../lib/desktop-api";
import {
  SLACK_ADMIN_APPROVAL_COPY,
  SLACK_CONNECT_CHECKLIST,
  SLACK_MANIFEST_BLURB,
  SLACK_MANIFEST_UPDATE_STEPS,
} from "./slack-connect-copy";

/**
 * Which action is in flight, or which one last wrote to the clipboard.
 * Tracked per action rather than as one `busy` boolean: a shared flag put
 * the pending label on whichever button rendered it first, so pressing
 * "Update existing Slack app" made the *Create Slack app* button read
 * "Opening…" while the pressed control merely greyed out.
 */
type SlackConnectAction = "create" | "link" | "manifest" | "openApps";

/** Feedback belongs to the action that produced it so it can render beside
 *  that control. The single bottom-of-card status line put the manifest
 *  acknowledgement 119px below the button that caused it, behind a
 *  checklist describing an unrelated path. */
type SlackConnectFeedback = {
  action: SlackConnectAction;
  kind: "status" | "error";
  message: string;
};

/** Matches `SettingsCopyValue` so a copy acknowledgement reads and times
 *  out identically everywhere in Settings. */
const COPIED_RESET_MS = 1500;

function formatManifestSize(manifestJson: string): string {
  const bytes = new TextEncoder().encode(manifestJson).length;
  // Bytes below a kilobyte round to "0.0 KB", which reads as a failed copy.
  // The shipped manifest is comfortably multi-KB; a stub or a future trimmed
  // document is not.
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/** Slack's app-name limit. Main enforces the same one. */
const SLACK_APP_NAME_MAX_LENGTH = 35;

export function slackAppNameProblem(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return "Enter a name for the Slack app.";
  if (trimmed.length > SLACK_APP_NAME_MAX_LENGTH) {
    return `Slack app names are at most ${SLACK_APP_NAME_MAX_LENGTH} characters.`;
  }
  return undefined;
}

/**
 * The saved name, or undefined while only main's suggestion stands. A manifest
 * sets the name on create and again on every pasted update, so nothing that
 * carries one is offered until the operator has chosen.
 */
export function chosenSlackAppName(
  appName: DesktopSettingsValue<string> | undefined,
): string | undefined {
  return appName && appName.source !== "default" ? appName.value : undefined;
}

export function SlackConnectCard(props: {
  desktopApi?: DesktopApi;
  variant: "settings" | "onboarding";
  /** Undefined while settings load. */
  appName: DesktopSettingsValue<string> | undefined;
  onSaveAppName: (appName: string) => Promise<unknown>;
  /** A settings write is out; the name on screen may not be the saved one. */
  saving?: boolean;
}) {
  const [pending, setPending] = useState<SlackConnectAction | undefined>(
    undefined,
  );
  const [copiedAction, setCopiedAction] = useState<
    SlackConnectAction | undefined
  >(undefined);
  const [manifestSize, setManifestSize] = useState<string | undefined>(
    undefined,
  );
  const [feedback, setFeedback] = useState<SlackConnectFeedback | undefined>(
    undefined,
  );
  const copiedTimer = useRef<number | undefined>(undefined);
  const canOpen = Boolean(props.desktopApi?.openSlackCreateApp);
  const busy = pending !== undefined;
  const appName = chosenSlackAppName(props.appName);
  // A manifest built while the name is being written could carry the old one.
  const named = appName !== undefined && !props.saving;

  useEffect(
    () => () => {
      window.clearTimeout(copiedTimer.current);
    },
    [],
  );

  const markCopied = (action: SlackConnectAction): void => {
    setCopiedAction(action);
    window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(
      () => setCopiedAction(undefined),
      COPIED_RESET_MS,
    );
  };

  const start = async (
    action: SlackConnectAction,
    work: (
      openSlackCreateApp: NonNullable<DesktopApi["openSlackCreateApp"]>,
    ) => Promise<void>,
  ): Promise<void> => {
    const openSlackCreateApp = props.desktopApi?.openSlackCreateApp;
    if (!openSlackCreateApp || busy) return;
    setPending(action);
    setFeedback(undefined);
    try {
      await work(openSlackCreateApp);
    } catch (caught) {
      setFeedback({
        action,
        kind: "error",
        message: caught instanceof Error ? caught.message : String(caught),
      });
    } finally {
      setPending(undefined);
    }
  };

  const run = async (open: boolean): Promise<void> => {
    await start(open ? "create" : "link", async (openSlackCreateApp) => {
      const result = await openSlackCreateApp({ open, appName });
      if (open && result.oversized) {
        // The create URL could not carry the manifest, so the manifest —
        // not the link — is what landed on the clipboard. Acknowledge it on
        // the manifest row, which is the control that owns that payload.
        await copyText(result.manifestJson, props.desktopApi);
        setManifestSize(formatManifestSize(result.manifestJson));
        markCopied("manifest");
        setFeedback({
          action: "create",
          kind: "status",
          message:
            "The Slack create URL was too long, so the official manifest was copied. Open Slack, choose From a manifest, and paste it.",
        });
        return;
      }
      if (open) {
        setFeedback({
          action: "create",
          kind: "status",
          message:
            "Opened Slack in your browser. Create the app there, then follow the steps below.",
        });
        return;
      }
      await copyText(result.url, props.desktopApi);
      markCopied("link");
      setFeedback({
        action: "link",
        kind: "status",
        message: result.oversized
          ? "Copied the bare Slack create-app link. The official manifest is too long for the URL; send the owner the copied link and the manifest JSON."
          : "Copied the Create Slack app link. Send it to a Workspace Owner if only they can install unpublished apps.",
      });
    });
  };

  /**
   * Copy the manifest without navigating. Deliberately idempotent and
   * browser-free: the clipboard is the only place the manifest lives, and
   * the rest of the task happens in a browser where the operator will
   * plausibly copy something else. Recovery must not cost a duplicate tab.
   */
  const copyManifest = async (): Promise<void> => {
    await start("manifest", async (openSlackCreateApp) => {
      const result = await openSlackCreateApp({
        mode: "update",
        open: false,
        appName,
      });
      await copyText(result.manifestJson, props.desktopApi);
      setManifestSize(formatManifestSize(result.manifestJson));
      markCopied("manifest");
      setFeedback({
        action: "manifest",
        kind: "status",
        message: "Manifest copied to the clipboard.",
      });
    });
  };

  const openSlackApps = async (): Promise<void> => {
    await start("openApps", async (openSlackCreateApp) => {
      await openSlackCreateApp({ mode: "update", open: true });
      // Deliberately does not touch the size label: that label says what is
      // on the clipboard, and this action copies nothing. `start` cleared
      // the manifest acknowledgement, so say what happened instead of
      // leaving the row blank.
      setFeedback({
        action: "openApps",
        kind: "status",
        message: "Opened Slack Apps in your browser. Paste the manifest there.",
      });
    });
  };

  const renderFeedback = (actions: SlackConnectAction[]) => {
    if (!feedback || !actions.includes(feedback.action)) return null;
    return feedback.kind === "error" ? (
      <p className="slack-connect__error" role="alert">
        {feedback.message}
      </p>
    ) : (
      <p className="slack-connect__status" role="status">
        {feedback.message}
      </p>
    );
  };

  return (
    <div
      className={`slack-connect slack-connect--${props.variant}`}
      data-testid="slack-connect-card"
    >
      <div className="slack-connect__intro">
        Name your agent, then open Slack with PwrAgent&rsquo;s official
        manifest filled in. Pick your workspace and click{" "}
        <strong>Create</strong>. It is a customer-owned Slack app: Socket Mode
        runs from this computer, with no PwrAgent-hosted Slack app and no
        client secret in this desktop build.
      </div>
      <SlackAppNameRow
        appName={props.appName}
        disabled={props.saving}
        variant={props.variant}
        onSave={props.onSaveAppName}
      />
      <div className="slack-connect__actions">
        <button
          type="button"
          className={
            props.variant === "onboarding"
              ? "onboarding-wizard__btn onboarding-wizard__btn--ghost"
              : "button button--primary"
          }
          disabled={busy || !canOpen || !named}
          onClick={() => {
            void run(true);
          }}
        >
          {pending === "create" ? "Opening…" : "Create Slack app"}
        </button>
        <button
          type="button"
          className={
            props.variant === "onboarding"
              ? "onboarding-wizard__btn onboarding-wizard__btn--link"
              : "button button--ghost"
          }
          disabled={busy || !canOpen || !named}
          onClick={() => {
            void run(false);
          }}
        >
          {pending === "link"
            ? "Copying…"
            : copiedAction === "link"
              ? "Copied"
              : "Copy link for an admin"}
        </button>
      </div>
      {appName === undefined ? (
        <p className="slack-connect__admin">
          Choose the agent name first. Slack creates the app with it.
        </p>
      ) : null}
      {renderFeedback(["create", "link"])}
      <p className="slack-connect__admin">{SLACK_ADMIN_APPROVAL_COPY}</p>
      {/* Settings walks the rest as numbered steps beside each token box. */}
      {props.variant === "onboarding" ? (
        <ol className="slack-connect__checklist">
          {SLACK_CONNECT_CHECKLIST.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      ) : null}
      {props.variant === "settings" ? (
        <details className="slack-connect__update">
          <summary className="slack-connect__grouplabel">
            Already have a PwrAgent app? Update its manifest
          </summary>
          <p className="slack-connect__admin">
            {SLACK_MANIFEST_BLURB} The manifest carries the agent name above,
            so set it to your app&rsquo;s name first.
          </p>
          <div className="slack-connect__copyrow">
            <code className="slack-connect__manifest">
              {manifestSize
                ? `Official PwrAgent app manifest · ${manifestSize}`
                : "Official PwrAgent app manifest"}
            </code>
            <button
              type="button"
              className="button button--secondary"
              data-testid="slack-copy-manifest"
              disabled={busy || !canOpen || !named}
              onClick={() => {
                void copyManifest();
              }}
            >
              {pending === "manifest"
                ? "Copying…"
                : copiedAction === "manifest"
                  ? "Copied"
                  : "Copy manifest"}
            </button>
          </div>
          {renderFeedback(["manifest", "openApps"])}
          <div className="slack-connect__actions">
            <button
              type="button"
              className="button button--ghost"
              disabled={busy || !canOpen}
              onClick={() => {
                void openSlackApps();
              }}
            >
              {pending === "openApps" ? "Opening…" : "Open Slack Apps"}
            </button>
          </div>
          <ol className="slack-connect__checklist">
            {SLACK_MANIFEST_UPDATE_STEPS.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </details>
      ) : null}
    </div>
  );
}

/**
 * The name Slack shows after @. Slack lists every teammate's PwrAgent as
 * "PwrAgent" unless each is renamed, and renaming later means editing the
 * app's manifest, so the name is chosen before the manifest is built.
 *
 * The box starts on main's suggestion, which is not yet a choice: a blur
 * saves only an edit, and the suggestion is taken with the button or Enter.
 */
function SlackAppNameRow(props: {
  appName: DesktopSettingsValue<string> | undefined;
  disabled?: boolean;
  variant: "settings" | "onboarding";
  onSave: (appName: string) => Promise<unknown>;
}) {
  const inputId = useId();
  const hintId = useId();
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const [writing, setWriting] = useState(false);
  const [saved, setSaved] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  // Blur and a button click land together when the click moves focus out of
  // the input; state would not show the first write until the next render.
  const writingRef = useRef(false);
  const stored = props.appName?.value ?? "";
  const chosen = chosenSlackAppName(props.appName) !== undefined;
  const text = draft ?? stored;
  const edited = draft !== undefined && draft.trim() !== stored;
  const unavailable = props.disabled || props.appName === undefined;

  const save = async (): Promise<void> => {
    if (unavailable || writingRef.current) return;
    if (chosen && !edited) return;
    const nextProblem = slackAppNameProblem(text);
    setProblem(nextProblem);
    if (nextProblem) return;
    const nextName = text.trim();
    writingRef.current = true;
    setWriting(true);
    try {
      await props.onSave(nextName);
      // Keep anything typed while the write was out.
      setDraft((current) =>
        current === undefined || current.trim() === nextName ? undefined : current,
      );
      setSaved(true);
    } catch (caught) {
      setProblem(caught instanceof Error ? caught.message : String(caught));
    } finally {
      writingRef.current = false;
      setWriting(false);
    }
  };

  const onboarding = props.variant === "onboarding";
  return (
    <div className="slack-connect__name">
      <label className="slack-connect__name-label" htmlFor={inputId}>
        Agent name
      </label>
      <p className="slack-connect__admin" id={hintId}>
        What you&rsquo;ll see after @ in Slack. If teammates run PwrAgent too,
        keep your name in it, as in <code>PwrAgent - yourname</code>, so you
        can tell yours apart.
      </p>
      <div
        className="slack-connect__name-row"
        onBlur={(event) => {
          // Focus moving to the row's own button is not leaving the row.
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
            return;
          }
          if (edited) void save();
        }}
      >
        <input
          aria-describedby={problem ? `${hintId} ${inputId}-problem` : hintId}
          aria-invalid={problem ? true : undefined}
          className={onboarding ? "onboarding-wizard__input" : "settings-input"}
          disabled={unavailable}
          id={inputId}
          spellCheck={false}
          type="text"
          value={text}
          onChange={(event) => {
            setDraft(event.currentTarget.value);
            setProblem(undefined);
            setSaved(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void save();
            }
          }}
        />
        <button
          className={
            onboarding
              ? "onboarding-wizard__btn onboarding-wizard__btn--ghost"
              : "button button--secondary"
          }
          disabled={unavailable || writing || (chosen && !edited)}
          type="button"
          onClick={() => {
            void save();
          }}
        >
          {chosen ? "Save" : "Use this name"}
        </button>
        {writing ? (
          <span className="settings-pending" role="status">
            Saving…
          </span>
        ) : saved && !edited ? (
          <span className="settings-pending" role="status">
            Saved
          </span>
        ) : null}
      </div>
      {problem ? (
        <p
          className="slack-connect__error"
          id={`${inputId}-problem`}
          role="alert"
        >
          {problem}
        </p>
      ) : null}
    </div>
  );
}
