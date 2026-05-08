import { useCallback, useEffect, useState } from "react";
import type {
  DesktopPwrAgentProfileSummary,
  ListDesktopPwrAgentProfilesResponse,
} from "@pwragent/shared";
import type { DesktopApi } from "./desktop-api";

export type PwrAgentProfilesState = {
  activeProfile?: string;
  error?: string;
  loading: boolean;
  profiles: DesktopPwrAgentProfileSummary[];
  openProfile: (profile: string) => Promise<void>;
  refresh: () => Promise<void>;
};

export function usePwrAgentProfiles(
  desktopApi?: DesktopApi,
): PwrAgentProfilesState {
  const [response, setResponse] = useState<ListDesktopPwrAgentProfilesResponse>();
  const [loading, setLoading] = useState(Boolean(desktopApi?.listPwrAgentProfiles));
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    if (!desktopApi?.listPwrAgentProfiles) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(undefined);
    try {
      setResponse(await desktopApi.listPwrAgentProfiles());
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setLoading(false);
    }
  }, [desktopApi]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openProfile = useCallback(
    async (profile: string) => {
      if (!desktopApi?.openPwrAgentProfile) return;
      await desktopApi.openPwrAgentProfile({ profile });
      await refresh();
    },
    [desktopApi, refresh],
  );

  return {
    activeProfile: response?.activeProfile,
    error,
    loading,
    profiles: response?.profiles ?? [],
    openProfile,
    refresh,
  };
}
