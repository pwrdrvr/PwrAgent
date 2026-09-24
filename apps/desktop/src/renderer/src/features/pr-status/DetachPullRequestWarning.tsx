import { useRef, useState, type RefObject } from "react";
import type { PrSummary } from "@pwragent/shared";
import { useModalDialog } from "../../lib/useModalDialog";

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
  /**
   * Where focus goes when the dialog closes. The menu item that opened it is
   * gone by then, and the PR chip that opened that menu is not marked as its
   * trigger.
   */
  returnFocus?: RefObject<HTMLElement | null>;
};

export function DetachPullRequestWarning(props: DetachPullRequestWarningProps) {
  const [dontShowAgain, setDontShowAgain] = useState(false);
  const prLabel = `${props.pr.org}/${props.pr.repo}#${props.pr.number}`;
  // Cancel, not the first control: this confirms a destructive action, so
  // focus starts on the choice that changes nothing.
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useModalDialog({
    onClose: props.onCancel,
    initialFocus: cancelRef,
    ...(props.returnFocus === undefined ? {} : { returnFocus: props.returnFocus }),
  });

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
