import { useCallback, useEffect, useId, useRef, useState, type ReactElement } from "react";
import type { DesktopAppearanceDensity } from "@pwragent/shared/contracts/settings";
import { CheckIcon } from "../../icons";
import { useMenuNavigation } from "../../lib/useMenuNavigation";
import { useViewportTooltip } from "../../lib/useViewportTooltip";
import { DENSITY_CHOICES } from "../settings/DensityPicker";

/** What each row style keeps, short enough for a menu line. */
const ROW_STYLE_DETAIL: Record<DesktopAppearanceDensity, string> = {
  "mission-control": "Every chip on every row",
  compact: "Pull requests and reactions",
  minimal: "One line per thread",
};

/**
 * The sidebar's view choices, beside the lens switch: how much each thread
 * row shows, and whether the project index column is on. Both are layout
 * choices, not lenses, so they share one button instead of crowding the
 * lens row.
 *
 * Choosing an item applies it at once and keeps the menu open, so the rows
 * behind it can be compared before the menu closes.
 *
 * The project index item keeps the old toggle's contract: the preference is
 * the operator's even when the column cannot draw (one project, or a
 * sidebar too narrow for it), so the item stays live and says why.
 */
export function SidebarViewMenu(props: {
  density?: DesktopAppearanceDensity;
  onDensityChange?: (density: DesktopAppearanceDensity) => void;
  /** Absent when this sidebar has no project index to show or hide. */
  projectIndex?: {
    hidden: boolean;
    /** Why the index is on but not drawn, if it is. Read when the menu
     *  opens: the narrow-sidebar case is decided by CSS, not by React. */
    unavailableReason?: () => string | undefined;
    onToggle: () => void;
  };
  onOpenAppearanceSettings?: () => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [indexReason, setIndexReason] = useState<string>();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const tooltip = useViewportTooltip({ className: "viewport-tooltip" });
  const close = useCallback(() => setOpen(false), []);
  useMenuNavigation({ open, menuRef, triggerRef, onClose: close });

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent): void => {
      if (!wrapperRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [open, close]);

  const projectIndex = props.projectIndex;
  const indexOn = projectIndex ? !projectIndex.hidden : false;
  const showTooltip = (target: HTMLElement): void => {
    if (!open) tooltip.show(target, "Sidebar view");
  };

  return (
    <div ref={wrapperRef} className="sidebar__view-menu">
      <button
        ref={triggerRef}
        type="button"
        className={`sidebar__view-menu-trigger${open ? " is-open" : ""}`}
        aria-label="Sidebar view"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          tooltip.hide();
          if (!open) setIndexReason(projectIndex?.unavailableReason?.());
          setOpen(!open);
        }}
        onMouseEnter={(event) => showTooltip(event.currentTarget)}
        onMouseLeave={tooltip.hide}
        onFocus={(event) => showTooltip(event.currentTarget)}
        onBlur={tooltip.hide}
      >
        <SidebarViewGlyph />
      </button>
      {tooltip.tooltipNode}
      {open ? (
        <div
          ref={menuRef}
          id={menuId}
          className="sidebar__menu sidebar__menu--view"
          role="menu"
          aria-label="Sidebar view"
          tabIndex={-1}
        >
          {props.onDensityChange ? (
            <div role="group" aria-label="Thread rows" className="sidebar-view-menu__group">
              <span className="sidebar-view-menu__heading" aria-hidden="true">Thread rows</span>
              {DENSITY_CHOICES.map((choice) => {
                const checked = props.density === choice.value;
                return (
                  <button
                    key={choice.value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={checked}
                    className="sidebar-view-menu__item"
                    onClick={() => props.onDensityChange?.(choice.value)}
                  >
                    <span className="sidebar-view-menu__check" aria-hidden="true">
                      {checked ? <CheckIcon size={12} /> : null}
                    </span>
                    <span className="sidebar-view-menu__text">
                      <span className="sidebar-view-menu__title">{choice.label}</span>
                      <span className="sidebar-view-menu__detail">
                        {ROW_STYLE_DETAIL[choice.value]}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}
          {projectIndex ? (
            <>
              {props.onDensityChange ? (
                <div className="thread-context-menu__separator" role="separator" />
              ) : null}
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={indexOn}
                className="sidebar-view-menu__item"
                onClick={() => {
                  projectIndex.onToggle();
                  // Turning it on may leave it undrawn; say so in place.
                  setIndexReason(undefined);
                }}
              >
                <span className="sidebar-view-menu__check" aria-hidden="true">
                  {indexOn ? <CheckIcon size={12} /> : null}
                </span>
                <span className="sidebar-view-menu__text">
                  <span className="sidebar-view-menu__title">Project index</span>
                  <span className="sidebar-view-menu__detail">
                    {indexOn && indexReason ? indexReason : "A column of project names to jump between"}
                  </span>
                </span>
              </button>
            </>
          ) : null}
          {props.onOpenAppearanceSettings ? (
            <>
              <div className="thread-context-menu__separator" role="separator" />
              <button
                type="button"
                role="menuitem"
                className="sidebar-view-menu__item"
                onClick={() => {
                  close();
                  props.onOpenAppearanceSettings?.();
                }}
              >
                <span className="sidebar-view-menu__check" aria-hidden="true" />
                <span className="sidebar-view-menu__text">
                  <span className="sidebar-view-menu__title">Appearance settings…</span>
                </span>
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Three rows of decreasing detail. */
function SidebarViewGlyph(): ReactElement {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="2" y="2.5" width="12" height="4" rx="1.2" strokeWidth="1.3" />
      <path d="M2.6 9.5h10.8" strokeWidth="1.4" />
      <path d="M2.6 12.8h7" strokeWidth="1.4" />
    </svg>
  );
}
