import { useEffect, useState } from "react";

/** A visible Electron window can be behind another app. Both signals matter. */
export function useStarMapForeground(): boolean {
  const [active, setActive] = useState(() => document.visibilityState === "visible" && document.hasFocus());
  useEffect(() => {
    const update = () => setActive(document.visibilityState === "visible" && document.hasFocus());
    const blur = () => setActive(false);
    window.addEventListener("focus", update);
    window.addEventListener("blur", blur);
    document.addEventListener("visibilitychange", update);
    update();
    return () => {
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", blur);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  return active;
}
