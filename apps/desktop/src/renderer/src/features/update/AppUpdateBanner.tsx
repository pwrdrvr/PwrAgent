import { useEffect, useState } from "react";
import type { AppUpdateStatus } from "../../../../shared/app-metadata";
import type { DesktopApi } from "../../lib/desktop-api";

export function AppUpdateBanner(props: { desktopApi?: DesktopApi }) {
  const [updateStatus, setUpdateStatus] = useState<AppUpdateStatus>({
    status: "idle",
  });
  const [dismissedVersion, setDismissedVersion] = useState<string | undefined>();
  const [restartError, setRestartError] = useState<string | undefined>();
  const [restarting, setRestarting] = useState(false);
  const desktopApi = props.desktopApi;

  useEffect(() => {
    let cancelled = false;
    let receivedEvent = false;
    const unsubscribe = desktopApi?.onAppUpdateStatus?.((status) => {
      receivedEvent = true;
      setUpdateStatus(status);
    });
    void desktopApi?.readAppUpdateStatus?.().then((status) => {
      if (!cancelled && !receivedEvent) {
        setUpdateStatus(status);
      }
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [desktopApi]);

  const version =
    updateStatus.status === "downloaded" ? updateStatus.version : undefined;

  useEffect(() => {
    if (!version || dismissedVersion === version) {
      return;
    }
    setRestartError(undefined);
    setRestarting(false);
  }, [dismissedVersion, version]);

  if (!version || dismissedVersion === version) {
    return null;
  }

  const handleRestart = async () => {
    if (!desktopApi?.installAppUpdate) {
      setRestartError("Restart is not available in this build.");
      return;
    }
    setRestarting(true);
    setRestartError(undefined);
    const result = await desktopApi.installAppUpdate();
    if (result.status === "error") {
      setRestartError(result.message);
      setRestarting(false);
    }
  };

  return (
    <aside className="app-update-banner" role="status" aria-live="polite">
      <div className="app-update-banner__content">
        <p className="app-update-banner__eyebrow">Update ready</p>
        <p className="app-update-banner__message">
          Restart to update to v{version}.
        </p>
        {restartError ? (
          <p className="app-update-banner__error">{restartError}</p>
        ) : null}
      </div>
      <div className="app-update-banner__actions">
        <button
          className="button button--primary app-update-banner__restart"
          type="button"
          disabled={restarting}
          onClick={() => {
            void handleRestart();
          }}
        >
          {restarting ? "Restarting..." : "Restart"}
        </button>
        <button
          className="button button--ghost app-update-banner__dismiss"
          type="button"
          disabled={restarting}
          aria-label="Dismiss update notification"
          onClick={() => setDismissedVersion(version)}
        >
          Dismiss
        </button>
      </div>
    </aside>
  );
}
