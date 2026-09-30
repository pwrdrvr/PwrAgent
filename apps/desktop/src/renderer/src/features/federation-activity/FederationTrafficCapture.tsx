import { useEffect, useState } from "react";

/** Seconds left in a detailed capture, ticking once a second while it runs. */
export function useCaptureSecondsLeft(until: number | undefined): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    if (!until || until <= Date.now()) return;
    const timer = setInterval(() => {
      const next = Date.now();
      setNow(next);
      if (next >= until) clearInterval(timer);
    }, 1_000);
    return () => clearInterval(timer);
  }, [until]);
  return until ? Math.max(0, Math.ceil((until - now) / 1_000)) : 0;
}

export const FEDERATION_CAPTURE_DESCRIPTION = "Save the preceding 60 seconds of frame metadata to the profile diagnostics folder, then log the next 60 seconds. History is bounded to 4 MB or 4,096 frames; overflow is reported. Payload contents are excluded.";

/** The header's REC tag while a detailed capture runs; nothing otherwise. */
export function FederationCaptureTag({ until }: { until?: number }) {
  const seconds = useCaptureSecondsLeft(until);
  if (seconds <= 0) return null;
  return <span className="federation-status-control__rec" title="Capturing detailed Federation traffic">
    REC · {seconds}s</span>;
}
