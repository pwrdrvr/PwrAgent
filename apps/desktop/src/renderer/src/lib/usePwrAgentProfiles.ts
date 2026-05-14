import { useCallback, useEffect, useState } from "react";
import type {
  DesktopPwrAgentProfileSummary,
  ListDesktopPwrAgentProfilesResponse,
} from "@pwragent/shared";
import type { DesktopApi } from "./desktop-api";

export type PwrAgentProfilesState = {
  activeProfile?: string;
  defaultProfile?: string;
  error?: string;
  loading: boolean;
  profiles: DesktopPwrAgentProfileSummary[];
  deleteProfile: (profile: string) => Promise<void>;
  createProfile: (profile: string) => Promise<void>;
  openProfile: (profile: string) => Promise<void>;
  refresh: () => Promise<void>;
  setCodexProfile: (profile: string, codexProfile: string) => Promise<void>;
  setDefaultProfile: (profile: string) => Promise<void>;
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

  const createProfile = useCallback(
    async (profile: string) => {
      if (!desktopApi?.createPwrAgentProfile) return;
      await desktopApi.createPwrAgentProfile({ profile });
      await refresh();
    },
    [desktopApi, refresh],
  );

  const setDefaultProfile = useCallback(
    async (profile: string) => {
      if (!desktopApi?.setDefaultPwrAgentProfile) return;
      await desktopApi.setDefaultPwrAgentProfile({ profile });
      await refresh();
    },
    [desktopApi, refresh],
  );

  const deleteProfile = useCallback(
    async (profile: string) => {
      if (!desktopApi?.deletePwrAgentProfile) return;
      await desktopApi.deletePwrAgentProfile({ profile });
      await refresh();
    },
    [desktopApi, refresh],
  );

  const setCodexProfile = useCallback(
    async (profile: string, codexProfile: string) => {
      if (!desktopApi?.setPwrAgentProfileCodexProfile) return;
      await desktopApi.setPwrAgentProfileCodexProfile({
        profile,
        codexProfile,
      });
      await refresh();
    },
    [desktopApi, refresh],
  );

  return {
    activeProfile: response?.activeProfile,
    createProfile,
    defaultProfile: response?.defaultProfile,
    deleteProfile,
    error,
    loading,
    profiles: response?.profiles ?? [],
    openProfile,
    refresh,
    setCodexProfile,
    setDefaultProfile,
  };
}
