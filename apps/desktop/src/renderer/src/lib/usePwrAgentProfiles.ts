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
  /** `order` names every listed profile; main refuses a stale one. */
  reorderProfiles: (order: string[]) => Promise<void>;
  setCodexProfile: (profile: string, codexProfile: string) => Promise<void>;
  setDefaultProfile: (profile: string) => Promise<void>;
  setShowInMenu: (profile: string, showInMenu: boolean) => Promise<void>;
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

  const reorderProfiles = useCallback(
    async (order: string[]) => {
      if (!desktopApi?.reorderPwrAgentProfiles) return;
      // Show the drop where it landed while main writes it. A refused order
      // is stale by definition, so the refresh below replaces this guess
      // with what main actually holds either way.
      setResponse((current) => {
        if (!current) return current;
        const byName = new Map(
          current.profiles.map((profile) => [profile.name, profile]),
        );
        const reordered = order
          .map((name) => byName.get(name))
          .filter((profile) => profile !== undefined);
        return reordered.length === current.profiles.length
          ? { ...current, profiles: reordered }
          : current;
      });
      try {
        await desktopApi.reorderPwrAgentProfiles({ order });
      } finally {
        await refresh();
      }
    },
    [desktopApi, refresh],
  );

  const setShowInMenu = useCallback(
    async (profile: string, showInMenu: boolean) => {
      if (!desktopApi?.setPwrAgentProfileMenuVisibility) return;
      await desktopApi.setPwrAgentProfileMenuVisibility({ profile, showInMenu });
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
    reorderProfiles,
    setCodexProfile,
    setDefaultProfile,
    setShowInMenu,
  };
}
