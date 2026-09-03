import type { ReactElement } from "react";
import { getDesktopApi, type DesktopApi } from "../../lib/desktop-api";
import { readRendererFederationTarget } from "../../lib/federation-window";
import { FederationRemoteBadge } from "./FederationRemoteBadge";
import type { FederationThreadTarget } from "./federation-thread-targets";
import { MessagingStatusBar } from "../messaging-status/MessagingStatusBar";
import { AppMenuBar } from "./AppMenuBar";
import { NewThreadButton } from "./NewThreadButton";

/**
 * Only what the strip reads. The panel toggles themselves live in the view
 * header, so this carries no callbacks — widening it back into a full control
 * set is how the duplicate Star Map got here.
 */
export type AppTitleBarLayoutControls = {
  sidebarOpen: boolean;
};

/**
 * Windows-only custom title bar (GitHub-Desktop style). Under
 * `titleBarStyle: "hidden"` the native strip is gone, so this one replaces it:
 *
 *   [PwrAgent] File … Help  [automations][settings][new]  …drag…  [MSG]   — ▢ ✕
 *
 * The OS caption buttons (min/max/close) are drawn by the Window Controls
 * Overlay at the far right; this strip fills the rest of the line. On Windows
 * the sidebar masthead (wordmark + action buttons) and the per-screen MSG
 * button are hidden (app.css), so these are their single home.
 *
 * This strip carries only what the OS itself would: the wordmark, the
 * application menu, the app-level actions, and the one global Messaging
 * controller. VIEW chrome — history, breadcrumb, thread chips, panel toggles,
 * terminal, Star Map — stays in the view's own header on every platform, so
 * the cluster reads as one group instead of being split across two rows. The
 * split is why Windows briefly showed two Star Map buttons: the strip drew one
 * and the thread header drew another. Add a view-scoped control to
 * `ThreadHeader`, never here.
 *
 * Renders nothing off win32 — macOS keeps `hiddenInset`, the sidebar masthead,
 * and the per-screen MSG button unchanged. `actions`/`desktopApi` are absent in
 * the fatal/startup app states, where only the wordmark + menu render.
 */
export function AppTitleBar(props: {
  desktopApi?: DesktopApi;
  onOpenMessagingActivity?: () => void;
  onOpenMessagingSettings?: () => void;
  layout?: AppTitleBarLayoutControls;
  actions?: {
    addingProjectDirectory?: boolean;
    automationsActive: boolean;
    newThreadDirectoryLabel?: string;
    newThreadFederationTargets?: readonly FederationThreadTarget[];
    settingsActive: boolean;
    creatingThread: boolean;
    onAddProjectDirectory?: () => void | Promise<void>;
    onOpenAutomations: () => void;
    onOpenSettings: () => void;
    onCreateThread: () => void | Promise<void>;
    onCreateThreadWithoutDirectory?: () => void | Promise<void>;
    onCreateThreadOnFederationTarget?: (
      instanceId: string,
    ) => void | Promise<void>;
  };
}): ReactElement | null {
  const isWindows = getDesktopApi()?.platform === "win32";
  if (!isWindows) return null;

  // Automations and Settings open LOCAL surfaces; hide them in a remote
  // federation window so the strip never implies remote settings.
  const isFederationWindow = Boolean(readRendererFederationTarget());
  const actions = props.actions;
  return (
    <div className="app-titlebar">
      <div className="app-titlebar__left">
        <p className="app-titlebar__brand">
          Pwr<span className="app-titlebar__brand-accent">Agent</span>
        </p>
        {/* While the sidebar is open its identity pill is the remote
            marker; once it's hidden this strip is the only home left.
            (Absent layout — fatal/startup states — keep the badge so the
            window is never unmarked.) */}
        {props.layout?.sidebarOpen ? null : <FederationRemoteBadge />}
        <AppMenuBar />
        {actions ? (
          <div className="app-titlebar__actions">
            {isFederationWindow ? null : (
            <button
              type="button"
              aria-label="Open automations"
              aria-pressed={actions.automationsActive}
              className={`sidebar__icon-button${actions.automationsActive ? " is-active" : ""}`}
              onClick={actions.onOpenAutomations}
            >
              <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M8 2v4"/><path d="M16 2v4"/><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M3 10h18"/><path d="M8 14h.01"/><path d="M12 14h.01"/><path d="M16 14h.01"/><path d="M8 18h.01"/><path d="M12 18h.01"/></svg>
            </button>
            )}
            {isFederationWindow ? null : (
            <button
              type="button"
              aria-label="Open settings"
              aria-pressed={actions.settingsActive}
              className={`sidebar__icon-button${actions.settingsActive ? " is-active" : ""}`}
              onClick={actions.onOpenSettings}
            >
              <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
            </button>
            )}
            <NewThreadButton
              addingProjectDirectory={actions.addingProjectDirectory}
              creatingThread={actions.creatingThread}
              directoryLabel={actions.newThreadDirectoryLabel}
              onAddProjectDirectory={actions.onAddProjectDirectory}
              onCreateThread={actions.onCreateThread}
              onCreateThreadWithoutDirectory={
                actions.onCreateThreadWithoutDirectory
              }
              onCreateThreadOnTarget={
                actions.onCreateThreadOnFederationTarget
              }
              remoteTargets={actions.newThreadFederationTargets}
            />
          </div>
        ) : null}
      </div>
      <div className="app-titlebar__spacer" />
      {props.desktopApi ? (
        <div className="app-titlebar__right">
          <MessagingStatusBar
            desktopApi={props.desktopApi}
            onOpenActivity={props.onOpenMessagingActivity}
            onOpenSettings={props.onOpenMessagingSettings}
          />
        </div>
      ) : null}
    </div>
  );
}
