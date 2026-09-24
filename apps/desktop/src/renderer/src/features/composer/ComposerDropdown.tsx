import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useDismissableLayer } from "../../lib/useDismissableLayer";
import { useViewportTooltip } from "../../lib/useViewportTooltip";

/**
 * Extracted from Composer.tsx so surfaces beyond the composer footer (the
 * automation editor's execution settings) render the same chip-button
 * dropdown instead of re-styling a native select. The markup, classes, and
 * behavior are unchanged — the composer imports it from here.
 */

export type ComposerDropdownOption = {
  /**
   * Options with an inline description remain focusable with `aria-disabled`
   * so their unavailability reason can be announced. Other options retain
   * native disabled behavior, with tooltip help on the wrapping element.
   */
  disabled?: boolean;
  /** One line under the label, for a choice whose name does not explain it. */
  description?: string;
  label: string;
  tooltip?: string;
  value: string;
};

export type ComposerDropdownIcon = (props: { size?: number }) => ReactNode;

export function useDismissableMenu<T extends HTMLElement>(
  open: boolean,
  onDismiss: () => void,
) {
  const ref = useRef<T>(null);
  // A layer, so a menu open inside a modal dialog (BranchPicker in Handoff to
  // New Worktree) answers Escape before the dialog does. The dialog claims
  // the key at window capture, so the document listener below never sees it
  // there; it still closes a menu that focus has left outside any dialog.
  useDismissableLayer({ open, onDismiss, surfaceRef: ref });

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
  const [tooltipOption, setTooltipOption] = useState<string>();
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
  const getTooltipHorizontalBounds = useCallback((target: HTMLElement) => {
    const composerSetup = target.closest<HTMLElement>(".composer__setup");
    if (!composerSetup) {
      return undefined;
    }
    const { left, right } = composerSetup.getBoundingClientRect();
    return { left, right };
  }, []);
  const { tooltipId, show, showAfterDelay, hide, visible, tooltipNode } =
    useViewportTooltip({
      className: "viewport-tooltip",
      getHorizontalBounds: getTooltipHorizontalBounds,
    });

  useEffect(() => {
    if (!open) {
      hide();
    }
  }, [hide, open]);

  return (
    <div
      className={[
        "composer-dropdown",
        props.compact ? "composer-dropdown--compact" : "",
        props.kind === "branch" ? "composer-dropdown--branch" : "",
        props.tone === "danger" ? "composer-dropdown--danger" : "",
        open ? "composer-dropdown--open" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      onPointerEnter={props.onPointerEnter}
      onMouseEnter={(event) => {
        if (!open && props.tooltip) {
          showAfterDelay(event.currentTarget, props.tooltip);
        }
      }}
      onMouseLeave={hide}
      ref={ref}
    >
      <button
        aria-description={props.tooltip}
        aria-describedby={visible && !open ? tooltipId : undefined}
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
        onBlur={hide}
        onFocus={(event) => {
          if (!open && props.tooltip) {
            show(event.currentTarget, props.tooltip);
          }
        }}
        onClick={() => {
          hide();
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
              <div
                key={option.value}
                role="presentation"
                onBlur={hide}
                onFocus={(event) => {
                  if (option.tooltip) {
                    setTooltipOption(option.value);
                    show(event.currentTarget.parentElement!, option.tooltip);
                  }
                }}
                onMouseEnter={(event) => {
                  if (option.tooltip) {
                    setTooltipOption(option.value);
                    // Anchor above the whole list so help cannot cover its rows.
                    showAfterDelay(event.currentTarget.parentElement!, option.tooltip);
                  }
                }}
                onMouseLeave={hide}
              >
                <button
                  aria-description={option.tooltip}
                  aria-describedby={[
                    descriptionId,
                    visible && tooltipOption === option.value ? tooltipId : undefined,
                  ].filter(Boolean).join(" ") || undefined}
                  aria-disabled={option.disabled ? true : undefined}
                  disabled={option.disabled && !option.description}
                  aria-selected={option.value === props.value}
                  className="composer-dropdown__option"
                  role="option"
                  type="button"
                  onClick={() => {
                    // Described options stay focusable so their reason is reachable.
                    // They need this guard in addition to aria-disabled.
                    if (option.disabled) {
                      return;
                    }
                    hide();
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
              </div>
            );
          })}
        </div>
      ) : null}
      {tooltipNode}
    </div>
  );
}
