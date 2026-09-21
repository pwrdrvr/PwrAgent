import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";

/**
 * Extracted from Composer.tsx so surfaces beyond the composer footer (the
 * automation editor's execution settings) render the same chip-button
 * dropdown instead of re-styling a native select. The markup, classes, and
 * behavior are unchanged — the composer imports it from here.
 */

export type ComposerDropdownOption = {
  /**
   * Marked unselectable, but still focusable and still announced — the
   * attribute is `aria-disabled`, not `disabled`. A native disabled button
   * receives no pointer events and leaves the tab order, so an option that
   * carried one had no gesture that could ever produce the reason it was
   * unavailable. Callers put that reason in `description`.
   */
  disabled?: boolean;
  /** One line under the label, for a choice whose name does not explain it. */
  description?: string;
  label: string;
  value: string;
};

export type ComposerDropdownIcon = (props: { size?: number }) => ReactNode;

export function useDismissableMenu<T extends HTMLElement>(
  open: boolean,
  onDismiss: () => void,
) {
  const ref = useRef<T>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    const handlePointerDown = (event: PointerEvent): void => {
      if (!ref.current?.contains(event.target as Node)) {
        onDismiss();
      }
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onDismiss();
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onDismiss, open]);

  return ref;
}

export function ComposerDropdown(props: {
  ariaLabel: string;
  compact?: boolean;
  disabled?: boolean;
  icon?: ComposerDropdownIcon;
  id?: string;
  kind?: "branch";
  tone?: "danger";
  onChange: (value: string) => void;
  onOpenChange?: (open: boolean) => void;
  onPointerEnter?: () => void;
  options: ComposerDropdownOption[];
  tooltip?: string;
  value: string;
}) {
  const [open, setOpen] = useState(false);
  const listboxId = useId();
  const onOpenChange = props.onOpenChange;
  const selectedOption =
    props.options.find((option) => option.value === props.value) ?? props.options[0];
  const closeMenu = useCallback((): void => {
    setOpen(false);
    onOpenChange?.(false);
  }, [onOpenChange]);
  const ref = useDismissableMenu<HTMLDivElement>(open, closeMenu);
  const Icon = props.icon;

  return (
    <div
      className={[
        "composer-dropdown",
        props.compact ? "composer-dropdown--compact" : "",
        props.kind === "branch" ? "composer-dropdown--branch" : "",
        props.tone === "danger" ? "composer-dropdown--danger" : "",
        props.tooltip ? "tooltip-target" : "",
        open ? "composer-dropdown--open" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-tooltip={props.tooltip}
      onPointerEnter={props.onPointerEnter}
      ref={ref}
    >
      <button
        aria-description={props.tooltip}
        aria-controls={open ? listboxId : undefined}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={props.ariaLabel}
        className="composer-dropdown__button"
        data-value={props.value}
        disabled={props.disabled || props.options.length === 0}
        id={props.id}
        type="button"
        value={props.value}
        onClick={() => {
          const nextOpen = !open;
          setOpen(nextOpen);
          onOpenChange?.(nextOpen);
        }}
      >
        {Icon ? (
          <span aria-hidden="true" className="composer-dropdown__icon">
            <Icon size={13} />
          </span>
        ) : null}
        <span className="composer-dropdown__label">
          {selectedOption?.label ?? props.value}
        </span>
      </button>
      {/* The listbox carries its own name: the trigger's label does not reach
          it through `aria-controls`, and an unnamed one is an axe
          `aria-input-field-name` failure on every dropdown in the app. */}
      {open ? (
        <div
          aria-label={props.ariaLabel}
          className="composer-dropdown__menu"
          id={listboxId}
          role="listbox"
        >
          {props.options.map((option, index) => {
            // Indexed rather than keyed on the value: other callers use branch
            // names and model ids as values, which are not safe id fragments.
            const descriptionId = option.description
              ? `${listboxId}-description-${index}`
              : undefined;
            return (
              <button
                aria-describedby={descriptionId}
                aria-disabled={option.disabled ? true : undefined}
                aria-selected={option.value === props.value}
                className="composer-dropdown__option"
                key={option.value}
                role="option"
                type="button"
                onClick={() => {
                  // Guarded rather than `disabled`: the option stays focusable
                  // and hoverable so its description is reachable.
                  if (option.disabled) {
                    return;
                  }
                  closeMenu();
                  if (option.value !== props.value) {
                    props.onChange(option.value);
                  }
                }}
              >
                {option.value === props.value ? (
                  <span aria-hidden="true" className="composer-dropdown__check">
                    ✓
                  </span>
                ) : (
                  <span aria-hidden="true" className="composer-dropdown__check" />
                )}
                <span className="composer-dropdown__option-body">
                  <span className="composer-dropdown__option-label">{option.label}</span>
                  {option.description ? (
                    // Hidden from name-from-content so the option is still
                    // named by its label alone; aria-describedby reaches
                    // through aria-hidden to announce it as the description.
                    <span
                      aria-hidden="true"
                      className="composer-dropdown__option-description"
                      id={descriptionId}
                    >
                      {option.description}
                    </span>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
