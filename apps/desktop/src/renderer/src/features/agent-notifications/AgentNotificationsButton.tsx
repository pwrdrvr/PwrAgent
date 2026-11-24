import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactElement } from "react";
import { createPortal } from "react-dom";
import type { AgentNotificationItem } from "@pwragent/shared/contracts/scheduled-thread-actions";
import type { AppServerBackendKind } from "@pwragent/shared/contracts/normalized-app-server";
import { BellIcon } from "../../icons";
import { useDismissableLayer } from "../../lib/useDismissableLayer";
import { useViewportTooltip } from "../../lib/useViewportTooltip";
import type { AgentNotificationsController } from "./useAgentNotifications";

/**
 * The window-level bell for agents' notices. It shows only while a notice
 * is unread or scheduled, so a profile that never uses `notify_operator`
 * sees no new control. Every placement (sidebar masthead, title strip,
 * thread header) renders this one.
 */
export function AgentNotificationsButton(props: {
  controller?: AgentNotificationsController;
  threadTitle: (backend: AppServerBackendKind, threadId: string) => string;
  /** Placement classes added to `sidebar__icon-button`. */
  className?: string;
  now?: () => number;
}): ReactElement | null {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const tooltip = useViewportTooltip({ className: "viewport-tooltip" });
  const controller = props.controller;
  const unread = controller?.snapshot.unread.length ?? 0;
  const scheduled = controller?.snapshot.scheduled.length ?? 0;
  const visible = unread > 0 || scheduled > 0;
  useDismissableLayer({ open: open && visible, onDismiss: () => setOpen(false), surfaceRef, triggerRef });
  const [position, setPosition] = useState<CSSProperties>();
  // The list is a portal on <body>, placed under the bell, so a narrow
  // sidebar's overflow never clips it.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(POPOVER_WIDTH, window.innerWidth - 2 * POPOVER_MARGIN);
      const left = Math.max(POPOVER_MARGIN, Math.min(rect.left - 8, window.innerWidth - width - POPOVER_MARGIN));
      setPosition({ top: rect.bottom + 6, left, width });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (surfaceRef.current?.contains(target) || triggerRef.current?.contains(target))) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  if (!controller || !visible) return null;
  const now = props.now?.() ?? Date.now();
  const label = [
    "Notifications",
    unread > 0 ? `${unread} unread` : undefined,
    scheduled > 0 ? `${scheduled} scheduled` : undefined,
  ].filter(Boolean).join(", ");
  const className = [
    "sidebar__icon-button",
    "agent-notifications-button",
    props.className,
    open ? "is-active" : undefined,
  ].filter(Boolean).join(" ");
  const row = (item: AgentNotificationItem, kind: "unread" | "scheduled" | "earlier") => (
    <li key={item.id} className="agent-notifications__row">
      <span
        aria-hidden="true"
        className={`agent-notifications__dot${kind === "earlier" ? " is-read" : item.urgency === "high" ? " is-high" : ""}`}
      />
      <div className="agent-notifications__text">
        <p className="agent-notifications__title">{item.title}</p>
        <p className="agent-notifications__meta">
          {props.threadTitle(item.backend, item.threadId)} · {describeTime(kind === "scheduled" ? item.scheduledFor : item.deliveredAt ?? item.scheduledFor, now, kind === "scheduled")}
        </p>
      </div>
      <div className="agent-notifications__acts">
        {kind === "scheduled" ? (
          <button
            type="button"
            aria-label={`Cancel ${item.title}`}
            className="button button--ghost agent-notifications__act"
            onClick={() => controller.cancel(item.id)}
          >
            Cancel
          </button>
        ) : (
          <button
            type="button"
            aria-label={`Open ${item.title}`}
            className="button button--secondary agent-notifications__act"
            onClick={() => {
              setOpen(false);
              controller.open(item);
            }}
          >
            Open
          </button>
        )}
        {kind === "unread" ? (
          <button
            type="button"
            aria-label={`Dismiss ${item.title}`}
            className="button button--ghost agent-notifications__act"
            onClick={() => controller.dismiss(item.id)}
          >
            Dismiss
          </button>
        ) : null}
      </div>
    </li>
  );
  return (
    <span className="agent-notifications">
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={className}
        data-testid="agent-notifications-button"
        onBlur={tooltip.hide}
        onClick={() => {
          tooltip.hide();
          setOpen((current) => !current);
        }}
        onFocus={(event) => tooltip.show(event.currentTarget, label)}
        onMouseEnter={(event) => tooltip.show(event.currentTarget, label)}
        onMouseLeave={tooltip.hide}
      >
        <BellIcon size={16} strokeWidth={1.5} aria-hidden="true" />
        {unread > 0 ? (
          <span aria-hidden="true" className="agent-notifications__count">{unread > 99 ? "99+" : unread}</span>
        ) : null}
      </button>
      {tooltip.tooltipNode}
      {open ? createPortal(
        <div
          ref={surfaceRef}
          role="dialog"
          aria-labelledby={headingId}
          className="agent-notifications__popover"
          data-testid="agent-notifications-popover"
          style={position}
        >
          <div className="agent-notifications__head">
            <h2 id={headingId}>Notifications</h2>
            {unread > 0 ? (
              <button type="button" className="button button--ghost agent-notifications__act" onClick={controller.dismissAll}>
                Dismiss all
              </button>
            ) : null}
          </div>
          {unread > 0 ? (
            <section aria-label="Unread">
              <h3 className="agent-notifications__group">Unread · {unread}</h3>
              <ul className="agent-notifications__list">{controller.snapshot.unread.map((item) => row(item, "unread"))}</ul>
            </section>
          ) : null}
          {scheduled > 0 ? (
            <section aria-label="Scheduled">
              <h3 className="agent-notifications__group">Scheduled · {scheduled}</h3>
              <ul className="agent-notifications__list">{controller.snapshot.scheduled.map((item) => row(item, "scheduled"))}</ul>
            </section>
          ) : null}
          {controller.snapshot.earlier.length > 0 ? (
            <section aria-label="Earlier">
              <h3 className="agent-notifications__group">Earlier</h3>
              <ul className="agent-notifications__list">{controller.snapshot.earlier.slice(0, 10).map((item) => row(item, "earlier"))}</ul>
            </section>
          ) : null}
        </div>,
        document.body,
      ) : null}
    </span>
  );
}

const POPOVER_WIDTH = 360;
const POPOVER_MARGIN = 16;

/** "3:15 PM", or "6:00 PM, in 2 h 45 min" for a notice still waiting. */
export function describeTime(at: number, now: number, future: boolean): string {
  const clock = new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const sameDay = new Date(at).toDateString() === new Date(now).toDateString();
  const stamp = sameDay ? clock : `${new Date(at).toLocaleDateString([], { month: "short", day: "numeric" })} ${clock}`;
  if (!future) return stamp;
  const minutes = Math.max(0, Math.round((at - now) / 60_000));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const span = hours > 0 ? `${hours} h${rest > 0 ? ` ${rest} min` : ""}` : `${rest} min`;
  return `${stamp}, in ${span}`;
}
