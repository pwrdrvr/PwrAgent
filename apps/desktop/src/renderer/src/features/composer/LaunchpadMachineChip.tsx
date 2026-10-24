import { useCallback, useMemo, useState } from "react";
import type { CelestialIconId } from "@pwragent/shared";
import { CelestialIcon, ServerIcon } from "../../icons";
import type { ProjectIdentity } from "../../lib/federation-project-match";
import {
  FEDERATION_PROJECT_STATE_LABEL,
  FEDERATION_TARGET_AVAILABILITY_LABEL,
  type FederationThreadTarget,
} from "../chrome/federation-thread-targets";
import {
  useFederationProjectStates,
  type CheckFederationTargetProject,
} from "../chrome/useFederationProjectStates";
import { InstanceGlyph } from "../federation/InstanceGlyph";
import { ComposerDropdown, type ComposerDropdownOption } from "./ComposerDropdown";

/** The window-default dropdown value; peer ids never start with "@". */
const THIS_MACHINE_VALUE = "@this-machine";

/** Where a retarget lands, resolved before the launchpad switches. */
export type LaunchpadMachineRetarget = {
  /** Directory key of the launchpad the draft moves to. */
  directoryKey: string;
  open: () => Promise<void>;
};

export type LaunchpadMachineControl = {
  /** Peer instance override; undefined uses this window's default owner. */
  currentInstanceId?: string;
  /** Default owner: the local instance, or the owner of a remote viewer. */
  local: {
    label: string;
    shortLabel?: string;
    celestialIcon?: CelestialIconId;
    instanceId?: string;
    remote?: boolean;
    availability?: FederationThreadTarget["availability"];
  };
  targets: readonly FederationThreadTarget[];
  /** The launchpad's project, as each machine is asked whether it has one. */
  project?: ProjectIdentity;
  localHasProject: boolean;
  checkProject?: CheckFederationTargetProject;
  /**
   * Resolve the counterpart launchpad on another machine. Absent for a
   * launchpad that cannot move, such as a sub-thread's, whose parent fixes
   * where it runs: the chip then only says where that is.
   */
  planRetarget?: (
    instanceId: string | undefined,
  ) => Promise<LaunchpadMachineRetarget | undefined>;
};

/**
 * Why a launchpad cannot send right now because its machine is offline, or
 * undefined. The draft stays editable: the peer usually comes back, and the
 * operator can also move the draft to a machine that is up.
 */
export function describeLaunchpadMachineOffline(
  control: LaunchpadMachineControl | undefined,
): string | undefined {
  if (!control) {
    return undefined;
  }
  const target = control.currentInstanceId
    ? control.targets.find((candidate) => candidate.instanceId === control.currentInstanceId)
    : control.local.remote ? control.local : undefined;
  return target?.availability === "offline"
    ? `${target.label} is offline. Your draft stays here until it reconnects.`
    : undefined;
}

function MachineMark(props: {
  celestialIcon?: CelestialIconId;
  instanceId?: string;
  size?: number;
}) {
  if (props.celestialIcon) {
    return <CelestialIcon icon={props.celestialIcon} size={props.size} />;
  }
  if (props.instanceId) {
    return <InstanceGlyph instanceId={props.instanceId} size={props.size} />;
  }
  return <ServerIcon size={props.size} />;
}

/** A machine a thread runs on, for a chip that only names it. */
export type MachineChipValue = {
  /** Full name, for the tooltip. */
  label: string;
  /** The short name the chip shows. */
  shortLabel?: string;
  celestialIcon?: CelestialIconId;
  instanceId?: string;
  remote?: boolean;
  offline?: boolean;
};

/**
 * The machine chip with nothing to choose: a sub-thread launchpad, whose
 * parent fixes where it runs, and the thread header once a thread exists.
 */
export function FixedMachineChip(props: { machine: MachineChipValue; verb?: string }) {
  const { machine } = props;
  const label = machine.shortLabel ?? machine.label;
  return (
    <span
      className="composer__fixed-value composer__fixed-value--machine"
      aria-label={`${props.verb ?? "Runs on"} ${label}${machine.offline ? ", offline" : ""}`}
      title={machine.label}
      data-remote={machine.remote ? "true" : undefined}
      data-offline={machine.offline ? "true" : undefined}
    >
      <span aria-hidden="true" className="composer-dropdown__icon">
        <MachineMark
          celestialIcon={machine.celestialIcon}
          instanceId={machine.instanceId}
          size={13}
        />
      </span>
      {label}
    </span>
  );
}

/**
 * The launchpad's machine chip: which machine the thread will
 * start on. Without it a composer aimed at a peer looked exactly like a
 * local one, and the only way to learn the target was to send and see where
 * the thread landed.
 *
 * Choosing another machine reopens the same project there and carries the
 * draft along. A machine without the project stays listed and disabled, as
 * in the sidebar's "New chat on" menu, so it never silently opens Workspaces.
 */
