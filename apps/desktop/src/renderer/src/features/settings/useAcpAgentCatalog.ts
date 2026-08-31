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

/**
 * Light read of the ACP agent catalog for surfaces that need names and
 * status but do not own the full per-agent editing flow: the settings
 * nav sub-items and the AI Providers hub index. Reads the cached
 * catalog immediately; with `probe` it then asks the registry to
 * refresh stale agents (the main process coalesces concurrent
 * refreshes) and re-reads when any surface announces new summaries.
 */
export function useAcpAgentCatalog(
  desktopApi: DesktopApi | undefined,
  options?: { probe?: boolean },
): { entries: AcpAgentSettingsEntry[] } {
  const [entries, setEntries] = useState<AcpAgentSettingsEntry[]>([]);
  const probe = options?.probe === true;

  useEffect(() => {
    const listAcpAgents = desktopApi?.listAcpAgents;
    if (!listAcpAgents) {
      return;
    }
    let disposed = false;
    const read = async (refresh: boolean): Promise<void> => {
      try {
        const response = await listAcpAgents({ refresh });
        if (disposed) {
          return;
        }
        setEntries(response.entries);
        if (refresh) {
          window.dispatchEvent(new Event(BACKEND_SUMMARIES_REFRESH_EVENT));
        }
      } catch {
        // Status decoration only — keep whatever entries we last saw.
      }
    };
    const onSummariesRefreshed = (): void => {
      void read(false);
    };
    window.addEventListener(
      BACKEND_SUMMARIES_REFRESH_EVENT,
      onSummariesRefreshed,
    );
    if (probe) {
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
  }, [desktopApi, probe]);

  return { entries };
}
