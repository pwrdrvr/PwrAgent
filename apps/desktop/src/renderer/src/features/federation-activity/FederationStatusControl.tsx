import { useEffect, useId, useRef, useState } from "react";
import { FederationConnections } from "./FederationConnections";
import type { DesktopApi } from "../../lib/desktop-api";
import { CopyIcon } from "../../icons/CopyIcon";
import { copyText } from "../../lib/copy-text";
import { useViewportTooltip } from "../../lib/useViewportTooltip";
import { useMenuNavigation } from "../../lib/useMenuNavigation";
import { StarMapIcon } from "../../icons/StarMapIcon";
import { federationRuntimeLabel, useFederationActivity } from "./useFederationActivity";
import { FederationInstanceChips, federationInstanceChips } from "./FederationInstanceChips";
import { FederationStarMapPreview } from "./FederationStarMapPreview";
import { FEDERATION_TRAFFIC_CARD_SECONDS, FederationTrafficCard } from "./FederationTrafficCard";

export function FederationStatusControl(props: { desktopApi?: DesktopApi; onOpen: () => void }) {
  const [open, setOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const id = useId();
  const menuId = useId();
  // One minute of history, not the hour: this polls every two seconds.
  const { snapshot, error, pending, toggle, capture } = useFederationActivity(props.desktopApi, open, {
    includeHistory: true, historySeconds: FEDERATION_TRAFFIC_CARD_SECONDS,
  });
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
  useEffect(() => { if (!open) setMenuOpen(false); }, [open]);
  useMenuNavigation({ open: menuOpen, menuRef: menu, triggerRef: menuButton, onClose: () => setMenuOpen(false) });
  const enabled = Boolean(snapshot?.running);
  // The runtime clears the deadline once a capture ends, so no clock read here.
  const capturing = Boolean(snapshot?.detailedLoggingUntil);
  const chips = snapshot ? federationInstanceChips(snapshot.health) : [];
  const online = chips.filter((chip) => chip.online).length;
  const fail = (cause: unknown) => setActionError(cause instanceof Error ? cause.message : String(cause));
  const openActivity = props.desktopApi?.openFederationActivity
    ? () => { void props.desktopApi!.openFederationActivity!().then(() => setOpen(false)).catch(fail); }
    : undefined;
  const openStarMap = () => { cancelDismiss(); setOpen(false); props.onOpen(); };
  const openInstance = (instanceId: string) => {
    if (!props.desktopApi?.openStarMapWindow) { openStarMap(); return; }
    void props.desktopApi.openStarMapWindow({ instanceId }).then(() => setOpen(false)).catch(fail);
  };
  const tone = !snapshot || !enabled || snapshot.health.leaseHolder ? "off"
    : ["connected", "listening"].includes(snapshot.health.status) ? "ok" : "warn";
  const leaseHolder = snapshot?.health.leaseHolder;
  const leaseWhere = leaseHolder
    ? [leaseHolder.processId ? `PID ${leaseHolder.processId}` : undefined, leaseHolder.cwdHint].filter(Boolean).join(", ")
    : "";
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
        // An open menu claims its own Escape before this sees it.
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.stopPropagation();
        trigger.current?.focus();
        setOpen(false);
      }}>
      <button ref={trigger} type="button" className="thread-header__star-map-toggle"
        aria-label="Open Star Map" aria-haspopup="dialog" aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={openStarMap}>
        <StarMapIcon size={14} />
      </button>
      {open ? (
        <div id={id} className="messaging-status-popover" role="dialog" aria-label="Federation activity">
          <div className="messaging-status-popover__panel federation-status-control__panel">
            <div className="messaging-status-popover__head federation-status-control__head">
              <div>
                <div className="messaging-status-popover__title federation-status-control__title">
                  Federation
                  {snapshot?.health.instanceId ? (
                    <InstanceIdCopyButton instanceId={snapshot.health.instanceId} desktopApi={props.desktopApi} />
                  ) : null}
                  {capturing ? <span className="federation-status-control__rec">REC</span> : null}
                </div>
                <div className="messaging-status-popover__summary federation-status-control__status">
                  <span aria-hidden="true" className={`federation-status-control__dot federation-status-control__dot--${tone}`} />
                  {snapshot ? federationRuntimeLabel(snapshot) : "Loading…"}
                </div>
                {snapshot ? <div className="messaging-status-popover__summary">
                  {`Configured ${snapshot.configuredMode !== "disabled" ? `on · ${snapshot.configuredMode}` : "off"}`}
                </div> : null}
              </div>
              <div className="messaging-status-popover__head-actions">
                <button type="button" role="switch" aria-label="Federation enabled"
                  title="Turn Federation on or off for this app instance only"
                  aria-checked={Boolean(snapshot && enabled)} disabled={!snapshot || pending || !props.desktopApi?.setFederationEnabled}
                  className={`settings-switch messaging-status-popover__switch${enabled ? " is-on" : ""}`}
                  onClick={() => void toggle()}>
                  <span className="settings-switch__track" aria-hidden="true"><span className="settings-switch__thumb" /></span>
                  <span>{enabled ? "On" : "Off"}</span>
                </button>
                <div className="federation-status-control__menu-anchor">
                  <button ref={menuButton} type="button" className="messaging-status-popover__settings"
                    aria-label="More Federation actions" aria-haspopup="menu" aria-expanded={menuOpen}
                    aria-controls={menuOpen ? menuId : undefined}
                    onClick={() => setMenuOpen((value) => !value)}>
                    <span aria-hidden="true">⋯</span>
                  </button>
                  {menuOpen ? <div ref={menu} id={menuId} role="menu" aria-label="Federation actions"
                    tabIndex={-1} className="federation-status-control__menu">
                    <button type="button" role="menuitem" className="federation-status-control__menu-item"
                      disabled={!snapshot?.health.instanceId}
                      onClick={() => {
                        setMenuOpen(false);
                        if (snapshot?.health.instanceId) void copyText(snapshot.health.instanceId, props.desktopApi).catch(fail);
                      }}>Copy instance ID</button>
                    <button type="button" role="menuitemcheckbox" aria-checked={capturing}
                      className="federation-status-control__menu-item"
                      title="Save the preceding 60 seconds of frame metadata to the profile diagnostics folder, then log the next 60 seconds. Payload contents are excluded."
                      disabled={!snapshot || pending || !props.desktopApi?.setFederationTrafficCapture}
                      onClick={() => { void capture(!capturing); }}>
                      Capture previous + next 60 seconds
                      <span aria-hidden="true" className="federation-status-control__menu-check">{capturing ? "✓" : ""}</span>
                    </button>
                    <button type="button" role="menuitem" className="federation-status-control__menu-item"
                      disabled={!openActivity}
                      onClick={() => { setMenuOpen(false); openActivity?.(); }}>Federation Activity window</button>
                  </div> : null}
                </div>
              </div>
            </div>
            {snapshot ? (
              <div className="federation-status-control__body">
                <FederationStarMapPreview chips={chips} onOpen={openStarMap} />
                {leaseHolder ? <p className="federation-status-control__note">
                  Federation for this profile runs in another PwrAgent window{leaseWhere ? ` (${leaseWhere})` : ""}.
                  Its instances appear here once it stops.
                </p> : null}
                {snapshot.health.unavailableReason ? <p className="federation-status-control__note">
                  {snapshot.health.unavailableReason}</p> : null}
                <section aria-label="Federation instances">
                  <div className="federation-status-control__section">
                    <span>Instances</span>
                    {chips.length ? <span>{online} of {chips.length} connected</span> : null}
                  </div>
                  {chips.length ? <FederationInstanceChips chips={chips}
                    peerSeries={snapshot.activity.peers}
                    onOpenInstance={openInstance}
                    onOpenMore={openStarMap} />
                    : <p className="federation-status-control__note">No other instances yet.</p>}
                </section>
                <FederationTrafficCard series={snapshot.activity.physical} onOpen={openActivity} />
                <FederationConnections health={snapshot.health} collapsible />
              </div>
            ) : null}
            {error || actionError ? <p role="alert" className="federation-status-control__note">{error || actionError}</p> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function InstanceIdCopyButton(props: { instanceId: string; desktopApi?: DesktopApi }) {
  const tooltip = useViewportTooltip({ className: "viewport-tooltip" });
  const label = `Instance ID: ${props.instanceId}\nClick to copy to clipboard`;
  return (
    <>
      <button type="button" className="messaging-status-popover__settings"
        aria-label="Copy Federation instance ID"
        aria-describedby={tooltip.visible ? tooltip.tooltipId : undefined}
        onFocus={(event) => tooltip.show(event.currentTarget, label)}
        onMouseEnter={(event) => tooltip.show(event.currentTarget, label)}
        onBlur={tooltip.hide}
        onMouseLeave={tooltip.hide}
        onClick={(event) => {
          const anchor = event.currentTarget;
          void copyText(props.instanceId, props.desktopApi).then(
            () => { if (anchor.isConnected) tooltip.show(anchor, "Copied instance ID"); },
            () => { if (anchor.isConnected) tooltip.show(anchor, "Could not copy instance ID"); },
          );
        }}>
        <CopyIcon size={12} />
      </button>
      {tooltip.tooltipNode}
    </>
  );
}
