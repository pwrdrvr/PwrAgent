import { Fragment } from "react";
import {
  describeFederationThreadTargetAvailability,
  FEDERATION_TARGET_AVAILABILITY_LABEL,
  type FederationThreadTargetAvailability,
} from "../chrome/federation-thread-targets";
import { ContextMenuCascade } from "./ContextMenuCascade";

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
  const leadsWithParent = props.machines[0]?.parent === true && props.machines.length > 1;

  return (
    <ContextMenuCascade
      label={props.label}
      groupLabel={props.groupLabel}
      rowDisabled={props.rowDisabled}
      onSelect={props.onSelect}
      onOpenChange={props.onOpenChange}
    >
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
    </ContextMenuCascade>
  );
}
