import { useEffect, useRef, useState } from "react";
import { copyText } from "../../lib/copy-text";
import type { DesktopApi } from "../../lib/desktop-api";

type SettingsCopyValueProps = {
  /** Rendered in the code pill. */
  value: string;
  /** Copied to the clipboard; defaults to `value`. */
  copyValue?: string;
  desktopApi?: DesktopApi;
  label?: string;
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
    <div className="settings-copyvalue">
      <code className="settings-copyvalue__value">{props.value}</code>
      <button
        type="button"
        className="button button--ghost"
        aria-label={props.label ? `Copy ${props.label}` : undefined}
        onClick={() => {
          void copyText(props.copyValue ?? props.value, props.desktopApi).then(
            () => {
              setCopied(true);
              window.clearTimeout(resetTimer.current);
              resetTimer.current = window.setTimeout(
                () => setCopied(false),
                1500,
              );
            },
          );
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
