import { useEffect, useState } from "react";
import type { DesktopConfigBootstrapSnapshot } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";

export type DesktopConfigBootstrapState = Readonly<{
  snapshot?: DesktopConfigBootstrapSnapshot;
  error?: string;
}>;

export function useDesktopConfigBootstrap(
  desktopApi?: DesktopApi,
): DesktopConfigBootstrapState {
  const [state, setState] = useState<DesktopConfigBootstrapState>({});

  useEffect(() => {
    let cancelled = false;
    if (!desktopApi?.readConfigBootstrap) {
      setState({});
      return;
    }
    void desktopApi.readConfigBootstrap().then(
      (response) => {
        if (!cancelled) {
          setState({ snapshot: response.snapshot });
        }
      },
      (error) => {
        if (!cancelled) {
          setState({
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [desktopApi]);

  return state;
}
