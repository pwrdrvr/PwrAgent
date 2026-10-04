import { useRef, useState, type ReactNode } from "react";
import type {
  DesktopSettingsSecretName,
  DesktopSettingsSecretState,
} from "@pwragent/shared";
import { SettingsField, SettingsPendingIndicator } from "./SettingsLayout";
import { formatSourceLabel } from "./settings-fields";

/**
 * A secret's row: write-only input (the stored value is never read back),
 * where it comes from, and Save / Discard / Clear. Shared by Messaging and
 * AI Providers.
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
  // Blur and a Save click land together when the click moves focus out of the
  // input; state would not show the first write until the next render.
  const writingRef = useRef(false);
  const dirty = value.length > 0;
  const status = props.state.configured ? "Set" : "Not set";
  const source = formatSourceLabel(props.state.source, props.state.overriddenByEnv);

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
      source={`${status} · ${source}`}
      error={invalid ?? props.state.unavailableReason}
      control={
        <div
          className="settings-secret"
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
            aria-label={props.label}
            aria-invalid={invalid ? true : undefined}
            className="settings-input"
            disabled={props.disabled}
            placeholder="••••••••"
            type="password"
            value={value}
            onChange={(event) => {
              setValue(event.currentTarget.value);
              setInvalid(undefined);
              setSaved(false);
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
          <button
            className="button button--secondary"
            disabled={props.disabled || !value.trim()}
            type="button"
            onClick={() => {
              void save();
            }}
          >
            Save
          </button>
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
          ) : null}
          <button
            className="button button--ghost"
            disabled={props.disabled || props.state.source === "env"}
            type="button"
            onClick={() => {
              setSaved(false);
              void props.onClearSecret(props.secret);
            }}
          >
            Clear
          </button>
          {writing ? (
            <SettingsPendingIndicator pending />
          ) : saved && !dirty ? (
            <span className="settings-pending" role="status">
              Saved
            </span>
          ) : null}
        </div>
      }
    />
  );
}
