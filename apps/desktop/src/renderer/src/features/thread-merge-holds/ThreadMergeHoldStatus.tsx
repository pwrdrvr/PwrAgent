import { useLayoutEffect, useRef } from "react";
import type { NavigationThreadSummary } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { useThreadMergeHolds, useThreadMergeHoldsOpener } from "./useThreadMergeHolds";

export function ThreadMergeHoldStatus({ thread, api }: { thread: NavigationThreadSummary; api?: DesktopApi }) {
  const open = useThreadMergeHoldsOpener();
  const bannerRef = useRef<HTMLDivElement>(null);
  const { data, error } = useThreadMergeHolds(thread.source, thread.id, thread.federation?.ref.target, api);
  const holds = (data?.holds ?? thread.mergeHolds ?? []).filter((hold) => hold.status === "waiting");
  const dependents = data?.dependents ?? [];
  const visible = Boolean(holds.length || dependents.length || error);
  useLayoutEffect(() => {
    const banner = bannerRef.current;
    const parent = banner?.parentElement;
    if (!banner || !parent) return;
    // The to-do stack and Find are positioned against the primary column.
    // Reserve the banner's measured height, including wrapped reasons.
    const update = () => parent.style.setProperty("--thread-merge-hold-height", `${banner.getBoundingClientRect().height}px`);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(banner);
    return () => { observer.disconnect(); parent.style.removeProperty("--thread-merge-hold-height"); };
  }, [visible]);
  if (!visible) return null;
  const steps = holds.reduce((total, hold) => total + (hold.followUp?.length ?? 0), 0);
  return <div className="thread-merge-holds__status" ref={bannerRef} role="status">
    <div>
      {holds.length ? <p>
        <strong>Waiting for</strong> {holds.map((hold) => hold.reason).join("; ")}
        <span className="thread-merge-holds__status-aside"> · Merge held{steps ? ` · ${steps === 1 ? "1 step" : `${steps} steps`} to remind you of` : ""}</span>
      </p> : null}
      {dependents.length ? <p>{dependents.length === 1
        ? `Another thread is waiting on this one for ${dependents[0]!.hold.reason}. Mark it done when that is finished.`
        : `${dependents.length} threads are waiting on this one. Mark each done when its work is finished.`}</p> : null}
      {error ? <p>Could not refresh waits. {error}</p> : null}
    </div>
    {open ? <button className="button button--secondary" type="button" onClick={() => open(thread)}>{dependents.length && !holds.length ? "Mark Done…" : "Manage…"}</button> : null}
  </div>;
}
