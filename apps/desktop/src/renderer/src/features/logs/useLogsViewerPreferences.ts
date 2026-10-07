import { useCallback, useEffect, useRef, useState } from "react";
import {
  DESKTOP_LOGS_VIEWER_DEFAULTS,
  resolveDesktopLogsViewerPreferences,
  type DesktopLogsViewerPreferences,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";

/**
 * The Logs window's remembered settings (`[ui.logs]` in the profile config).
 * Starts on the defaults, adopts the stored values from the config bootstrap
 * read, and writes each change back. A key the operator changes before the
 * bootstrap read lands keeps the operator's value.
 */
export function useLogsViewerPreferences(
  desktopApi: DesktopApi | undefined,
): [
  DesktopLogsViewerPreferences,
  (patch: Partial<DesktopLogsViewerPreferences>) => void,
] {
  const [preferences, setPreferences] = useState<DesktopLogsViewerPreferences>(
    () => resolveDesktopLogsViewerPreferences(DESKTOP_LOGS_VIEWER_DEFAULTS),
  );
  const touchedRef = useRef(new Set<keyof DesktopLogsViewerPreferences>());

  useEffect(() => {
    let cancelled = false;
    void desktopApi?.readConfigBootstrap?.().then(
      (response) => {
        if (cancelled || !response.snapshot.logs) return;
        const stored = resolveDesktopLogsViewerPreferences(response.snapshot.logs);
        setPreferences((current) => {
          const next = { ...stored };
          for (const key of touchedRef.current) {
            (next as Record<string, unknown>)[key] = current[key];
          }
          return next;
        });
      },
      (error: unknown) => {
        console.error("Failed to read Logs window preferences", error);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [desktopApi]);

  const update = useCallback(
    (patch: Partial<DesktopLogsViewerPreferences>) => {
      for (const key of Object.keys(patch) as Array<keyof DesktopLogsViewerPreferences>) {
        touchedRef.current.add(key);
      }
      setPreferences((current) => ({ ...current, ...patch }));
      void desktopApi
        ?.writeSettingsConfig?.({ patch: { ui: { logs: patch } } })
        .catch((error: unknown) => {
          console.error("Failed to save Logs window preferences", error);
        });
    },
    [desktopApi],
  );

  return [preferences, update];
}
