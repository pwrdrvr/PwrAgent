import { useEffect, useState } from "react";
import { formatRunningDurationMs } from "../../lib/format-duration";

export function StartupTiming(props: { submittedAt: number; startedAt?: number; compact?: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const submitted = new Date(props.submittedAt);
  const started = props.startedAt === undefined ? undefined : new Date(props.startedAt);
  const elapsed = formatRunningDurationMs(Math.max(0, now - props.submittedAt));
  const title = `Submitted ${submitted.toISOString()}${started ? ` · Owner started ${started.toISOString()}` : " · Waiting for owner"}`;
  return <span className="tooltip-target" data-tooltip={title}>
    {props.compact ? `Starting · ${elapsed}` : <>
      Submitted <time dateTime={submitted.toISOString()}>{submitted.toLocaleTimeString()}</time>
      {started ? <> · Owner started <time dateTime={started.toISOString()}>{started.toLocaleTimeString()}</time></> : " · Waiting for owner"}
      {` · ${elapsed} elapsed`}
    </>}
  </span>;
}
