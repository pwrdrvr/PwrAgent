import { useId, useRef, useState } from "react";
import type { DesktopSettingsValue } from "@pwragent/shared";

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

/**
 * The name Slack shows after @. Slack lists every teammate's PwrAgent as
 * "PwrAgent" unless each is renamed, and renaming later means editing the
 * app's manifest, so the name is chosen before the manifest is built.
 *
 * The box starts on main's suggestion, which is not yet a choice: a blur
 * saves only an edit, and the suggestion is taken with the button or Enter.
 */
export function SlackAppNameField(props: {
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
      <label className="slack-connect__label" htmlFor={inputId}>
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
