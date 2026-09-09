import { useEffect, useState } from "react";

export function FederationTrafficCapture({ until, disabled, onChange }: {
  until?: number;
  disabled: boolean;
  onChange: (enabled: boolean) => void;
}) {
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
  const seconds = until ? Math.max(0, Math.ceil((until - now) / 1_000)) : 0;
  return <label title="Log frame metadata and byte counts at info level for all connections on this instance. Payload contents are excluded. Stops automatically after 60 seconds.">
    <input type="checkbox" aria-label="Capture detailed Federation traffic"
      checked={seconds > 0} disabled={disabled}
      onChange={(event) => onChange(event.target.checked)} />
    {seconds > 0 ? ` Detailed logs · ${seconds}s left` : " Detailed logs for 60 seconds"}
  </label>;
}
