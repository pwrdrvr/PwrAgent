import { useEffect, useState } from "react";
import type { DesktopApi } from "../../lib/desktop-api";

/**
 * The local instance's federation id, for the transcript watermark on
 * locally-owned threads. Undefined while loading and when federation has
 * never been configured — callers should render no watermark then.
 */
export function useLocalInstanceId(
  desktopApi: DesktopApi | undefined,
): string | undefined {
  const [instanceId, setInstanceId] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    desktopApi
      ?.readFederationHealth?.({})
      .then((response) => {
        if (!cancelled) {
          setInstanceId(response.health.instanceId);
        }
      })
      .catch(() => {
        // No federation runtime — no watermark.
      });
    return () => {
      cancelled = true;
    };
  }, [desktopApi]);

  return instanceId;
}
