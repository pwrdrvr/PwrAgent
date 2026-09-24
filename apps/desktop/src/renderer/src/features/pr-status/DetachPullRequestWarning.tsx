import { useRef, useState } from "react";
import type { PrSummary } from "@pwragent/shared";
import { useDialogFocus } from "../../lib/useDialogFocus";

const DETACH_PR_WARNING_DISMISSED_KEY = "pwragent.detachPrWarning.dismissed";

export function shouldShowDetachPullRequestWarning(): boolean {
  try {
    return window.localStorage.getItem(DETACH_PR_WARNING_DISMISSED_KEY) !== "1";
  } catch {
    return true;
  }
}

function rememberDetachPullRequestWarningDismissed(): void {
  try {
    window.localStorage.setItem(DETACH_PR_WARNING_DISMISSED_KEY, "1");
  } catch {
    // Local storage can be unavailable in hardened/browser test contexts.
  }
}

type DetachPullRequestWarningProps = {
  pr: PrSummary;
  onCancel: () => void;
  onConfirm: () => void;
  /** Where focus returns when the dialog opened from a menu item. */
  returnFocus?: () => HTMLElement | null | undefined;
};

export function DetachPullRequestWarning(props: DetachPullRequestWarningProps) {
  const [dontShowAgain, setDontShowAgain] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  // Cancel, not Detach: the destructive action is never the default.
  useDialogFocus(dialogRef, true, {
    initialFocus: cancelRef,
    onEscape: props.onCancel,
    returnFocus: props.returnFocus,
  });
  const prLabel = `${props.pr.org}/${props.pr.repo}#${props.pr.number}`;

  return (
    <div
      className="pr-detach-warning-modal"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          props.onCancel();
        }
      }}
    >
      <div
        ref={dialogRef}
        aria-labelledby="pr-detach-warning-title"
        aria-modal="true"
        className="pr-detach-warning-dialog"
        role="dialog"
      >
        <h2 id="pr-detach-warning-title">Detach pull request?</h2>
        <p>
          This removes {prLabel} from this thread's PR list. It does not close,
          archive, or modify the pull request on its provider.
        </p>
        <label className="composer__checkbox pr-detach-warning-dialog__checkbox">
          <input
            checked={dontShowAgain}
            type="checkbox"
            onChange={(event) => setDontShowAgain(event.currentTarget.checked)}
          />
          <span>Don't show me this again</span>
        </label>
        <div className="pr-detach-warning-dialog__actions">
          <button ref={cancelRef} type="button" onClick={props.onCancel}>
            Cancel
          </button>
          <button
            className="button--danger"
            type="button"
            onClick={() => {
              if (dontShowAgain) {
                rememberDetachPullRequestWarningDismissed();
              }
              props.onConfirm();
            }}
          >
            Detach PR
          </button>
        </div>
      </div>
    </div>
  );
}
