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
  icon?: CelestialIconId;
  status: FederationConnectionState;
  isLocal: boolean;
  isHub: boolean;
  unreachable?: boolean;
  onOpen: () => void;
  /** Present when AI intake can target this instance. */
  onIntake?: () => void;
}) {
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
            ? `Open this instance (${props.label})`
            : `Open remote viewer for ${props.label}`
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
        <span className="star-map-instance__label" title={props.label}>
          {props.label}
        </span>
        {props.onIntake ? (
          <button
            type="button"
            className="star-map-instance__intake"
            aria-label={`New thread on ${props.label}`}
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
