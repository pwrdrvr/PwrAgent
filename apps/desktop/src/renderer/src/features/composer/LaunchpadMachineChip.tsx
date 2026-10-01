import { useCallback, useMemo, useState } from "react";
import type { CelestialIconId } from "@pwragent/shared";
import { CelestialIcon, ServerIcon } from "../../icons";
import type { ProjectIdentity } from "../../lib/federation-project-match";
import {
  FEDERATION_TARGET_AVAILABILITY_LABEL,
  type FederationThreadTarget,
} from "../chrome/federation-thread-targets";
import {
  useFederationProjectStates,
  type CheckFederationTargetProject,
} from "../chrome/useFederationProjectStates";
import { InstanceGlyph } from "../federation/InstanceGlyph";
import { ComposerDropdown, type ComposerDropdownOption } from "./ComposerDropdown";

/** The dropdown value for this machine; peer ids never start with "@". */
const THIS_MACHINE_VALUE = "@this-machine";

/** Where a retarget lands, resolved before the launchpad switches. */
export type LaunchpadMachineRetarget = {
  /** Directory key of the launchpad the draft moves to. */
  directoryKey: string;
  open: () => Promise<void>;
};

export type LaunchpadMachineControl = {
  /** Peer instance the launchpad starts its thread on; undefined is here. */
  currentInstanceId?: string;
  local: {
    label: string;
    celestialIcon?: CelestialIconId;
    instanceId?: string;
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

/**
 * The first chip of a launchpad composer: which machine the thread will
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
    ? current?.label ?? control.currentInstanceId
    : control.local.label;
  const projectLabel = control.project?.label ?? "this project";

  const options: ComposerDropdownOption[] = [
    {
      label: control.local.label,
      value: THIS_MACHINE_VALUE,
      ...(control.localHasProject || !control.currentInstanceId
        ? { description: "This machine" }
        : {
            description: "No project",
            disabled: true,
            tooltip: `This machine has no project named ${projectLabel}`,
          }),
    },
    ...control.targets.map((target): ComposerDropdownOption => {
      const isCurrent = target.instanceId === control.currentInstanceId;
      if (!isCurrent && target.availability !== "available") {
        return {
          label: target.label,
          value: target.instanceId,
          description: FEDERATION_TARGET_AVAILABILITY_LABEL[target.availability],
          disabled: true,
        };
      }
      const projectState = isCurrent ? undefined : projectStates?.[target.instanceId];
      if (projectState === "missing") {
        return {
          label: target.label,
          value: target.instanceId,
          description: "No project",
          disabled: true,
          tooltip: `${target.label} has no project named ${projectLabel}`,
        };
      }
      return {
        label: target.label,
        value: target.instanceId,
        ...(projectState === "checking" ? { description: "Checking…" } : {}),
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
      <span
        className="composer__fixed-value composer__fixed-value--machine"
        aria-label={`Runs on ${currentLabel}`}
        data-remote={control.currentInstanceId ? "true" : undefined}
      >
        <span aria-hidden="true" className="composer-dropdown__icon">
          <Icon size={13} />
        </span>
        {currentLabel}
      </span>
    );
  }

  return (
    <ComposerDropdown
      id="composer-machine"
      ariaLabel="Machine"
      disabled={props.disabled}
      icon={Icon}
      tone={control.currentInstanceId ? "remote" : undefined}
      tooltip={`Starts on ${currentLabel}`}
      value={control.currentInstanceId ?? THIS_MACHINE_VALUE}
      options={options}
      onOpenChange={setOpen}
      onChange={(value) => {
        props.onRetarget(value === THIS_MACHINE_VALUE ? undefined : value);
      }}
    />
  );
}
