import { useEffect, useRef, useState } from "react";
import type { FederationTarget, NavigationLaunchpadConfigResponse } from "@pwragent/shared";
import type { DesktopApi } from "./desktop-api";

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
  const [state, setState] = useState<{ key: string; value?: NavigationLaunchpadConfigResponse; error?: string; ready: boolean }>();
  useEffect(() => {
    let closed = false;
    const current = paramsRef.current;
    if (!current.enabled) return;
    setState((previous) => ({ key, ready: false, value: previous?.key === key ? previous.value : undefined }));
    void (async () => {
      try {
        if (!current.desktopApi?.getNavigationLaunchpadConfig) throw new Error("Upgrade this instance to read launchpad configuration.");
        const value = await current.desktopApi.getNavigationLaunchpadConfig({ protocol: 2,
          federationTarget: current.federationTarget, directoryKey: current.directoryKey,
        });
        if (closed) return;
        if (value.protocol !== 2 || value.unchanged || !value.defaults || value.directoryKey !== current.directoryKey) {
          throw new Error("Launchpad configuration has no matching owner baseline.");
        }
        setState({ key, value, ready: true });
      } catch (error) {
        if (!closed) setState((previous) => ({ key, ready: false, value: previous?.key === key ? previous.value : undefined,
          error: error instanceof Error ? error.message : String(error) }));
      }
    })();
    return () => { closed = true; };
  }, [params.desktopApi, params.enabled, key]);
  return state?.key === key ? state : { key, ready: false };
}
