import { useEffect, useId, useRef, useState } from "react";
import type { DesktopApi } from "../../lib/desktop-api";
import { formatTrafficBytes } from "./format-traffic-bytes";
import { StarMapIcon } from "../../icons/StarMapIcon";
import { federationRuntimeLabel, useFederationActivity } from "./useFederationActivity";

export function FederationStatusControl(props: { desktopApi?: DesktopApi; onOpen: () => void }) {
  const [open, setOpen] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const id = useId();
  const { snapshot, error, pending, toggle } = useFederationActivity(props.desktopApi, open, { includeHistory: false });
  const cancelDismiss = () => clearTimeout(timer.current);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);
  const enabled = Boolean(snapshot && snapshot.configuredMode !== "disabled");
  return (
    <div ref={root} className="messaging-status-bar federation-status-control"
      onPointerEnter={() => { cancelDismiss(); setOpen(true); }}
      onPointerLeave={() => {
        cancelDismiss();
        timer.current = setTimeout(() => {
          if (!root.current?.contains(document.activeElement)) setOpen(false);
        }, 180);
      }}
      onFocus={() => { cancelDismiss(); setOpen(true); }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          trigger.current?.focus();
          setOpen(false);
        }
      }}>
      <button ref={trigger} type="button" className="thread-header__star-map-toggle"
        aria-label="Open Star Map" aria-haspopup="dialog" aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => { cancelDismiss(); setOpen(false); props.onOpen(); }}>
        <StarMapIcon size={14} />
      </button>
      {open ? (
        <div id={id} className="messaging-status-popover" role="dialog" aria-label="Federation activity">
          <div className="messaging-status-popover__panel">
            <div className="messaging-status-popover__head">
              <div>
                <div className="messaging-status-popover__title">Federation</div>
                <div className="messaging-status-popover__summary">
                  {snapshot ? `Configured ${enabled ? `on · ${snapshot.configuredMode}` : "off"}` : "Loading…"}
                </div>
              </div>
              <button type="button" role="switch" aria-label="Federation enabled"
                aria-checked={Boolean(snapshot && enabled)} disabled={!snapshot || pending || !props.desktopApi?.setFederationEnabled}
                className={`settings-switch messaging-status-popover__switch${enabled ? " is-on" : ""}`}
                onClick={() => void toggle()}>
                <span className="settings-switch__track" aria-hidden="true"><span className="settings-switch__thumb" /></span>
                <span>{enabled ? "On" : "Off"}</span>
              </button>
            </div>
            {snapshot ? (
              <div className="federation-status-control__details">
                <strong>{federationRuntimeLabel(snapshot)}</strong>
                {snapshot.health.leaseHolder ? <p>Holder: {snapshot.health.leaseHolder.instanceId}
                  {snapshot.health.leaseHolder.processId ? ` · PID ${snapshot.health.leaseHolder.processId}` : ""}
                  {snapshot.health.leaseHolder.cwdHint ? ` · ${snapshot.health.leaseHolder.cwdHint}` : ""}</p> : null}
                {snapshot.health.unavailableReason ? <p>{snapshot.health.unavailableReason}</p> : null}
                <p>Last minute: {formatTrafficBytes(snapshot.activity.physical.windows["1m"].sent.wireBytes)} sent
                  {" · "}{formatTrafficBytes(snapshot.activity.physical.windows["1m"].received.wireBytes)} received</p>
                <p className="federation-activity__muted">Encoded envelope bytes on physical connections</p>
              </div>
            ) : null}
            {error || actionError ? <p role="alert">{error || actionError}</p> : null}
            <button type="button" className="messaging-status-popover__activity"
              disabled={!props.desktopApi?.openFederationActivity}
              onClick={() => {
                void props.desktopApi?.openFederationActivity?.().then(() => setOpen(false)).catch((cause: unknown) => {
                  setActionError(cause instanceof Error ? cause.message : String(cause));
                });
              }}>Open Federation Activity</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
