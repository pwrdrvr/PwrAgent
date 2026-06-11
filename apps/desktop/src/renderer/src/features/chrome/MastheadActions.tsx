import type { ReactElement } from "react";
import { AutomationsIcon, NewThreadIcon, SearchIcon, SettingsIcon } from "../../icons";

/**
 * The window-level action buttons (Search / Automations / Settings / New
 * Thread) that live in the sidebar masthead. Extracted so they can also
 * render in the thread header when the sidebar is hidden — the buttons
 * otherwise vanish with the sidebar. Reuses the `.sidebar__icon-button`
 * styling so every placement reads identically.
 */
export type MastheadActionsProps = {
  automationsActive?: boolean;
  settingsActive?: boolean;
  threadSearchActive?: boolean;
  creatingThread?: boolean;
  onOpenAutomations?: () => void;
  onOpenSettings?: () => void;
  onToggleThreadSearch?: () => void;
  onCreateThread?: () => void | Promise<void>;
};

export function MastheadActions(props: MastheadActionsProps): ReactElement {
  return (
    <div className="masthead-actions">
      {props.onToggleThreadSearch ? (
        <button
          type="button"
          aria-label="Search threads"
          aria-pressed={props.threadSearchActive}
          className={`sidebar__icon-button${props.threadSearchActive ? " is-active" : ""}`}
          onClick={props.onToggleThreadSearch}
        >
          <SearchIcon size={16} strokeWidth={1.5} aria-hidden="true" />
        </button>
      ) : null}
      <button
        type="button"
        aria-label="Open automations"
        aria-pressed={props.automationsActive}
        className={`sidebar__icon-button${props.automationsActive ? " is-active" : ""}`}
        onClick={props.onOpenAutomations}
      >
        <AutomationsIcon size={16} strokeWidth={1.5} aria-hidden="true" />
      </button>
      <button
        type="button"
        aria-label="Open settings"
        aria-pressed={props.settingsActive}
        className={`sidebar__icon-button${props.settingsActive ? " is-active" : ""}`}
        onClick={props.onOpenSettings}
      >
        <SettingsIcon size={16} strokeWidth={1.5} aria-hidden="true" />
      </button>
      <button
        type="button"
        aria-label="New thread"
        className="sidebar__icon-button"
        disabled={Boolean(props.creatingThread)}
        onClick={() => {
          void props.onCreateThread?.();
        }}
      >
        <NewThreadIcon size={16} strokeWidth={1.5} aria-hidden="true" />
      </button>
    </div>
  );
}
