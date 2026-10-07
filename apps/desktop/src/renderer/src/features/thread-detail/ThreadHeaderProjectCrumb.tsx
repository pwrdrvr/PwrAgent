import { useEffect, useRef, useState, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { ChevronDownIcon } from "../../icons";
import { useMenuNavigation } from "../../lib/useMenuNavigation";
import { FederationTargetMenuSection } from "../chrome/FederationTargetMenuSection";
import type { FederationThreadTarget } from "../chrome/federation-thread-targets";
import {
  useFederationProjectStates,
  type CheckFederationTargetProject,
  type FederationProjectDirectory,
} from "../chrome/useFederationProjectStates";

/** The card's `max-width` in app.css, kept clear of the window's right edge. */
const MENU_MAX_WIDTH = 320;
const MENU_VIEWPORT_PADDING = 12;
const MENU_GAP = 4;

/**
 * The project in a thread's breadcrumb, when it is a project the Directories
 * lens lists. Without one the breadcrumb keeps its plain-text label.
 */
export type ThreadHeaderProject = {
  /** The project's directory key. Two projects can share a label. */
  directoryKey: string;
  /** Show the project in the Directories lens. */
  onReveal: () => void;
  /** Open this project's new-thread launchpad. */
  onCreateThread: () => void;
  federation?: {
    directory: FederationProjectDirectory;
    targets: readonly FederationThreadTarget[];
    check?: CheckFederationTargetProject;
    onCreateThread: (instanceId: string) => void;
  };
};

/**
 * The breadcrumb's project name and its new-thread caret.
 *
 * The name works like the thread title beside it: a click navigates the
 * thread list, here to the project's section in Directories. Starting work
 * there sits behind the caret, as it does on the project's sidebar row (the
 * launchpad button and its machine chevron), and opens only on a click. The
 * pointer crosses the breadcrumb on its way to Back and to the title, so a
 * hover flyout here would open when nobody asked for it.
 *
 * The menu portals onto `document.body`: `.thread-header__eyebrow-row` clips
 * its overflow, and the card is far taller than the row.
 */
export function ThreadHeaderProjectCrumb(props: {
  label: string;
  project: ThreadHeaderProject;
}): ReactElement {
  const { label, project } = props;
  const caretRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPosition, setMenuPosition] = useState<{ left: number; top: number }>();
  const menuOpen = menuPosition !== undefined;
  const closeMenu = (): void => setMenuPosition(undefined);
  const federation = project.federation;
  const federationTargets = federation?.targets ?? [];
  const projectStates = useFederationProjectStates({
    check: federation?.check,
    directory: federation?.directory,
    open: menuOpen,
    targets: federationTargets,
  });

  useMenuNavigation({
    open: menuOpen,
    menuRef,
    triggerRef: caretRef,
    onClose: closeMenu,
  });

  // A click anywhere else closes the menu, as the sidebar's directory menu
  // does. The caret and the card stop their own clicks from reaching here.
  // A resize closes it too: the card is placed once, from the caret's rect.
  useEffect(() => {
    if (!menuOpen) return;
    const close = (): void => setMenuPosition(undefined);
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close, true);
      window.removeEventListener("resize", close);
    };
  }, [menuOpen]);

  const revealLabel = `Show ${label} in Directories`;
  const menuLabel = `New thread in ${label}`;

  return (
    <>
      {/* The span keeps the eyebrow's cap-height trim and baseline, as the
          title's h2 does for its button. */}
      <span className="thread-header__eyebrow thread-header__eyebrow--link">
        <button
          type="button"
          className="thread-header__project-button tooltip-target"
          aria-label={revealLabel}
          data-tooltip={revealLabel}
          onClick={project.onReveal}
        >
          {label}
        </button>
      </span>
      <button
        ref={caretRef}
        type="button"
        className={`thread-header__project-menu-button tooltip-target${
          menuOpen ? " is-open" : ""
        }`}
        aria-label={menuLabel}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        data-tooltip={menuOpen ? undefined : menuLabel}
        onClick={(event) => {
          event.stopPropagation();
          if (menuOpen) {
            closeMenu();
            return;
          }
          const rect = event.currentTarget.getBoundingClientRect();
          setMenuPosition({
            left: Math.max(
              MENU_VIEWPORT_PADDING,
              Math.min(
                rect.left,
                window.innerWidth - MENU_MAX_WIDTH - MENU_VIEWPORT_PADDING,
              ),
            ),
            top: rect.bottom + MENU_GAP,
          });
        }}
      >
        <ChevronDownIcon size={12} strokeWidth={2.25} />
      </button>
      {menuPosition
        ? createPortal(
            <div
              ref={menuRef}
              className="new-thread-menu__card new-thread-menu__card--anchored"
              role="menu"
              aria-label={menuLabel}
              style={{ left: menuPosition.left, top: menuPosition.top }}
              onClick={(event) => event.stopPropagation()}
            >
              <button
                type="button"
                role="menuitem"
                className="new-thread-menu__item"
                onClick={() => {
                  closeMenu();
                  project.onCreateThread();
                }}
              >
                New chat in {label}
              </button>
              {federation && federationTargets.length > 0 ? (
                <>
                  <div className="new-thread-menu__separator" role="separator" />
                  <FederationTargetMenuSection
                    targets={federationTargets}
                    projectLabel={label}
                    projectStates={projectStates}
                    onSelect={(instanceId) => {
                      closeMenu();
                      federation.onCreateThread(instanceId);
                    }}
                  />
                </>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
