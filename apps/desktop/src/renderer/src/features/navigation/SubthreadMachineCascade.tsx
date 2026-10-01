import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import {
  describeFederationThreadTargetAvailability,
  type FederationThreadTargetAvailability,
} from "../chrome/federation-thread-targets";

export type SubthreadMachineChoice = {
  /** Peer instance id; undefined is this machine. */
  instanceId?: string;
  label: string;
  availability: FederationThreadTargetAvailability;
  /** The machine the parent thread lives on. */
  parent: boolean;
};

const AVAILABILITY_STATE_LABEL: Partial<
  Record<FederationThreadTargetAvailability, string>
> = {
  offline: "Offline",
  unsupported: "Unsupported",
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
 * or ArrowRight, opens "New workspace on" with the parent's machine first:
 * a new workspace needs nothing from the parent's disk, so it is the one
 * sub-thread that can start anywhere. A worktree needs the parent's branch,
 * which another machine may not have, so the list never offers one.
 *
 * Offline and unsupported machines stay listed and disabled, for the reason
 * the "New chat on" menus keep them: a machine vanishing reads as a bug.
 */
export function SubthreadMachineCascade(props: {
  label: string;
  disabled?: boolean;
  machines: readonly SubthreadMachineChoice[];
  onSelect: () => void;
  onSelectMachine: (instanceId: string | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const [focusFirst, setFocusFirst] = useState(false);
  const rowRef = useRef<HTMLButtonElement>(null);
  const flyoutRef = useRef<HTMLDivElement>(null);
  const flyoutId = useId();
  const groupLabelId = useId();

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
      onMouseEnter={() => {
        if (!props.disabled) setOpen(true);
      }}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        ref={rowRef}
        role="menuitem"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? flyoutId : undefined}
        disabled={props.disabled}
        onClick={props.onSelect}
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
            New workspace on
          </div>
          {props.machines.map((machine) => {
            const unavailable = machine.availability !== "available";
            const state = unavailable
              ? AVAILABILITY_STATE_LABEL[machine.availability]
              : machine.parent
                ? "Parent"
                : undefined;
            return (
              <button
                key={machine.instanceId ?? "this-machine"}
                role="menuitem"
                type="button"
                className="thread-context-menu__machine"
                aria-disabled={unavailable || undefined}
                title={describeFederationThreadTargetAvailability(machine.availability)}
                onClick={() => {
                  if (unavailable) return;
                  props.onSelectMachine(machine.instanceId);
                }}
              >
                <span className="thread-context-menu__machine-name">{machine.label}</span>
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
