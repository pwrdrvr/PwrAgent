import { useCallback, useEffect, useRef, useState } from "react";
import type { ReadFederationActivityRequest, ReadFederationActivityResponse } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";

/** Local-only polling, active only while a surface is visible; never overlaps reads. */
export function useFederationActivity(
  desktopApi: DesktopApi | undefined,
  active: boolean,
  request: ReadFederationActivityRequest = {},
) {
  const [snapshot, setSnapshot] = useState<ReadFederationActivityResponse>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const toggleGeneration = useRef(0);
  const { includeHistory, historyPeerId, historyView } = request;
  useEffect(() => {
    if (!active || !desktopApi?.readFederationActivity) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const generation = toggleGeneration.current;
      try {
        const next = await desktopApi.readFederationActivity!({ includeHistory, historyPeerId, historyView });
        if (!disposed && generation === toggleGeneration.current) { setSnapshot(next); setError(undefined); }
      } catch (cause) {
        if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!disposed) timer = setTimeout(() => void poll(), 2_000);
      }
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [desktopApi, active, includeHistory, historyPeerId, historyView]);
  const toggle = useCallback(async () => {
    if (!snapshot || pending || !desktopApi?.setFederationEnabled) return;
    setPending(true);
    toggleGeneration.current += 1;
    try {
      const next = await desktopApi.setFederationEnabled(snapshot.configuredMode === "disabled");
      // Preserve the selected chart until the next poll refreshes its history.
      setSnapshot((previous) => ({ ...next, activity: previous?.activity ?? next.activity }));
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { toggleGeneration.current += 1; setPending(false); }
  }, [desktopApi, pending, snapshot]);
  return { snapshot, error, pending, toggle };
}

export function federationRuntimeLabel(snapshot: ReadFederationActivityResponse): string {
  if (snapshot.health.leaseHolder) return "Not running · lease held by another instance";
  if (snapshot.running) return `Running · ${snapshot.health.status}`;
  return snapshot.configuredMode === "disabled" ? "Stopped" : "Not running";
}
