import { useEffect, useState } from "react";

/** Wall-clock time for countdowns, ticking only while something on screen is live. */
export function useResearchNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [live]);
  return now;
}
