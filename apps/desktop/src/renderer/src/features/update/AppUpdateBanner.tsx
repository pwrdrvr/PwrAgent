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
  // A downgrade is the operator moving back onto the channel they picked, not
  // an update landing on them, so it gets its own wording.
  const switchingBack =
    updateStatus.status === "downloaded"
    && updateStatus.direction === "downgrade";

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
        <p className="app-update-banner__eyebrow">
          {switchingBack ? "Switch ready" : "Update ready"}
        </p>
        <p className="app-update-banner__message">
          {switchingBack
            ? `Restart to switch to v${version}.`
            : `Restart to update to v${version}.`}
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
          aria-label={
            switchingBack
              ? "Dismiss channel switch notification"
              : "Dismiss update notification"
          }
          onClick={() => setDismissedVersion(version)}
        >
          Dismiss
        </button>
      </div>
    </aside>
  );
}
