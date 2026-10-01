import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import {
  describeFederationThreadTargetAvailability,
  FEDERATION_TARGET_AVAILABILITY_LABEL,
  type FederationThreadTargetAvailability,
} from "../chrome/federation-thread-targets";

export type SubthreadMachineChoice = {
  /** Peer instance id; undefined is this machine. */
  instanceId?: string;
  label: string;
  availability: FederationThreadTargetAvailability;
  /** The machine the parent thread lives on. */
  parent: boolean;
  /**
   * Why an otherwise reachable machine cannot take the child yet, such as
   * "No project" or "Checking…". The row stays listed, disabled.
   */
  blocked?: string;
  /** The longer reason behind `blocked`, for the row's tooltip. */
  blockedTitle?: string;
  /** The branch a new worktree there starts from, shown under the name. */
  baseBranch?: string;
};

function enabledItems(menu: HTMLElement | null): HTMLElement[] {
  if (!menu) return [];
  return [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].filter(
    (item) => item.getAttribute("aria-disabled") !== "true",
  );
}

/**
 * A context-menu row that keeps its own click and cascades a machine list.
 *
 * Clicking the row does what it always did, on the parent's machine. Hover,
 * or ArrowRight, opens the same kind of workspace ("New workspace on" or
 * "New worktree on") with the parent's machine first. A new workspace needs
 * nothing from the parent's disk. A worktree needs the parent's project on
 * that machine, and its base branch may not be the parent's, so each
 * worktree row names the branch it starts from.
 *
 * Offline and unsupported machines stay listed and disabled, for the reason
 * the "New chat on" menus keep them: a machine vanishing reads as a bug.
 */
export function SubthreadMachineCascade(props: {
  label: string;
  /** The flyout's heading, which names what each row starts. */
  groupLabel: string;
  /**
   * Only the row's own click waits (on the owner's worktree check); a new
   * workspace needs nothing from it, so the machine list stays reachable.
   */
  rowDisabled?: boolean;
  machines: readonly SubthreadMachineChoice[];
  onSelect: () => void;
  onSelectMachine: (machine: SubthreadMachineChoice) => void;
  /** Reports the flyout opening, so its machines are checked only when seen. */
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [focusFirst, setFocusFirst] = useState(false);
  const rowRef = useRef<HTMLButtonElement>(null);
  const flyoutRef = useRef<HTMLDivElement>(null);
  const flyoutId = useId();
  const groupLabelId = useId();
  const { onOpenChange } = props;

  useEffect(() => {
    onOpenChange?.(open);
  }, [onOpenChange, open]);

  useEffect(() => {
    if (open && focusFirst) {
      enabledItems(flyoutRef.current)[0]?.focus();
      setFocusFirst(false);
    }
  }, [focusFirst, open]);

  const closeToRow = (): void => {
    setOpen(false);
    rowRef.current?.focus();
  };

  const handleFlyoutKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    // Claimed here so the outer menu's arrow walk, which skips a prevented
    // key, stays out of the flyout.
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      closeToRow();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
      return;
    }
    event.preventDefault();
    const items = enabledItems(flyoutRef.current);
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "ArrowDown"
      ? items[(at + 1) % items.length]
      : items[at <= 0 ? items.length - 1 : at - 1];
    next?.focus();
  };

  return (
    <div
      className="thread-context-menu__cascade"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => {
        // Keep the keyboard inside the menu when the pointer wanders off
        // while focus is in the flyout: unmounting it would drop focus to
        // <body>, where the outer menu no longer hears its keys.
        if (flyoutRef.current?.contains(document.activeElement)) {
          closeToRow();
          return;
        }
        setOpen(false);
      }}
    >
      <button
        ref={rowRef}
        role="menuitem"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? flyoutId : undefined}
        aria-disabled={props.rowDisabled || undefined}
        onClick={() => {
          if (!props.rowDisabled) props.onSelect();
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight") {
            event.preventDefault();
            setOpen(true);
            setFocusFirst(true);
          }
        }}
      >
        {props.label}
        <span aria-hidden="true" className="thread-context-menu__cascade-chevron">
          ›
        </span>
      </button>
      {open ? (
        <div
          ref={flyoutRef}
          id={flyoutId}
          className="thread-context-menu thread-context-menu__flyout"
          role="menu"
          aria-labelledby={groupLabelId}
          onKeyDown={handleFlyoutKeyDown}
        >
          <div className="thread-context-menu__group-label" id={groupLabelId}>
            {props.groupLabel}
          </div>
          {props.machines.map((machine) => {
            const unreachable = machine.availability !== "available";
            const unavailable = unreachable || machine.blocked !== undefined;
            const state = unreachable
              ? FEDERATION_TARGET_AVAILABILITY_LABEL[machine.availability]
              : machine.blocked ?? (machine.parent ? "Parent" : undefined);
            const detail = !unavailable && machine.baseBranch
              ? `from ${machine.baseBranch}`
              : undefined;
            return (
              <button
                key={machine.instanceId ?? "this-machine"}
                role="menuitem"
                type="button"
                className={detail
                  ? "thread-context-menu__machine thread-context-menu__machine--detailed"
                  : "thread-context-menu__machine"}
                aria-disabled={unavailable || undefined}
                title={unreachable || machine.blocked === undefined
                  ? describeFederationThreadTargetAvailability(machine.availability) ?? detail
                  : machine.blockedTitle ?? machine.blocked}
                onClick={() => {
                  if (unavailable) return;
                  props.onSelectMachine(machine);
                }}
              >
                {detail ? (
                  <span className="thread-context-menu__machine-label">
                    <span className="thread-context-menu__machine-name">{machine.label}</span>
                    <span className="thread-context-menu__item-detail">{detail}</span>
                  </span>
                ) : (
                  <span className="thread-context-menu__machine-name">{machine.label}</span>
                )}
                {state ? (
                  <span className="thread-context-menu__machine-state">{state}</span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
