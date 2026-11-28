import { useCallback, useRef, useState } from "react";
import type { RefreshDesktopCodexDiscoveryRequest } from "@pwragent/shared/contracts/settings";
import type { ManagedRuntimeProgress } from "../../../../shared/managed-runtime-progress";
import type { DesktopApi } from "../../lib/desktop-api";
import { ipcErrorMessage } from "../../lib/open-path-failure";
import { useManagedRuntimeProgress } from "./ManagedRuntimeProgress";

export type OpenAiCodexInstall = {
  /** The `openai-codex` download, from any window or the daily check. */
  progress?: ManagedRuntimeProgress;
  /** This window's own request is running. */
  installing: boolean;
  /** Why this window's request failed, when it failed. */
  error?: string;
  install: () => Promise<void>;
};

/**
 * Install or update OpenAI's Codex under the PwrAgent root, then rediscover so
 * it can be selected. Get started, the version notice and Settings → Codex all
 * make this one request, so they agree on what "Install latest Codex" does.
 *
 * The progress is the `openai-codex` runtime's, wherever it started: a
 * background update check reports there too, so a failure it hits shows up
 * on every surface that follows it.
 */
export function useOpenAiCodexInstall(params: {
  desktopApi?: Pick<
    DesktopApi,
    "refreshCodexDiscovery" | "onManagedRuntimeProgress" | "readManagedRuntimeProgress"
  >;
  discoveryIntent: RefreshDesktopCodexDiscoveryRequest["discoveryIntent"];
  /** Re-read what the install changed once it returns. */
  onInstalled?: () => Promise<void>;
}): OpenAiCodexInstall {
  const { desktopApi, discoveryIntent, onInstalled } = params;
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string>();
  const inFlight = useRef(false);
  const progress = useManagedRuntimeProgress(desktopApi, "openai-codex");
  const install = useCallback(async (): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setInstalling(true);
    setError(undefined);
    try {
      if (!desktopApi?.refreshCodexDiscovery) {
        setError("PwrAgent couldn't install Codex. Install it yourself instead.");
        return;
      }
      await desktopApi.refreshCodexDiscovery({ discoveryIntent, installOpenAiCodex: true });
      await onInstalled?.();
    } catch (caught) {
      setError(ipcErrorMessage(caught));
    } finally {
      inFlight.current = false;
      setInstalling(false);
    }
  }, [desktopApi, discoveryIntent, onInstalled]);
  return {
    installing,
    install,
    ...(progress ? { progress } : {}),
    ...(error ? { error } : {}),
  };
}
