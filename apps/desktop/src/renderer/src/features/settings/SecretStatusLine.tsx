import { useEffect, useRef, useState } from "react";
import { SettingsPendingIndicator } from "./SettingsLayout";
import type { SecretFieldTone, SecretStatusView } from "./secret-field-state";

/**
 * Whether a secret is stored, on its own line under the box the value is
 * pasted into. Every secret input draws it through this component, so the
 * words, the mark and the tones cannot drift between copies. It used to be a
 * placeholder ("Stored", "Stored encrypted"), a pill, or a sentence in the
 * field's description, a column away, depending on who wrote the form.
 *
 * Its parent wraps (`settings-secret--status`) or stacks, and the line takes
 * the full width either way.
 */
export function SecretStatusLine(props: {
  view: SecretStatusView;
  /** Referenced by the input's `aria-describedby`. */
  id?: string;
  /** A write is out: the line shows the pending ring instead. */
  pending?: boolean;
  /**
   * The answer to an operator's action: mounted as a new live region so it
   * is announced, which a changed text node is not.
   */
  announce?: boolean;
}) {
  if (props.pending) {
    return (
      <span className="settings-secret__status" id={props.id}>
        <SettingsPendingIndicator pending />
      </span>
    );
  }
  return (
    <span
      key={props.announce ? "announce" : "state"}
      className={`settings-secret__status is-${props.view.tone}`}
      id={props.id}
      role={props.announce ? "status" : undefined}
    >
      <SecretStatusMark tone={props.view.tone} />
      {props.view.status}
    </span>
  );
}

function SecretStatusMark(props: { tone: SecretFieldTone }) {
  return (
    <svg
      aria-hidden="true"
      className="settings-secret__mark"
      fill="none"
      height="14"
      viewBox="0 0 14 14"
      width="14"
    >
      {props.tone === "set" ? (
        <>
          <circle cx="7" cy="7" fill="currentColor" r="6.5" />
          <path
            className="settings-secret__mark-tick"
            d="M4.2 7.3l1.9 1.9 3.7-4"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.6"
          />
        </>
      ) : props.tone === "unset" ? (
        <circle cx="7" cy="7" r="5.75" stroke="currentColor" strokeWidth="1.5" />
      ) : (
        <circle cx="7" cy="7" fill="currentColor" r="4" />
      )}
    </svg>
  );
}

/**
 * The confirmation step of a Remove that deletes a stored value at once.
 * The first click asks, on the status line; a second explicit click removes,
 * and Keep backs out. Focus moves to Keep, the choice that loses nothing, so
 * Enter pressed twice does not delete.
 *
 * Forms that only mark a value for removal until their own Save do not use
 * this: Save is their confirmation, and Keep undoes the mark before it.
 */
export function useSecretRemoveConfirm(
  /**
   * Something is stored to remove. A question left open when the value goes
   * away (removed from another window) is dropped, so it cannot come back
   * by itself over a value stored later.
   */
  removable: boolean,
) {
  const [confirming, setConfirming] = useState(false);
  if (confirming && !removable) setConfirming(false);
  const keepRef = useRef<HTMLButtonElement>(null);
  const removeRef = useRef<HTMLButtonElement>(null);
  // Keep unmounts the button that had focus; Remove gets it back.
  const refocusRemove = useRef(false);
  useEffect(() => {
    if (confirming) keepRef.current?.focus();
    else if (refocusRemove.current) {
      refocusRemove.current = false;
      removeRef.current?.focus();
    }
  }, [confirming]);
  return {
    confirming,
    keepRef,
    removeRef,
    ask: () => setConfirming(true),
    /** Keep: back out and return focus to Remove. */
    keep: () => {
      refocusRemove.current = true;
      setConfirming(false);
    },
    /** Typing or removing ends the question without moving focus. */
    cancel: () => setConfirming(false),
  };
}
