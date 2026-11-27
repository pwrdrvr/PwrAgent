import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { FolderIcon, ProjectsIcon, WorktreeIcon } from "../../icons";
import { useDismissableLayer } from "../../lib/useDismissableLayer";
import { useComposerPopoverClamp } from "./useComposerPopoverClamp";

/** How the thread works on disk, which picks the Where icon. */
export type ComposerWhereMode = "local" | "worktree";

export type ComposerWhereProps = {
  /**
   * The words the icon stands for, such as "Where: PwrAgnt, new worktree
   * from main". It is the button's accessible name and its tooltip.
   */
  label: string;
  mode: ComposerWhereMode;
  /** Two or more shows the stacked-folders icon with this count. */
  directoryCount?: number;
  /** The panel's accessible name. */
  panelLabel: string;
  disabled?: boolean;
  /** Controlled open state; left out, the button keeps its own. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** The panel's sections. */
  children: ReactNode;
};

/**
 * Where a thread runs, as one icon in the composer row: a folder for a local
 * checkout, the worktree glyph for a worktree, stacked folders with a count
 * for two or more directories. The project is already in the title bar and
 * breadcrumb, so the row shows only the one fact that changes how a turn
 * runs; the panel holds the words and the controls.
 *
 * The panel is non-modal and holds the same controls the row used to show,
 * so their own popovers, keyboard handling and checks are unchanged.
 */
export function ComposerWhere(props: ComposerWhereProps) {
  const [ownOpen, setOwnOpen] = useState(false);
  const open = props.open ?? ownOpen;
  const setOpen = (next: boolean) => {
    setOwnOpen(next);
    props.onOpenChange?.(next);
  };
  // The dismiss listeners outlive a render; they call the latest setter.
  const setOpenRef = useRef(setOpen);
  setOpenRef.current = setOpen;
  const containerRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  useDismissableLayer({
    open,
    onDismiss: () => setOpenRef.current(false),
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
      if (!containerRef.current?.contains(target)) setOpenRef.current(false);
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
  const count = props.directoryCount ?? 0;
  const multiple = count > 1;

  return (
    <span className="composer-where" ref={containerRef}>
      <button
        aria-controls={open ? panelId : undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={props.label}
        className={[
          "composer__toggle",
          "composer-where__trigger",
          "tooltip-target",
          props.mode === "worktree" ? "composer-where__trigger--worktree" : "",
          open ? "is-open" : "",
        ].filter(Boolean).join(" ")}
        data-mode={props.mode}
        data-tooltip={open ? undefined : props.label}
        disabled={props.disabled}
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(!open)}
      >
        {multiple ? (
          <ProjectsIcon aria-hidden="true" size={14} />
        ) : props.mode === "worktree" ? (
          <WorktreeIcon aria-hidden="true" size={14} />
        ) : (
          <FolderIcon aria-hidden="true" size={14} />
        )}
        {multiple ? (
          <span aria-hidden="true" className="composer__toggle-count">
            {count > 9 ? "9+" : count}
          </span>
        ) : null}
      </button>
      {open ? (
        <div
          aria-label={props.panelLabel}
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
export function ComposerWhereSection(props: { label: string; children: ReactNode }) {
  const labelId = useId();
  return (
    <section aria-labelledby={labelId} className="composer-where__section">
      <div className="composer-where__section-label" id={labelId}>{props.label}</div>
      {props.children}
    </section>
  );
}
