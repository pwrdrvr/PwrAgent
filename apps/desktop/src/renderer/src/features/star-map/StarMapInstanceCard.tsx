import type { CelestialIconId, FederationConnectionState } from "@pwragent/shared";
import { CelestialIcon } from "../../icons";

function statusTone(status: FederationConnectionState): string {
  switch (status) {
    case "connected":
    case "listening":
      return "ok";
    case "connecting":
    case "handshaking":
      return "suspended";
    case "degraded":
    case "rejected":
      return "warning";
    default:
      return "error";
  }
}

/**
 * One celestial body on the map: the instance's icon floating on the star
 * field with a glow, its label on a pill beneath, and the connection
 * status pinned to the body. No bordered card - the body IS the presence.
 * The [+] AI-intake action lands in the intake unit of the Star Map plan.
 */
export function StarMapInstanceCard(props: {
  instanceId: string;
  label: string;
  /**
   * Rendered on its own line under the machine name. Only set when the
   * profile is needed to tell two instances apart — stacking keeps the
   * name pill narrow instead of letting "machine / profile" widen it.
   */
  profileName?: string;
  icon?: CelestialIconId;
  status: FederationConnectionState;
  isLocal: boolean;
  isHub: boolean;
  unreachable?: boolean;
  onOpen: () => void;
  /** Present when AI intake can target this instance. */
  onIntake?: () => void;
}) {
  // Display stacks the two lines to stay narrow, but every accessible name
  // has to keep the profile inline: two instances on one machine would
  // otherwise expose identical button names.
  const fullLabel = props.profileName
    ? `${props.label} / ${props.profileName}`
    : props.label;

  return (
    <div
      className={`star-map-instance${props.isLocal ? " star-map-instance--local" : ""}${
        props.isHub ? " star-map-instance--hub" : ""
      }`}
      data-instance-id={props.instanceId}
    >
      <button
        type="button"
        className="star-map-instance__body"
        aria-label={
          props.isLocal
            ? `Open this instance (${fullLabel})`
            : `Open remote viewer for ${fullLabel}`
        }
        onClick={props.onOpen}
      >
        <span className="star-map-instance__glow" aria-hidden="true" />
        {props.icon ? (
          <CelestialIcon
            icon={props.icon}
            size={props.isHub ? 72 : 56}
            className="star-map-instance__icon"
          />
        ) : (
          <span className="star-map-instance__icon-placeholder" aria-hidden="true" />
        )}
        <span
          className={`status-dot status-dot--${statusTone(props.status)} star-map-instance__status`}
          aria-hidden="true"
        />
      </button>
      <span className="star-map-instance__row">
        <span
          className="star-map-instance__label"
          title={fullLabel}
        >
          <span className="star-map-instance__machine">{props.label}</span>
          {props.profileName ? (
            <span className="star-map-instance__profile">
              {props.profileName}
            </span>
          ) : null}
        </span>
        {props.onIntake ? (
          <button
            type="button"
            className="star-map-instance__intake"
            aria-label={`New thread on ${fullLabel}`}
            onClick={props.onIntake}
          >
            +
          </button>
        ) : null}
      </span>
      {props.unreachable ? (
        <span className="star-map-instance__unreachable">Unreachable</span>
      ) : null}
    </div>
  );
}
