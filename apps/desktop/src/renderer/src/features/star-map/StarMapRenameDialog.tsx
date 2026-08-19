import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Rename one thread from its card kebab.
 *
 * The title is not edited in place on the card: a card is a drag handle
 * before it is anything else, and a text box that starts a drag on
 * pointerdown cannot be typed into. So the rename happens in the same
 * small centered panel the [+] intake uses, and shares its shell styles
 * for that reason.
 */
export function StarMapRenameDialog(props: {
  currentTitle: string;
  onCancel: () => void;
  onSubmit: (name: string) => void;
}) {
  const [draft, setDraft] = useState(props.currentTitle);
  const [validationError, setValidationError] = useState<string>();
  const inputRef = useRef<HTMLInputElement>(null);

  // Selected, not just focused: the operator opened this to replace a
  // generated title far more often than to append to one.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const submit = () => {
    const name = draft.trim();
    if (name.length === 0) {
      setValidationError("Thread name cannot be blank.");
      return;
    }
    props.onSubmit(name);
  };

  return createPortal(
    <div
      className="star-map-rename"
      role="dialog"
      aria-modal="true"
      aria-label={`Rename ${props.currentTitle}`}
      // Portaled to the body, but React events still travel the component
      // tree: without this the map layer's Escape would also see the key
      // and clear the selection behind the dialog.
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          props.onCancel();
        }
      }}
    >
      <button
        type="button"
        className="star-map-rename__backdrop"
        aria-label="Cancel rename"
        tabIndex={-1}
        onClick={props.onCancel}
      />
      <div className="star-map-rename__panel">
        <div className="star-map-rename__header">
          <span className="star-map-rename__title">Rename Thread</span>
          <button
            type="button"
            className="star-map-rename__close"
            aria-label="Close"
            onClick={props.onCancel}
          >
            ✕
          </button>
        </div>
        <input
          ref={inputRef}
          className="star-map-rename__input"
          aria-label="Thread name"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setValidationError(undefined);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submit();
            }
          }}
        />
        <div className="star-map-rename__footer">
          <span
            className={`star-map-rename__status${
              validationError ? " is-failed" : ""
            }`}
            role="status"
          >
            {validationError ?? ""}
          </span>
          <button
            type="button"
            className="button button--ghost"
            onClick={props.onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="button button--secondary"
            disabled={draft.trim().length === 0}
            onClick={submit}
          >
            Rename
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