export function LaunchpadMachineChip(props: {
  control: LaunchpadMachineControl;
  disabled?: boolean;
  menuPlacement?: "above" | "below";
  onRetarget: (instanceId: string | undefined) => void;
}) {
  const { control } = props;
  const [open, setOpen] = useState(false);
  // The machine the launchpad already runs on has the project by definition.
  const otherTargets = useMemo(
    () => control.targets.filter((target) => target.instanceId !== control.currentInstanceId),
    [control.currentInstanceId, control.targets],
  );
  const projectStates = useFederationProjectStates({
    check: control.checkProject,
    directory: control.project,
    open: open && Boolean(control.planRetarget),
    targets: otherTargets,
  });
  const current = control.currentInstanceId
    ? control.targets.find((target) => target.instanceId === control.currentInstanceId)
    : undefined;
  const currentLabel = control.currentInstanceId
    ? current?.shortLabel ?? current?.label ?? control.currentInstanceId
    : control.local.shortLabel ?? control.local.label;
  const fullLabel = control.currentInstanceId
    ? current?.label ?? control.currentInstanceId
    : control.local.label;
  const currentOffline = (control.currentInstanceId
    ? current?.availability
    : control.local.remote ? control.local.availability : undefined) === "offline";
  const defaultAvailability = control.local.availability ?? "available";
  const defaultUnavailable = control.local.remote && defaultAvailability !== "available";
  const currentRemote = Boolean(control.currentInstanceId || control.local.remote);
  const defaultMachineDescription = control.local.remote ? "This window" : "This machine";
  const projectLabel = control.project?.label ?? "this project";

  const options: ComposerDropdownOption[] = [
    {
      label: control.local.shortLabel ?? control.local.label,
      value: THIS_MACHINE_VALUE,
      tooltip: control.local.label,
      ...(control.currentInstanceId && defaultUnavailable
        ? {
            description: FEDERATION_TARGET_AVAILABILITY_LABEL[defaultAvailability],
            disabled: true,
          }
        : control.localHasProject || !control.currentInstanceId
          ? { description: defaultMachineDescription }
          : {
              description: FEDERATION_PROJECT_STATE_LABEL.missing,
              disabled: true,
              tooltip: `${control.local.label} has no project named ${projectLabel}`,
            }),
    },
    ...control.targets.map((target): ComposerDropdownOption => {
      const isCurrent = target.instanceId === control.currentInstanceId;
      if (!isCurrent && target.availability !== "available") {
        return {
          label: target.shortLabel ?? target.label,
          value: target.instanceId,
          description: FEDERATION_TARGET_AVAILABILITY_LABEL[target.availability],
          disabled: true,
          tooltip: target.label,
        };
      }
      const projectState = isCurrent ? undefined : projectStates?.[target.instanceId];
      if (projectState === "missing") {
        return {
          label: target.shortLabel ?? target.label,
          value: target.instanceId,
          description: FEDERATION_PROJECT_STATE_LABEL.missing,
          disabled: true,
          tooltip: `${target.label} has no project named ${projectLabel}`,
        };
      }
      return {
        label: target.shortLabel ?? target.label,
        value: target.instanceId,
        tooltip: target.label,
        ...(projectState === "checking" ? { description: FEDERATION_PROJECT_STATE_LABEL.checking } : {}),
      };
    }),
  ];

  const Icon = useCallback(
    (iconProps: { size?: number }) =>
      control.currentInstanceId ? (
        <MachineMark
          celestialIcon={current?.celestialIcon}
          instanceId={control.currentInstanceId}
          size={iconProps.size}
        />
      ) : (
        <MachineMark
          celestialIcon={control.local.celestialIcon}
          instanceId={control.local.instanceId}
          size={iconProps.size}
        />
      ),
    [
      control.currentInstanceId,
      control.local.celestialIcon,
      control.local.instanceId,
      current?.celestialIcon,
    ],
  );

  if (!control.planRetarget) {
    return (
      <FixedMachineChip
        machine={{
          label: fullLabel,
          shortLabel: currentLabel,
          celestialIcon: control.currentInstanceId
            ? current?.celestialIcon
            : control.local.celestialIcon,
          instanceId: control.currentInstanceId ?? control.local.instanceId,
          remote: currentRemote,
          offline: currentOffline,
        }}
      />
    );
  }

  return (
    <ComposerDropdown
      id="composer-machine"
      ariaLabel="Machine"
      disabled={props.disabled}
      icon={Icon}
      menuPlacement={props.menuPlacement}
      tone={currentOffline ? "offline" : currentRemote ? "remote" : undefined}
      tooltip={currentOffline ? `${fullLabel} is offline` : `Starts on ${fullLabel}`}
      value={control.currentInstanceId ?? THIS_MACHINE_VALUE}
      options={options}
      onOpenChange={setOpen}
      onChange={(value) => {
        props.onRetarget(value === THIS_MACHINE_VALUE ? undefined : value);
      }}
    />
  );
}
