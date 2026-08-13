import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { NewThreadIcon } from "../../icons";
import { useViewportTooltip } from "../../lib/useViewportTooltip";

/**
 * The masthead "New thread" button with a hover/focus flyout.
 *
 * Clicking the button keeps its original behavior: start a new thread in the
 * directory the navigation context resolves to (`onCreateThread`). Hovering or
 * focusing the button reveals a flyout that makes the available outcomes
 * explicit:
 *
 *   1. New chat in <directory>     → `onCreateThread` (context default)
 *   2. New chat without a directory → `onCreateThreadWithoutDirectory`
 *   3. New chat on <instance>        → open that owner's launchpad
 *   4. Add a Project Directory…     → track a repo without starting a chat
 *
 * The flyout renders when there's either a meaningful directory choice or an
 * explicit project-registration action. That keeps "Add a Project Directory…"
 * reachable even when the current context is already directory-less.
 *
 * Shared by the sidebar masthead and the relocated thread-header / Windows
 * title-bar placements so every surface reads identically.
 */
export type NewThreadButtonProps = {
  addingProjectDirectory?: boolean;
  creatingThread?: boolean;
  /**
   * Label of the directory the default action resolves to, or undefined when
   * that's the directory-less workspace (no meaningful flyout to show).
   */
  directoryLabel?: string;
  onAddProjectDirectory?: () => void | Promise<void>;
  onCreateThread: () => void | Promise<void>;
  onCreateThreadWithoutDirectory?: () => void | Promise<void>;
  onCreateThreadOnTarget?: (instanceId: string) => void | Promise<void>;
  remoteTargets?: readonly {
    instanceId: string;
    label: string;
  }[];
};

export function NewThreadButton(props: NewThreadButtonProps): ReactElement {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const tooltip = useViewportTooltip({ className: "viewport-tooltip" });

  const hasDirectoryChoice = Boolean(
    props.directoryLabel && props.onCreateThreadWithoutDirectory,
  );
  const hasRemoteTargets = Boolean(
    props.onCreateThreadOnTarget && props.remoteTargets?.length,
  );
  const hasFlyout =
    hasDirectoryChoice
    || hasRemoteTargets
    || Boolean(props.onAddProjectDirectory);
  const menuOpen = open && hasFlyout && !props.creatingThread;

  // With no flyout to reveal, keep a plain "New thread" tooltip so the button
  // has the same hover/focus affordance as its (tooltip-bearing) siblings.
  const showTooltip = (): void => {
    if (!hasFlyout && buttonRef.current) {
      tooltip.show(buttonRef.current, "New thread");
    }
  };

  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") {
        return;
      }
      setOpen(false);
      // Only pull focus back to the trigger when focus is actually inside the
      // flyout (keyboard-driven). A hover-opened menu must close without
      // stealing focus. The onFocus guard below then keeps this refocus from
      // re-opening the just-dismissed menu.
      if (wrapperRef.current?.contains(document.activeElement)) {
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [menuOpen]);

  return (
    <span
      ref={wrapperRef}
      className="new-thread-button"
      data-state={menuOpen ? "open" : "closed"}
      onMouseEnter={() => {
        setOpen(true);
        showTooltip();
      }}
      onMouseLeave={() => {
        setOpen(false);
        tooltip.hide();
      }}
      onFocus={(event) => {
        // Only react to focus entering the wrapper from outside. Focus moving
        // within the wrapper (e.g. Escape refocusing the trigger from a menu
        // item) must not re-open the menu or re-trigger the tooltip.
        if (wrapperRef.current?.contains(event.relatedTarget as Node)) {
          return;
        }
        setOpen(true);
        showTooltip();
      }}
      onBlur={(event) => {
        if (!wrapperRef.current?.contains(event.relatedTarget as Node)) {
          setOpen(false);
          tooltip.hide();
        }
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        aria-label="New thread"
        aria-haspopup={hasFlyout ? "menu" : undefined}
        aria-expanded={hasFlyout ? menuOpen : undefined}
        aria-controls={menuOpen ? menuId : undefined}
        className="sidebar__icon-button"
        disabled={Boolean(props.creatingThread)}
        onClick={() => {
          setOpen(false);
          tooltip.hide();
          void props.onCreateThread();
        }}
      >
        <NewThreadIcon size={16} strokeWidth={1.5} aria-hidden="true" />
      </button>

      {menuOpen ? (
        <div className="new-thread-menu">
          <div
            className="new-thread-menu__card"
            id={menuId}
            role="menu"
            aria-label="New thread options"
          >
            {hasDirectoryChoice ? (
              <>
                <button
                  type="button"
                  role="menuitem"
                  className="new-thread-menu__item"
                  onClick={() => {
                    setOpen(false);
                    void props.onCreateThread();
                  }}
                >
                  New chat in {props.directoryLabel}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="new-thread-menu__item"
                  onClick={() => {
                    setOpen(false);
                    void props.onCreateThreadWithoutDirectory?.();
                  }}
                >
                  New chat without a directory
                </button>
              </>
            ) : (
              <button
                type="button"
                role="menuitem"
                className="new-thread-menu__item"
                onClick={() => {
                  setOpen(false);
                  void props.onCreateThread();
                }}
              >
                New chat without a directory
              </button>
            )}
            {hasRemoteTargets ? (
              <>
                <div className="new-thread-menu__separator" role="separator" />
                <div className="new-thread-menu__section-label" role="presentation">
                  Other instances
                </div>
                {props.remoteTargets?.map((target) => (
                  <button
                    key={target.instanceId}
                    type="button"
                    role="menuitem"
                    className="new-thread-menu__item"
                    onClick={() => {
                      setOpen(false);
                      void props.onCreateThreadOnTarget?.(target.instanceId);
                    }}
                  >
                    New chat on {target.label}
                  </button>
                ))}
              </>
            ) : null}
            {props.onAddProjectDirectory ? (
              <>
                <div className="new-thread-menu__separator" role="separator" />
                <button
                  type="button"
                  role="menuitem"
                  className="new-thread-menu__item"
                  disabled={props.addingProjectDirectory}
                  onClick={() => {
                    setOpen(false);
                    void props.onAddProjectDirectory?.();
                  }}
                >
                  {props.addingProjectDirectory
                    ? "Adding Project Directory…"
                    : "Add a Project Directory…"}
                </button>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
      {tooltip.tooltipNode}
    </span>
  );
}
