import { useCallback, useEffect, useRef, useState } from "react";
import type {
  PwrSuiteAppId,
  PwrSuiteInstallerActionResult,
  PwrSuiteInstallerState,
} from "../../../../shared/pwrsuite-installer";
import type { DesktopApi } from "../../lib/desktop-api";
import { connectionActionError } from "./usePwrSuiteConnectionStatus";

export type PwrSuiteInstaller = {
  /** This window can download installers (a local window, once asked to). */
  available: boolean;
  /** `undefined` until main answers, and in a window with no installer API. */
  state: PwrSuiteInstallerState | undefined;
  /** Open installer / Show in Finder failed; the download itself is fine. */
  actionError: string | undefined;
  start: () => void;
  cancel: () => void;
  open: () => void;
  reveal: () => void;
};

/**
 * A launchpad tile's view of its app's installer download. The download runs
 * in main, so a tile that mounts halfway through one reads where it is and
 * follows the events from there.
 */
export function usePwrSuiteInstaller(
  app: PwrSuiteAppId,
  desktopApi: DesktopApi | undefined,
): PwrSuiteInstaller {
  const [state, setState] = useState<PwrSuiteInstallerState>();
  const [actionError, setActionError] = useState<string>();
  const read = desktopApi?.readPwrSuiteInstaller;
  const subscribe = desktopApi?.onPwrSuiteInstaller;
  // An event is always newer than the read in flight beside it.
  const sawEvent = useRef(false);

  useEffect(() => {
    let cancelled = false;
    sawEvent.current = false;
    const unsubscribe = subscribe?.((next) => {
      if (cancelled || next.app !== app) return;
      sawEvent.current = true;
      setState(next);
    });
    read?.(app)
      .then((next) => {
        if (!cancelled && !sawEvent.current) setState(next);
      })
      .catch(() => {
        // No state means the tile falls back to the product page.
      });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [app, read, subscribe]);

  const startDownload = desktopApi?.startPwrSuiteDownload;
  const cancelDownload = desktopApi?.cancelPwrSuiteDownload;
  const openInstaller = desktopApi?.openPwrSuiteInstaller;
  const revealInstaller = desktopApi?.revealPwrSuiteInstaller;

  const start = useCallback(() => {
    setActionError(undefined);
    void startDownload?.(app)
      .then((next) => {
        // Events may already have moved past the answer to the start.
        if (!sawEvent.current) setState(next);
      })
      .catch((cause: unknown) => setActionError(connectionActionError(cause)));
  }, [app, startDownload]);

  const cancel = useCallback(() => {
    void cancelDownload?.(app).catch(() => undefined);
  }, [app, cancelDownload]);

  const runFileAction = useCallback(
    (action: ((app: PwrSuiteAppId) => Promise<PwrSuiteInstallerActionResult>) | undefined) => {
      setActionError(undefined);
      void action?.(app)
        .then((result) => {
          if (!result.opened) setActionError(result.error ?? "Couldn't open the installer");
        })
        .catch((cause: unknown) => setActionError(connectionActionError(cause)));
    },
    [app],
  );

  return {
    available: read !== undefined,
    state,
    actionError,
    start,
    cancel,
    open: useCallback(() => runFileAction(openInstaller), [openInstaller, runFileAction]),
    reveal: useCallback(() => runFileAction(revealInstaller), [revealInstaller, runFileAction]),
  };
}
