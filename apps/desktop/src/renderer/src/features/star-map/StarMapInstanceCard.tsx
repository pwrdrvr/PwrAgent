import type { ReactNode } from "react";
import type { CelestialIconId, FederationConnectionState } from "@pwragent/shared";
import { CelestialIcon, PopoutIcon } from "../../icons";
import { useViewportTooltip } from "../../lib/useViewportTooltip";

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
 * One control on the instance's affordance row. Icon-only, so the tooltip is
 * the label — and it fires on focus as well as hover, since for a keyboard
 * user the tooltip IS the discoverable name.
 */
function InstanceAction(props: {
  className: string;
  label: string;
  pressed?: boolean;
  children: ReactNode;
  onClick: () => void;
}) {
  // `.star-map-card__tooltip` raises the layer to 140. Without it the portal
  // renders at the default 90 and the Star Map layer (120) paints straight
  // over it — the tooltip is there, just invisible.
  const tooltip = useViewportTooltip({
    className: "viewport-tooltip star-map-card__tooltip",
  });
  return (
    <>
      <button
        type="button"
        className={`star-map-instance__action ${props.className}`}
        aria-label={props.label}
        {...(props.pressed !== undefined
          ? { "aria-pressed": props.pressed }
          : {})}
        onClick={props.onClick}
        onMouseEnter={(event) => tooltip.show(event.currentTarget, props.label)}
        onMouseLeave={tooltip.hide}
        onFocus={(event) => tooltip.show(event.currentTarget, props.label)}
        onBlur={tooltip.hide}
      >
        {props.children}
      </button>
      {tooltip.tooltipNode}
    </>
  );
}

/**
 * One celestial body on the map: the instance's icon floating on the star
 * field with a glow, its label on a pill beneath, the connection status
 * pinned to the body, and an affordance row above it. No bordered card -
 * the body IS the presence.
 *
 * The row is absolutely positioned above the body ON PURPOSE: the body,
 * label and cloud geometry are tuned against `STAR_MAP_BODY_ROW_Y` and the
 * first card slot, so growing this flex column would push the label into the
 * cloud (worst on the larger hub body). Out of flow, it costs no layout.
 *
 * Clicking the body SELECTS the instance rather than opening it. Opening a
 * remote viewer is a window-level commitment and lives on its own control:
 * the biggest, most inviting target on the map should do the cheap,
 * reversible thing.
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
  selected?: boolean;
  onSelect: () => void;
  /**
   * Leave the map for this instance: a remote viewer window for a peer, or
   * the local app itself for this one.
   */
  onOpen?: () => void;
  /** Present when AI intake can target this instance. */
  onIntake?: () => void;
  /** Toggles this instance's load card on the map. */
  onToggleLoad?: () => void;
  loadShown?: boolean;
}) {
  // Display stacks the two lines to stay narrow, but every accessible name
  // has to keep the profile inline: two instances on one machine would
  // otherwise expose identical button names.
  // Native `title` is an anti-pattern here (UI-THEME.md): unstyleable,
  // platform-dependent timing, no wrapping on macOS Electron.
  const labelTooltip = useViewportTooltip({
    className: "viewport-tooltip star-map-card__tooltip",
  });
  const fullLabel = props.profileName
    ? `${props.label} / ${props.profileName}`
    : props.label;

  return (
    <div
      className={`star-map-instance${props.isLocal ? " star-map-instance--local" : ""}${
        props.isHub ? " star-map-instance--hub" : ""
      }${props.selected ? " star-map-instance--selected" : ""}`}
      data-instance-id={props.instanceId}
    >
      <span className="star-map-instance__actions">
        {props.onIntake ? (
          <InstanceAction
            className="star-map-instance__action--intake"
            label={`New thread on ${fullLabel}`}
            onClick={props.onIntake}
          >
            +
          </InstanceAction>
        ) : null}
        {props.onToggleLoad ? (
          <InstanceAction
            className="star-map-instance__action--load"
            label={
              props.loadShown
                ? `Hide load for ${fullLabel}`
                : `Show load for ${fullLabel} (CPU, memory, disk)`
            }
            pressed={props.loadShown === true}
            onClick={props.onToggleLoad}
          >
            {/* Three ascending bars: a gauge, not a glyph with prior meaning
                elsewhere in the product. */}
            <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
              <rect x="1" y="7" width="2.5" height="4" rx="0.6" />
              <rect x="4.75" y="4" width="2.5" height="7" rx="0.6" />
              <rect x="8.5" y="1.5" width="2.5" height="9.5" rx="0.6" />
            </svg>
          </InstanceAction>
        ) : null}
        {props.onOpen ? (
          <InstanceAction
            className="star-map-instance__action--open"
            label={
              props.isLocal
                ? `Open this instance (${fullLabel})`
                : `Open remote viewer for ${fullLabel}`
            }
            onClick={props.onOpen}
          >
            <PopoutIcon size={13} />
          </InstanceAction>
        ) : null}
      </span>
      <button
        type="button"
        className="star-map-instance__body"
        aria-pressed={props.selected === true}
        aria-label={`Focus ${fullLabel}`}
        onClick={props.onSelect}
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
          onMouseEnter={(event) =>
            labelTooltip.show(event.currentTarget, fullLabel)
          }
          onMouseLeave={labelTooltip.hide}
        >
          <span className="star-map-instance__machine">{props.label}</span>
          {props.profileName ? (
            <span className="star-map-instance__profile">
              {props.profileName}
            </span>
          ) : null}
        </span>
      </span>
      {props.unreachable ? (
        <span className="star-map-instance__unreachable">Unreachable</span>
      ) : null}
      {labelTooltip.tooltipNode}
    </div>
  );
}
