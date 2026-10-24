import { useEffect, useRef, useState } from "react";
import type { StorageMaintenanceCommand, StorageMaintenanceStatus } from "../../../../shared/storage-maintenance";
import { BrandLockup } from "../chrome/BrandLockup";

export type StorageMaintenanceBridge = {
  command(command: StorageMaintenanceCommand): Promise<StorageMaintenanceStatus>;
  subscribe(listener: (status: StorageMaintenanceStatus) => void): () => void;
};
const size = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
/** How long a finished window stays up with the pointer elsewhere. */
export const STORAGE_MAINTENANCE_AUTO_CLOSE_MS = 5_000;

/**
 * The toast countdown, for a whole window: it runs once the job is over and
 * pauses while the pointer or keyboard focus is inside. As in the toast, a
 * resume continues from what is left, so the bar and the close land together.
 */
function useAutoClose(active: boolean, paused: boolean, close: () => void) {
  const remaining = useRef(STORAGE_MAINTENANCE_AUTO_CLOSE_MS);
  const closeRef = useRef(close);
  useEffect(() => { closeRef.current = close; }, [close]);
  useEffect(() => {
    if (!active || paused) return;
    const startedAt = Date.now();
    const timer = window.setTimeout(() => closeRef.current(), remaining.current);
    return () => {
      window.clearTimeout(timer);
      remaining.current = Math.max(0, remaining.current - (Date.now() - startedAt));
    };
  }, [active, paused]);
}

export function StorageMaintenance(props: { api: StorageMaintenanceBridge }) {
  const { api } = props;
  const [status, setStatus] = useState<StorageMaintenanceStatus>();
  const [enabled, setEnabled] = useState(false);
  const [held, setHeld] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const update = (next: StorageMaintenanceStatus) => { setStatus(next); setEnabled(next.historyEnabled === true); };
    const unsubscribe = api.subscribe(update);
    void api.command({ action: "status" }).then(update);
    return unsubscribe;
  }, [api]);
  // Engaging keeps the window above the app as it finishes starting.
  const hold = () => { if (!held) { setHeld(true); void api.command({ action: "hold" }); } };
  const terminal = Boolean(status && ["complete", "cancelled", "deferred", "error"].includes(status.phase));
  const ready = status?.phase === "ready";
  // A click focuses a button too, and Stop becomes Close in place, so only
  // keyboard focus pauses; the pointer pauses through hover. Not now unmounts
  // while focused, which Chromium reports as no blur.
  const keyboardFocus = (element: Element | null) => element?.matches(":focus-visible") === true;
  useEffect(() => {
    if (terminal) setFocused(rootRef.current?.contains(document.activeElement) === true && keyboardFocus(document.activeElement));
  }, [terminal]);
  const paused = hovered || focused;
  useAutoClose(terminal, paused, () => void api.command({ action: "dismiss" }));
  const headings = { ready: "Optimize storage", discovering: "Checking archived threads", cleanup: "Cleaning up storage", vacuum: "Compacting the database", complete: "Storage optimization complete", cancelled: "Storage optimization stopped", deferred: "Storage optimization deferred", error: "Storage optimization paused" };
  return <div
    ref={rootRef}
    className="storage-maintenance"
    onMouseEnter={() => { hold(); setHovered(true); }}
    onMouseLeave={() => setHovered(false)}
    onFocus={(event) => { hold(); setFocused(keyboardFocus(event.target)); }}
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}
  >
    <header className="activity-titlebar">
      <BrandLockup variant="activity-titlebar" />
      <div className="activity-titlebar__breadcrumb">
        <span className="activity-titlebar__eyebrow">Startup</span>
        <span aria-hidden="true" className="activity-titlebar__separator">›</span>
        <span className="activity-titlebar__current">Storage</span>
      </div>
    </header>
    <main className="storage-maintenance__body">
      <h1>{status ? headings[status.phase] : "Checking storage"}</h1>
      <p>Checked at startup, at most once a day, for existing profiles using 100 MiB or more.</p>
      <label className="storage-maintenance__choice">
        <input type="checkbox" checked={enabled} disabled={!ready && !terminal} onChange={(event) => {
          setEnabled(event.target.checked);
          void api.command({ action: "preference", historyEnabled: event.target.checked });
        }} />
        Remove archived tool inspection history after 7 days
      </label>
      <p className="storage-maintenance__detail">Thread restoration, settings, drafts and usage totals are kept. Removed tool and output inspection history cannot be recovered. For older archives with an unknown date, the 7 days begin when PwrAgent first confirms the archive.</p>
      <div className="storage-maintenance__progress" role="status" aria-live="polite" aria-busy={Boolean(status && !ready && !terminal)}>
        {status?.message ?? (status?.phase === "complete" && status.afterBytes !== undefined
          ? `${size(status.beforeBytes)} → ${size(status.afterBytes)}. ${size(Math.max(0, status.beforeBytes - status.afterBytes))} recovered.`
          : status?.phase === "cleanup" ? <><span className="storage-maintenance__count" style={{ minWidth: `${String(status.eligibleThreads).length}ch` }}>{status.completedThreads}</span> of {status.eligibleThreads} eligible archived threads checked.</>
            : status?.phase === "vacuum" ? "Reclaiming unused space. You can stop safely."
              : ready ? "Changes to this checkbox are saved for future checks." : "Your app will continue starting when this step finishes.")}
      </div>
      <footer>
        <span>{terminal ? "You can change the preference for the next cleanup. This window closes on its own unless the pointer is over it." : "This window closes a few seconds after cleanup unless the pointer is over it."}</span>
        {ready ? <><button onClick={() => void api.command({ action: "cancel" })}>Not now</button><button className="storage-maintenance__primary" onClick={() => void api.command({ action: "start" })}>Optimize</button></>
          : terminal ? <button onClick={() => void api.command({ action: "dismiss" })}>Close</button>
            : <button onClick={() => void api.command({ action: "cancel" })}>Stop</button>}
      </footer>
    </main>
    {terminal ? <span
      className="storage-maintenance__timer"
      aria-hidden="true"
      data-paused={paused ? "true" : undefined}
      style={{ animationDuration: `${STORAGE_MAINTENANCE_AUTO_CLOSE_MS}ms` }}
    /> : null}
  </div>;
}
