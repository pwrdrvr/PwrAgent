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
 * One celestial body on the map: the instance's icon, its display label,
 * connection status, and the open-viewer action. The [+] AI-intake action
 * lands in the intake unit of the Star Map plan.
 */
export function StarMapInstanceCard(props: {
  instanceId: string;
  label: string;
  icon?: CelestialIconId;
  status: FederationConnectionState;
  isLocal: boolean;
  unreachable?: boolean;
  onOpen: () => void;
}) {
  return (
    <div
      className={`star-map-instance${props.isLocal ? " star-map-instance--local" : ""}`}
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
        {props.icon ? (
          <CelestialIcon icon={props.icon} size={48} />
        ) : (
          <span className="star-map-instance__icon-placeholder" aria-hidden="true" />
        )}
        <span className="star-map-instance__label" title={props.label}>
          {props.label}
        </span>
        <span
          className={`status-dot status-dot--${statusTone(props.status)}`}
          aria-hidden="true"
        />
      </button>
      {props.unreachable ? (
        <span className="star-map-instance__unreachable">Unreachable</span>
      ) : null}
    </div>
  );
}
