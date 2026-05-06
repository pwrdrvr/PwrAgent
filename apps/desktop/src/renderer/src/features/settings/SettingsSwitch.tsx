/**
 * Track-and-thumb switch primitive used by every settings toggle.
 * Replaces native `<input type="checkbox">` so we get a calmer visual
 * register that matches the rest of the v2 design (track + thumb +
 * "On"/"Off" word; accent-tinted when on).
 *
 * Rendered as `<button role="switch">` so screen readers and tests
 * still recognize it as a toggle. Space and Enter naturally activate
 * the button (browser default).
 */
export function SettingsSwitch(props: {
  checked: boolean;
  disabled?: boolean;
  /** Used for `aria-label` and the visible "On"/"Off" word. */
  label: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      aria-checked={props.checked}
      aria-label={props.label}
      className={`settings-switch${props.checked ? " is-on" : ""}`}
      disabled={props.disabled}
      role="switch"
      type="button"
      onClick={() => props.onChange(!props.checked)}
    >
      <span aria-hidden="true" className="settings-switch__track">
        <span className="settings-switch__thumb" />
      </span>
      <span aria-hidden="true">{props.checked ? "On" : "Off"}</span>
    </button>
  );
}
