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
  return <label title="Save the preceding 60 seconds of frame metadata to the profile diagnostics folder, then log the next 60 seconds. History is bounded to 4 MB or 4,096 frames; overflow is reported. Payload contents are excluded.">
    <input type="checkbox" aria-label="Capture detailed Federation traffic"
      checked={seconds > 0} disabled={disabled}
      onChange={(event) => onChange(event.target.checked)} />
    {seconds > 0 ? ` Detailed logs · ${seconds}s left` : " Capture previous + next 60 seconds"}
  </label>;
}
