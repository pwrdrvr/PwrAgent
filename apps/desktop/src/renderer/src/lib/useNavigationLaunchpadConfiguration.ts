import { useCallback, useEffect, useRef, useState } from "react";
import type { FederationTarget, NavigationLaunchpadConfigResponse } from "@pwragent/shared";
import type { DesktopApi } from "./desktop-api";

type ConfigurationState = { key: string; value?: NavigationLaunchpadConfigResponse; error?: string; ready: boolean };

/** Configuration has its own readiness and never waits for a collection page. */
export function useNavigationLaunchpadConfiguration(params: {
  desktopApi?: DesktopApi;
  enabled: boolean;
  directoryKey?: string;
  federationTarget?: FederationTarget;
}) {
  const key = JSON.stringify([params.federationTarget ?? { scope: "local" }, params.directoryKey ?? null]);
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const sequenceRef = useRef(0);
  const [state, setState] = useState<ConfigurationState>();
  const refresh = useCallback(async () => {
    const current = paramsRef.current;
    if (!current.enabled) return;
    const requestKey = JSON.stringify([current.federationTarget ?? { scope: "local" }, current.directoryKey ?? null]);
    const sequence = ++sequenceRef.current;
    setState((previous) => ({ key: requestKey, ready: false, value: previous?.key === requestKey ? previous.value : undefined }));
    try {
      if (!current.desktopApi?.getNavigationLaunchpadConfig) throw new Error("Upgrade this instance to read launchpad configuration.");
      const value = await current.desktopApi.getNavigationLaunchpadConfig({ protocol: 2,
        federationTarget: current.federationTarget, directoryKey: current.directoryKey,
      });
      if (sequenceRef.current !== sequence) return;
      if (value.protocol !== 2 || value.unchanged || !value.defaults || value.directoryKey !== current.directoryKey) {
        throw new Error("Launchpad configuration has no matching owner baseline.");
      }
      setState({ key: requestKey, value, ready: true });
    } catch (error) {
      if (sequenceRef.current !== sequence) return;
      setState((previous) => ({ key: requestKey, ready: false, value: previous?.key === requestKey ? previous.value : undefined,
        error: error instanceof Error ? error.message : String(error) }));
    }
  }, []);
  useEffect(() => {
    if (params.enabled) void refresh();
    else setState((previous) => previous ? { ...previous, ready: false } : previous);
    return () => { sequenceRef.current += 1; };
  }, [params.desktopApi, params.enabled, key, refresh]);
  return { ...(state?.key === key ? state : { key, ready: false }), refresh };
}
