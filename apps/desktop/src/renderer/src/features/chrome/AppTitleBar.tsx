import type { ReactElement } from "react";
import { getDesktopApi, type DesktopApi } from "../../lib/desktop-api";
import { readRendererFederationTarget } from "../../lib/federation-window";
import { MessagingStatusBar } from "../messaging-status/MessagingStatusBar";
import { AppMenuBar } from "./AppMenuBar";
import { NewThreadButton } from "./NewThreadButton";
import { PanelToggleButtons } from "./PanelToggleButtons";

export type AppTitleBarLayoutControls = {
  sidebarOpen: boolean;
  railOpen: boolean;
  onToggleSidebar: () => void;
  onToggleRail: () => void;
};

/**
 * Windows-only custom title bar (GitHub-Desktop style). Consolidates the chrome
 * the native title bar would otherwise own into one frameless strip:
 *
 *   [PwrAgent] File … Help  [automations][settings][new]  …drag…  [MSG]   — ▢ ✕
 *
 * The OS caption buttons (min/max/close) are drawn by the Window Controls
 * Overlay at the far right; this strip fills the rest of the line. On Windows
 * the sidebar masthead (wordmark + action buttons) and the per-screen MSG
 * button are hidden (app.css), so these are their single home.
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
    settingsActive: boolean;
    creatingThread: boolean;
    onAddProjectDirectory?: () => void | Promise<void>;
    onOpenAutomations: () => void;
    onOpenSettings: () => void;
    onCreateThread: () => void | Promise<void>;
    onCreateThreadWithoutDirectory?: () => void | Promise<void>;
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
            />
          </div>
        ) : null}
      </div>
      <div className="app-titlebar__spacer" />
      {props.layout || props.desktopApi ? (
        <div className="app-titlebar__right">
          {props.layout ? (
            <PanelToggleButtons
              sidebarOpen={props.layout.sidebarOpen}
              railOpen={props.layout.railOpen}
              onToggleSidebar={props.layout.onToggleSidebar}
              onToggleRail={props.layout.onToggleRail}
            />
          ) : null}
          {props.desktopApi ? (
            <MessagingStatusBar
              desktopApi={props.desktopApi}
              onOpenActivity={props.onOpenMessagingActivity}
              onOpenSettings={props.onOpenMessagingSettings}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
