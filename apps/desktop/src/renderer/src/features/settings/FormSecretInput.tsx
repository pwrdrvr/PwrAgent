import { useId } from "react";
import { SecretStatusLine } from "./SecretStatusLine";
import type { describeFormSecret } from "./secret-field-state";

/**
 * A secret's box inside a form that writes on its own Save button: the
 * input, Remove or Keep beside it, and the status line under it. The model
 * provider's key, a GitHub token, an MCP session token and Federation's
 * edge credentials each drew their own copy, which is how their words
 * drifted apart.
 *
 * Remove only marks the stored value; the form's Save deletes it, so it asks
 * nothing further, and Keep undoes the mark. `describeFormSecret` decides
 * the words, the placeholder and whether Remove is offered.
 */
export function FormSecretInput(props: {
  /** The input's accessible name: the field's visible label. */
  label: string;
  /** Names the stored value in Remove's and Keep's accessible names. */
  valueName?: string;
  view: ReturnType<typeof describeFormSecret>;
  value: string;
  disabled?: boolean;
  multiline?: boolean;
  /** The stored value is marked for removal: the box is disabled. */
  removing?: boolean;
  onChange: (value: string) => void;
  /** Mark the stored value for removal, or unmark it. Omit for no Remove. */
  onRemove?: (remove: boolean) => void;
}) {
  const statusId = useId();
  const valueName = props.valueName ?? props.label;
  const shared = {
    "aria-describedby": statusId,
    "aria-label": props.label,
    autoComplete: "off",
    disabled: props.disabled || props.removing,
    placeholder: props.view.placeholder,
    spellCheck: false,
    value: props.value,
  };
  return (
    <div className="settings-secret settings-secret--status">
      {props.multiline ? (
        <textarea
          {...shared}
          className="settings-input settings-input--multiline"
          rows={3}
          onChange={(event) => props.onChange(event.target.value)}
        />
      ) : (
        <input
          {...shared}
          autoCapitalize="off"
          className="settings-input"
          type="password"
          onChange={(event) => props.onChange(event.target.value)}
        />
      )}
      {props.onRemove && props.view.canRemove ? (
        <button
          aria-label={`Remove saved ${valueName}`}
          className="button button--ghost"
          disabled={props.disabled}
          type="button"
          onClick={() => props.onRemove!(true)}
        >
          Remove
        </button>
      ) : props.onRemove && props.removing ? (
        <button
          aria-label={`Keep saved ${valueName}`}
          className="button button--ghost"
          disabled={props.disabled}
          type="button"
          onClick={() => props.onRemove!(false)}
        >
          Keep
        </button>
      ) : null}
      <SecretStatusLine id={statusId} view={props.view} />
    </div>
  );
}
