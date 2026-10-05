import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { StorageMaintenanceCommand, StorageMaintenanceStatus } from "../../../../shared/storage-maintenance";
import "../../styles/app.css";
import "./storage-maintenance.css";

type Bridge = {
  command(command: StorageMaintenanceCommand): Promise<StorageMaintenanceStatus>;
  subscribe(listener: (status: StorageMaintenanceStatus) => void): () => void;
};
const api = (window as unknown as { storageMaintenance: Bridge }).storageMaintenance;
const size = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

export function StorageMaintenance() {
  const [status, setStatus] = useState<StorageMaintenanceStatus>();
  const [enabled, setEnabled] = useState(false);
  const [held, setHeld] = useState(false);
  useEffect(() => {
    const update = (next: StorageMaintenanceStatus) => { setStatus(next); setEnabled(next.historyEnabled === true); };
    const unsubscribe = api.subscribe(update);
    void api.command({ action: "status" }).then(update);
    return unsubscribe;
  }, []);
  const hold = () => { if (!held) { setHeld(true); void api.command({ action: "hold" }); } };
  const terminal = status && ["complete", "cancelled", "deferred", "error"].includes(status.phase);
  const ready = status?.phase === "ready";
  const headings = { ready: "Optimize storage", discovering: "Checking archived threads", cleanup: "Cleaning up storage", vacuum: "Compacting the database", complete: "Storage optimization complete", cancelled: "Storage optimization stopped", deferred: "Storage optimization deferred", error: "Storage optimization paused" };
  return <main className="storage-maintenance" onMouseEnter={hold} onFocusCapture={hold}>
    <p className="sidebar__brand">Pwr<span className="sidebar__brand-accent">Agent</span></p>
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
      <span>{terminal ? "You can change the preference for the next cleanup." : held ? "This window will stay open until you close it. The app will continue after cleanup." : "Move the pointer here to keep this window open afterward."}</span>
      {ready ? <><button onClick={() => void api.command({ action: "cancel" })}>Not now</button><button className="storage-maintenance__primary" onClick={() => void api.command({ action: "start" })}>Optimize</button></>
        : terminal ? <button onClick={() => void api.command({ action: "dismiss" })}>Close</button>
          : <button onClick={() => void api.command({ action: "cancel" })}>Stop</button>}
    </footer>
  </main>;
}

createRoot(document.getElementById("root")!).render(<StorageMaintenance />);
