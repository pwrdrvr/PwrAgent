import { useLayoutEffect, useRef } from "react";
import type { NavigationThreadSummary } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { readRendererFederationTarget } from "../../lib/federation-window";
import { conditionName } from "./dependency-labels";
import { useThreadDependencyIndicatorsContext } from "./useThreadDependencyIndicators";
import { markDoneWaitsOnThread, mergeHoldingDependencies, useThreadDependencyList } from "./useThreadDependencyList";

/**
 * The thread view's Continue After banner: what this thread's merge waits
 * for, and the waits other threads keep on this one that end when it is
 * marked done. Both open Continue After, where the operator acts.
 */
export function ContinueAfterStatus({ thread, api }: { thread: NavigationThreadSummary; api?: DesktopApi }) {
  const open = useThreadDependencyIndicatorsContext()?.open;
  const bannerRef = useRef<HTMLDivElement>(null);
  const owner = thread.federation?.ref.target ?? readRendererFederationTarget();
  const { data } = useThreadDependencyList(thread.source, thread.id, owner, api);
  const held = mergeHoldingDependencies(data);
  const waits = markDoneWaitsOnThread(data, {
    backend: thread.source, threadId: thread.id, ...(owner?.scope === "remote" ? { owner } : {}),
  });
  // A failed refresh shows nothing: the merge itself still refuses while held.
  const visible = held.length > 0 || waits.length > 0;
  useLayoutEffect(() => {
    const banner = bannerRef.current;
    const parent = banner?.parentElement;
    if (!banner || !parent) return;
    // The to-do stack and Find are positioned against the primary column.
    // Reserve the banner's measured height, including wrapped names.
    const update = () => parent.style.setProperty("--continue-after-status-height", `${banner.getBoundingClientRect().height}px`);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(banner);
    return () => { observer.disconnect(); parent.style.removeProperty("--continue-after-status-height"); };
  }, [visible]);
  if (!visible) return null;
  const awaited = held.flatMap((dependency) => dependency.conditions.map(conditionName));
  return (
    <div className="continue-after-status" ref={bannerRef} role="status">
      <div>
        {held.length ? (
          <p>
            <strong>Merge held</strong>
            {` until ${[...new Set(awaited)].join(held.length === 1 && held[0]!.mode === "any" ? " or " : ", ")}`}
          </p>
        ) : null}
        {waits.length ? (
          <p>
            {waits.length === 1
              ? "Another thread waits for this one to be marked done."
              : `${waits.length} threads wait for this one to be marked done.`}
          </p>
        ) : null}
      </div>
      {open ? (
        <button className="button button--secondary" type="button" onClick={() => open(thread)}>
          {waits.length && !held.length ? "Mark Done…" : "Continue After…"}
        </button>
      ) : null}
    </div>
  );
}
