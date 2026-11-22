import { useId, useRef, useState, type ReactNode } from "react";
import type {
  DesktopSettingsSecretName,
  DesktopSettingsSecretState,
} from "@pwragent/shared/contracts/settings";
import { SettingsField } from "./SettingsLayout";
import { SecretStatusLine, useSecretRemoveConfirm } from "./SecretStatusLine";
import { describeSecretField } from "./secret-field-state";

/**
 * A secret's row: write-only input (the stored value is never read back),
 * whether a value is stored, and Save / Discard / Remove. Shared by Messaging
 * and AI Providers. `describeSecretField` decides what each state shows.
 * Remove asks once before it deletes: the value cannot be shown again.
 */
export function SecretField(props: {
  disabled?: boolean;
  label: string;
  sub?: ReactNode;
  help?: ReactNode;
  secret: DesktopSettingsSecretName;
  state: DesktopSettingsSecretState;
  /**
   * Optional generator. When provided, a "Generate" button appears
   * that fills the input with the produced value. Used by the Mattermost HMAC field
   * so users don't have to leave the app to run openssl.
   */
  onGenerate?: () => string;
  /**
   * Rejects a draft before it is written, with the message to show. The draft
   * stays in the box for correction. Blur saves without a click, so a token
   * pasted into the wrong box would otherwise be stored as the other one.
   */
  validate?: (value: string) => string | undefined;
  onClearSecret: (secret: DesktopSettingsSecretName) => Promise<boolean>;
  onReplaceSecret: (
    secret: DesktopSettingsSecretName,
    value: string,
  ) => Promise<boolean>;
}) {
  const [value, setValue] = useState("");
  const [invalid, setInvalid] = useState<string | undefined>(undefined);
  const [writing, setWriting] = useState(false);
  const [saved, setSaved] = useState(false);
  const statusId = useId();
  // Blur and a Save click land together when the click moves focus out of the
  // input; state would not show the first write until the next render.
  const writingRef = useRef(false);
  const dirty = value.length > 0;
  // A write this row made stops vouching for the value once the store says
  // it is gone, removed from another window or dropped by the keychain.
  const [wasConfigured, setWasConfigured] = useState(props.state.configured);
  if (wasConfigured !== props.state.configured) {
    setWasConfigured(props.state.configured);
    if (!props.state.configured) setSaved(false);
  }
  // As `describeSecretField` decides `canRemove`.
  const removal = useSecretRemoveConfirm(
    (props.state.configured || saved) && props.state.source !== "env",
  );
  const view = describeSecretField(props.state, {
    dirty: value.trim().length > 0,
    saved,
    confirmingRemove: removal.confirming,
  });
  const confirming = removal.confirming && view.canRemove && !dirty;
  const announce = (saved && !dirty) || confirming;

  const save = async (): Promise<void> => {
    const nextValue = value.trim();
    if (!nextValue || props.disabled || writingRef.current) return;
    const problem = props.validate?.(nextValue);
    setInvalid(problem);
    if (problem) return;
    writingRef.current = true;
    setWriting(true);
    try {
      if (await props.onReplaceSecret(props.secret, nextValue)) {
        // Keep anything typed while the write was out.
        setValue((current) => (current.trim() === nextValue ? "" : current));
        setSaved(true);
      }
    } finally {
      writingRef.current = false;
      setWriting(false);
    }
  };

  return (
    <SettingsField
      label={props.label}
      sub={props.sub}
      help={props.help}
      error={invalid ?? props.state.unavailableReason}
      control={
        <div
          className="settings-secret settings-secret--status"
          onBlur={(event) => {
            // A pasted value is saved on the way out. Operators pasted a
            // token, moved on, and the adapter never started, because the
            // draft only reached the keychain through Save. Focus moving to
            // this row's own buttons is not leaving it: Discard must not
            // store the draft it is about to throw away.
            if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
              return;
            }
            void save();
          }}
        >
          <input
            aria-describedby={statusId}
            aria-label={props.label}
            aria-invalid={invalid ? true : undefined}
            className="settings-input"
            disabled={props.disabled}
            placeholder={view.placeholder}
            type="password"
            value={value}
            onChange={(event) => {
              setValue(event.currentTarget.value);
              setInvalid(undefined);
              setSaved(false);
              removal.cancel();
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void save();
              }
            }}
          />
          {props.onGenerate ? (
            <button
              className="button button--ghost"
              disabled={props.disabled}
              type="button"
              onClick={() => {
                setValue(props.onGenerate!());
                setInvalid(undefined);
                setSaved(false);
              }}
            >
              Generate
            </button>
          ) : null}
          {/* Asking to remove, the row has nothing to save, and the
              question's two buttons take the commit button's place. */}
          {confirming ? null : (
            <button
              className={
                view.commitIsPrimary
                  ? "button button--primary"
                  : "button button--secondary"
              }
              disabled={props.disabled || !value.trim()}
              type="button"
              onClick={() => {
                void save();
              }}
            >
              {view.commitLabel}
            </button>
          )}
          {dirty ? (
            <button
              className="button button--ghost"
              disabled={props.disabled}
              type="button"
              onClick={() => {
                setValue("");
                setInvalid(undefined);
              }}
            >
              Discard
            </button>
          ) : confirming ? (
            <>
              <button
                aria-label={`Remove saved ${props.label} now`}
                className="button button--secondary"
                disabled={props.disabled}
                type="button"
                onClick={() => {
                  removal.cancel();
                  setSaved(false);
                  void props.onClearSecret(props.secret);
                }}
              >
                Remove
              </button>
              <button
                ref={removal.keepRef}
                aria-label={`Keep saved ${props.label}`}
                className="button button--ghost"
                disabled={props.disabled}
                type="button"
                onClick={removal.keep}
              >
                Keep
              </button>
            </>
          ) : view.canRemove ? (
            <button
              ref={removal.removeRef}
              aria-label={`Remove saved ${props.label}`}
              className="button button--ghost"
              disabled={props.disabled}
              type="button"
              onClick={removal.ask}
            >
              Remove
            </button>
          ) : null}
          {/* The stored state sits under the box the value was pasted into.
              It used to be a 10px pill under the description, a column away,
              and an empty box drew bullets either way. */}
          <SecretStatusLine
            announce={announce}
            id={statusId}
            pending={writing}
            view={view}
          />
        </div>
      }
    />
  );
}
