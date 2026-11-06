import { CheckIcon } from "../../icons";

/**
 * The review panel's Auto-fix findings switch, in the composer and in Star
 * Map's Start review card. On, the thread's own agent settles the findings
 * when the review lands.
 */
export function ReviewAutoFixSwitch(props: {
  checked: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      className="composer__review-after tooltip-target"
      data-tooltip="When the review finishes, this thread's agent decides which findings to fix, defer to a to-do, or decline"
      disabled={props.disabled}
      onClick={props.onToggle}
    >
      <span aria-hidden="true" className="composer__review-after-box">
        {props.checked ? <CheckIcon size={11} /> : null}
      </span>
      Auto-fix findings
    </button>
  );
}
