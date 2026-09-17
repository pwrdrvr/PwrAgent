import { useEffect, useRef, useState } from "react";
import { copyText } from "../../lib/copy-text";
import type { DesktopApi } from "../../lib/desktop-api";

type SettingsCopyValueProps = {
  /** Rendered in the code pill. */
  value: string;
  /** Copied to the clipboard; callbacks run at click time. Defaults to `value`. */
  copyValue?: string | (() => string);
  desktopApi?: DesktopApi;
  label?: string;
  /**
   * Drop the pill and the button's chrome, for a value that is a row's
   * secondary line rather than the thing the row is about.
   *
   * The default treatment is sized to be the control in a `SettingsField`. In
   * a list row -- where the value sits under a title and beside the row's own
   * actions -- it outweighs the name above it and adds a fourth button to a
   * row that already has three. Same behaviour and the same acknowledgement,
   * quieter presentation: a copy is a copy wherever it is offered, and one
   * component is what keeps the wording and the 1.5s reset from drifting.
   */
  compact?: boolean;
};

/**
 * A monospaced value with a Copy button — for things an operator needs to hand
 * to someone else verbatim (process ids, diagnostic paths). Mirrors the
 * code-pill + Copy pattern already used by the messaging pairing rows.
 */
export function SettingsCopyValue(props: SettingsCopyValueProps) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<number | undefined>(undefined);

  useEffect(
    () => () => {
      window.clearTimeout(resetTimer.current);
    },
    [],
  );

  return (
    <div
      className={`settings-copyvalue${
        props.compact ? " settings-copyvalue--compact" : ""
      }`}
    >
      {/* Only the compact variant ellipsizes, so only it needs the value
          back on hover. On the pill the text is already fully visible and a
          tooltip repeating it is noise. */}
      <code
        className="settings-copyvalue__value"
        {...(props.compact ? { title: props.value } : {})}
      >
        {props.value}
      </code>
      <button
        type="button"
        className={`button button--ghost${
          props.compact ? " settings-copyvalue__button--compact" : ""
        }`}
        aria-label={props.label ? `Copy ${props.label}` : undefined}
        onClick={() => {
          const copyValue = typeof props.copyValue === "function"
            ? props.copyValue()
            : props.copyValue ?? props.value;
          void copyText(copyValue, props.desktopApi).then(
            () => {
              setCopied(true);
              window.clearTimeout(resetTimer.current);
              resetTimer.current = window.setTimeout(
                () => setCopied(false),
                1500,
              );
            },
            // A clipboard write can be refused -- no permission, an unfocused
            // document. Staying on "Copy" is the honest answer: the operator
            // cannot see a clipboard, so a button that silently did nothing
            // and a button that worked looked identical.
            () => setCopied(false),
          );
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
