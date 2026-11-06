import { useEffect, useRef, useState } from "react";
import type {
  DesktopManagedGitSnapshot,
  ManagedGitActionRequest,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import {
  ManagedRuntimeProgressStrip,
  useManagedRuntimeProgress,
} from "./ManagedRuntimeProgress";
import {
  managedGitUpdatesCopy,
  type ManagedGitUpdatesAction,
} from "./managed-git-updates-copy";

const BUSY_PHASES = new Set(["checking", "downloading", "verifying", "unpacking", "activating"]);
const DOT_TONE = { ok: " status-dot--ok", notice: " status-dot--warning", error: " status-dot--error", idle: "" } as const;

/**
 * Settings → Git → Updates: newer PwrDrvr Git releases, downloaded and
 * verified on request. Every action is a button the operator presses, and
 * only Use and Roll back change which Git runs.
 */
export function ManagedGitUpdates(props: {
  desktopApi?: DesktopApi;
  managed: DesktopManagedGitSnapshot;
  /** PWRAGENT_GIT_PATH wins over anything chosen here. */
  envForced: boolean;
  /** A manual or installed Git path is selected, which wins over a download. */
  manualPathSelected: boolean;
  disabled: boolean;
  /**
   * Re-read settings. `rescan` probes every Git again; an action's own reply
   * has already done that when the action changed the list.
   */
  onRefresh: (rescan: boolean) => Promise<void>;
}) {
  const { desktopApi, managed } = props;
  const progress = useManagedRuntimeProgress(desktopApi, "git");
  const [pending, setPending] = useState<ManagedGitActionRequest["action"]>();
  const installingHereRef = useRef(false);
  const [error, setError] = useState<string>();
  const onRefreshRef = useRef(props.onRefresh);
  onRefreshRef.current = props.onRefresh;

  const run = async (request: ManagedGitActionRequest, quiet = false): Promise<void> => {
    if (!desktopApi?.managedGitAction) return;
    if (!quiet) {
      setPending(request.action);
      setError(undefined);
    }
    if (request.action === "install") installingHereRef.current = true;
    try {
      const response = await desktopApi.managedGitAction(request);
      if (response.error && !quiet) setError(response.error);
      await onRefreshRef.current(false);
    } catch (caught) {
      if (!quiet) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (request.action === "install") installingHereRef.current = false;
      if (!quiet) setPending(undefined);
    }
  };

  // Opening the pane asks GitHub only when the last check is hours old.
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => {
    if (managed.supported) void runRef.current({ action: "check", ifStale: true }, true);
  }, [managed.supported]);

  // Another window finished an install; the rows behind this one are stale.
  const readyAt = progress?.phase === "ready" ? progress.updatedAt : undefined;
  useEffect(() => {
    // This window's own install re-probes in its reply.
    if (readyAt !== undefined && !installingHereRef.current) void onRefreshRef.current(true);
  }, [readyAt]);

  if (!managed.supported) return null;

  const installing = (progress !== undefined && BUSY_PHASES.has(progress.phase)) || pending === "install";
  const copy = managedGitUpdatesCopy(managed, {
    now: Date.now(),
    manualPathSelected: props.manualPathSelected,
  });
  const locked = props.disabled || props.envForced || pending !== undefined;

  const onAction = (action: ManagedGitUpdatesAction): void => {
    switch (action.kind) {
      case "download":
        void run({ action: "install", tag: action.tag });
        return;
      case "use":
        void run({ action: "select", choice: { kind: "managed", generation: action.generation } });
        return;
      case "rollback":
        void run({ action: "select", choice: action.choice });
        return;
      case "check":
        void run({ action: "check" });
        return;
    }
  };

  return (
    <div className="managed-git-updates">
      {progress ? (
        <ManagedRuntimeProgressStrip
          progress={progress}
          onRetry={
            progress.phase === "failed" && progress.tag && !locked
              ? () => void run({ action: "install", tag: progress.tag! })
              : undefined
          }
        />
      ) : null}
      {installing ? (
        <div className="settings-inline-actions">
          <button
            className="button button--secondary"
            type="button"
            onClick={() => void desktopApi?.managedGitAction?.({ action: "cancel" })}
          >
            Cancel
          </button>
        </div>
      ) : (
        <div className="acp-build">
          <p className="acp-build__line">
            <span className={`status-dot${DOT_TONE[copy.tone]}`} aria-hidden="true" />
            {copy.tag ? <span className="acp-build__tag">{copy.tag}</span> : null}
            <span className={`acp-build__state${copy.tone === "error" ? " settings-error" : ""}`}>
              {copy.message}
            </span>
          </p>
          {copy.note ? <p className="acp-build__state managed-git-updates__note">{copy.note}</p> : null}
          <div className="settings-inline-actions">
            {copy.actions.map((action) => (
              <button
                key={`${action.kind}:${action.label}`}
                className={`button ${action.primary ? "button--primary" : "button--secondary"}`}
                disabled={locked}
                type="button"
                onClick={() => onAction(action)}
              >
                {action.kind === "check" && pending === "check" ? "Checking…" : action.label}
              </button>
            ))}
          </div>
        </div>
      )}
      {props.envForced ? (
        <p className="settings-empty">
          PWRAGENT_GIT_PATH is set, so it wins over anything chosen here.
        </p>
      ) : null}
      {error ? (
        <p className="acp-build__state settings-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
