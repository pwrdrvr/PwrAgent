import { useEffect, useState } from "react";
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
 * nav sub-items and the AI Providers hub index. Reads only the cached
 * catalog and re-reads when an explicit Settings/setup action announces new
 * summaries. Mounting navigation or a provider screen is never authority to
 * probe or launch an agent.
 */
export function useAcpAgentCatalog(
  desktopApi: DesktopApi | undefined,
): AcpAgentCatalogState {
  const [entries, setEntries] = useState<AcpAgentSettingsEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const listAcpAgents = desktopApi?.listAcpAgents;

  useEffect(() => {
    if (!listAcpAgents) {
      return;
    }
    let disposed = false;
    const read = async (): Promise<void> => {
      try {
        const response = await listAcpAgents({
          refresh: false,
        });
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
      void read();
    };
    window.addEventListener(
      BACKEND_SUMMARIES_REFRESH_EVENT,
      onSummariesRefreshed,
    );
    void read();
    return () => {
      disposed = true;
      window.removeEventListener(
        BACKEND_SUMMARIES_REFRESH_EVENT,
        onSummariesRefreshed,
      );
    };
  }, [listAcpAgents]);

  return { entries, loaded, error, unavailable: listAcpAgents === undefined };
}
