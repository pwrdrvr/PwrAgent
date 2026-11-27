import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { BranchIcon, ChevronDownIcon, FolderIcon } from "../../icons";
import { useDismissableLayer } from "../../lib/useDismissableLayer";
import { useComposerPopoverClamp } from "./useComposerPopoverClamp";

export type LaunchpadWherePillProps = {
  /** The project the thread starts in, or what stands in for none. */
  projectLabel: string;
  /** The checkout, such as "new worktree from main" or "local checkout". */
  checkoutLabel?: string;
  disabled?: boolean;
  /** The panel's sections: the existing project, checkout and machine controls. */
  children: ReactNode;
};

/**
 * A new thread has no sidebar row or details rail yet, so where it will run
 * (project, checkout, base branch, machine) is chosen in the composer, behind
 * one pill. After the first send the thread card and rail show those choices.
 *
 * The panel is non-modal and holds the same controls the row used to show,
 * so their own popovers, keyboard handling and checks are unchanged.
 */
export function LaunchpadWherePill(props: LaunchpadWherePillProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  useDismissableLayer({
    open,
    onDismiss: () => setOpen(false),
    surfaceRef: panelRef,
    triggerRef,
  });
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      // A control in the panel can portal its own list to the body.
      if (target instanceof Element && target.closest("[role='listbox'],[role='menu']")
        && !containerRef.current?.contains(target)) {
        return;
      }
      if (!containerRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      panelRef.current
        ?.querySelector<HTMLElement>("button:not(:disabled),[tabindex='0']")
        ?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open]);
  const panelStyle = useComposerPopoverClamp(open, panelRef);
  const label = props.checkoutLabel
    ? `Where: ${props.projectLabel}, ${props.checkoutLabel}`
    : `Where: ${props.projectLabel}`;

  return (
    <span className="composer-where" ref={containerRef}>
      <button
        aria-controls={open ? panelId : undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={label}
        className={`composer-where__pill tooltip-target${open ? " is-open" : ""}`}
        data-tooltip={open ? undefined : label}
        disabled={props.disabled}
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((current) => !current)}
      >
        <FolderIcon aria-hidden="true" size={13} />
        <span className="composer-where__label">
          <span className="composer-where__project">{props.projectLabel}</span>
          {props.checkoutLabel ? (
            <>
              <span aria-hidden="true" className="composer-where__sep">·</span>
              <BranchIcon aria-hidden="true" size={12} />
              <span className="composer-where__checkout">{props.checkoutLabel}</span>
            </>
          ) : null}
        </span>
        <ChevronDownIcon aria-hidden="true" size={12} />
      </button>
      {open ? (
        <div
          aria-label="Where this thread runs"
          className="composer-where__panel"
          id={panelId}
          ref={panelRef}
          role="dialog"
          style={panelStyle}
        >
          {props.children}
        </div>
      ) : null}
    </span>
  );
}

/** One titled section of the Where panel. */
export function LaunchpadWhereSection(props: { label: string; children: ReactNode }) {
  const labelId = useId();
  return (
    <section aria-labelledby={labelId} className="composer-where__section">
      <div className="composer-where__section-label" id={labelId}>{props.label}</div>
      {props.children}
    </section>
  );
}
