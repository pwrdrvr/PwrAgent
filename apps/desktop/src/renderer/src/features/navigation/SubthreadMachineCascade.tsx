import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
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
  /**
   * `blocked` only until the machine answers. Its dot stays the reachable
   * one, as in the "New chat on" list, rather than the hollow "not here".
   */
  pending?: boolean;
  /** The branch a new worktree there starts from, shown under the name. */
  baseBranch?: string;
};

/** Keeps the flyout this far inside the window when it has to move. */
const VIEWPORT_MARGIN = 8;

function menuItems(menu: HTMLElement | null): HTMLElement[] {
  if (!menu) return [];
  return [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];
}

function isEnabled(item: HTMLElement): boolean {
  return item.getAttribute("aria-disabled") !== "true";
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
 * The rows are drawn like the "New chat on" list (`FederationTargetMenuSection`):
 * its heading, availability dot, and state on the right. Offline and
 * unsupported machines stay listed and disabled, for the reason that list
 * keeps them: a machine vanishing reads as a bug. Disabled rows stay in the
 * arrow walk, so their reason is reachable from the keyboard too.
 */
export function SubthreadMachineCascade(props: {
  label: string;
  /** The flyout's heading, which names what each row starts. */
  groupLabel: string;
  /**
   * Only the row's own click waits (on the owner's worktree check); the
   * machine list stays reachable, by pointer and by keyboard.
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
  // Where the flyout sits when the default (right of the row, top-aligned)
  // would cross the window edge.
  const [startSide, setStartSide] = useState(false);
  const [shiftY, setShiftY] = useState(0);
  const cascadeRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLButtonElement>(null);
  const flyoutRef = useRef<HTMLDivElement>(null);
  const flyoutId = useId();
  const groupLabelId = useId();
  const { onOpenChange } = props;

  useEffect(() => {
    onOpenChange?.(open);
  }, [onOpenChange, open]);

  // Measured on every render while open: a row that resolves from
  // "Checking…" to a branch line grows the flyout. The inputs are the row's
  // box and the flyout's own size, never its placed position, so a render
  // that only moves the flyout measures the same and React bails out.
  useLayoutEffect(() => {
    const cascade = cascadeRef.current;
    const flyout = flyoutRef.current;
    if (!open || !cascade || !flyout) {
      return;
    }
    const row = cascade.getBoundingClientRect();
    const width = flyout.offsetWidth;
    const height = flyout.offsetHeight;
    const fitsEnd = row.right + 2 + width <= window.innerWidth - VIEWPORT_MARGIN;
    const fitsStart = row.left - 2 - width >= VIEWPORT_MARGIN;
    setStartSide(!fitsEnd && fitsStart);
    const top = row.top - 6;
    const overflow = top + height - (window.innerHeight - VIEWPORT_MARGIN);
    setShiftY(overflow > 0 ? -Math.min(overflow, top - VIEWPORT_MARGIN) : 0);
  });

  useEffect(() => {
    if (open && focusFirst) {
      const items = menuItems(flyoutRef.current);
      (items.find(isEnabled) ?? items[0])?.focus();
      setFocusFirst(false);
    }
  }, [focusFirst, open]);

  const closeToRow = (): void => {
    setOpen(false);
    rowRef.current?.focus();
  };

  const handleFlyoutKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    // Claimed here so the outer menu's key walk, which skips a prevented
    // key, stays out of the flyout. Home and End too: the outer walk counts
    // these rows as its own and would carry focus out of an open flyout.
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      closeToRow();
      return;
    }
    if (
      event.key !== "ArrowDown"
      && event.key !== "ArrowUp"
      && event.key !== "Home"
      && event.key !== "End"
    ) {
      return;
    }
    event.preventDefault();
    // Every row, disabled ones included: a disabled machine's reason is
    // only heard when focus can land on it.
    const items = menuItems(flyoutRef.current);
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === "Home"
        ? items[0]
        : event.key === "End"
          ? items[items.length - 1]
          : event.key === "ArrowDown"
            ? items[(at + 1) % items.length]
            : items[at <= 0 ? items.length - 1 : at - 1];
    next?.focus();
  };

  const leadsWithParent = props.machines[0]?.parent === true && props.machines.length > 1;

  return (
    <div
      ref={cascadeRef}
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
          className={startSide
            ? "thread-context-menu thread-context-menu__flyout thread-context-menu__flyout--start"
            : "thread-context-menu thread-context-menu__flyout"}
          style={shiftY !== 0 ? { top: -6 + shiftY } : undefined}
          role="menu"
          aria-labelledby={groupLabelId}
          onKeyDown={handleFlyoutKeyDown}
        >
          <div role="group" aria-labelledby={groupLabelId}>
            <div className="new-thread-menu__section-label" id={groupLabelId}>
              {props.groupLabel}
            </div>
            {props.machines.map((machine, index) => {
              const unreachable = machine.availability !== "available";
              const unavailable = unreachable || machine.blocked !== undefined;
              const state = unreachable
                ? FEDERATION_TARGET_AVAILABILITY_LABEL[machine.availability]
                : machine.blocked ?? (machine.parent ? "Parent" : undefined);
              const detail = !unavailable && machine.baseBranch
                ? `from ${machine.baseBranch}`
                : undefined;
              // The "New chat on" dot: filled when reachable, grey when
              // offline, hollow when the machine is there but cannot host
              // this (unsupported, no project, no worktree).
              const dot = unreachable
                ? machine.availability
                : machine.blocked !== undefined && !machine.pending
                  ? "no-project"
                  : "available";
              const name = (
                <span className="new-thread-menu__target-name">{machine.label}</span>
              );
              return (
                <Fragment key={machine.instanceId ?? "this-machine"}>
                  <button
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
                    <span
                      aria-hidden="true"
                      className="new-thread-menu__target-dot"
                      data-availability={dot}
                    />
                    {detail ? (
                      <span className="thread-context-menu__machine-label">
                        {name}
                        <span className="thread-context-menu__item-detail">{detail}</span>
                      </span>
                    ) : name}
                    {state ? (
                      <span className="new-thread-menu__target-state">{state}</span>
                    ) : null}
                  </button>
                  {index === 0 && leadsWithParent ? (
                    <div className="thread-context-menu__separator" role="separator" />
                  ) : null}
                </Fragment>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
