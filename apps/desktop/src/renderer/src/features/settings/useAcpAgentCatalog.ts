import { useEffect, useRef, useState } from "react";
import type {
  AcpAgentSettingsEntry,
  DesktopSettingsSnapshot,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { BACKEND_SUMMARIES_REFRESH_EVENT } from "../../lib/useBackendSummaries";

/**
 * Settings-screen display order. Gemini CLI sorts last: Google withdrew CLI
 * access for regular consumer accounts, so the section is unusable for most
 * operators. Display-only — the IPC/catalog order from listAcpAgents is
 * unchanged for other consumers.
 */
export function displayOrderedAcpEntries(
  entries: AcpAgentSettingsEntry[],
): AcpAgentSettingsEntry[] {
  return [
    ...entries.filter((entry) => entry.registryId !== "gemini"),
    ...entries.filter((entry) => entry.registryId === "gemini"),
  ];
}

/** Whether an agent is enabled per the snapshot (defaults to enabled). */
export function acpAgentEnabledInSnapshot(
  snapshot: DesktopSettingsSnapshot | undefined,
  registryId: string,
): boolean {
  const agents = snapshot?.acpAgents as
    | Record<string, { enabled?: boolean } | undefined>
    | undefined;
  return agents?.[registryId]?.enabled !== false;
}

export type AcpAgentCatalogState = {
  entries: AcpAgentSettingsEntry[];
  /** True once a read has settled, successfully or not. */
  loaded: boolean;
  /** Message from the most recent failed read, cleared on success. */
  error?: string;
  /** True when this build exposes no ACP registry IPC at all. */
  unavailable: boolean;
};

/**
 * Light read of the ACP agent catalog for surfaces that need names and
 * status but do not own the full per-agent editing flow: the settings
 * nav sub-items and the AI Providers hub index. Reads the cached
 * catalog immediately; with `probe` it then asks the registry to
 * refresh stale agents once per mount (the main process coalesces
 * concurrent refreshes) and re-reads when any surface announces new
 * summaries.
 */
export function useAcpAgentCatalog(
  desktopApi: DesktopApi | undefined,
  options?: { probe?: boolean },
): AcpAgentCatalogState {
  const [entries, setEntries] = useState<AcpAgentSettingsEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const probe = options?.probe === true;
  // The probe runs once per mounted consumer, not once per effect run —
  // `probe` flips with hub↔focused navigation and re-probing (plus the
  // event fan-out it triggers) on every hop is pure churn.
  const probedRef = useRef(false);
  // Set just before this instance dispatches the refresh event so its
  // own listener can skip the echo — the dispatching read already holds
  // the fresh response.
  const selfAnnouncedRef = useRef(false);
  const listAcpAgents = desktopApi?.listAcpAgents;

  useEffect(() => {
    if (!listAcpAgents) {
      return;
    }
    let disposed = false;
    const read = async (refresh: boolean): Promise<void> => {
      try {
        const response = await listAcpAgents({ refresh });
        if (refresh) {
          // The main-process cache refreshed even if this consumer was
          // cleaned up mid-flight (hub→focused navigation), so always
          // announce — other catalog consumers have no push channel.
          if (!disposed) {
            selfAnnouncedRef.current = true;
          }
          window.dispatchEvent(new Event(BACKEND_SUMMARIES_REFRESH_EVENT));
        }
        if (disposed) {
          return;
        }
        setEntries(response.entries);
        setError(response.error);
        setLoaded(true);
      } catch (cause) {
        if (disposed) {
          return;
        }
        // Keep whatever entries we last saw, but surface the failure —
        // an empty catalog behind a swallowed error reads as "still
        // discovering" forever.
        setError(cause instanceof Error ? cause.message : String(cause));
        setLoaded(true);
      }
    };
    const onSummariesRefreshed = (): void => {
      if (selfAnnouncedRef.current) {
        selfAnnouncedRef.current = false;
        return;
      }
      void read(false);
    };
    window.addEventListener(
      BACKEND_SUMMARIES_REFRESH_EVENT,
      onSummariesRefreshed,
    );
    if (probe && !probedRef.current) {
      probedRef.current = true;
      void read(false).then(() => read(true));
    } else {
      void read(false);
    }
    return () => {
      disposed = true;
      window.removeEventListener(
        BACKEND_SUMMARIES_REFRESH_EVENT,
        onSummariesRefreshed,
      );
    };
  }, [listAcpAgents, probe]);

  return { entries, loaded, error, unavailable: listAcpAgents === undefined };
}
