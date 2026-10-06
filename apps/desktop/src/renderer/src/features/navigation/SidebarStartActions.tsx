import type { ReactElement, ReactNode } from "react";
import { FolderPlusIcon, NewThreadIcon } from "../../icons";

/**
 * Start Chat and Add Project Folder, as the thread list's last item.
 *
 * The masthead's New Thread button holds both actions too, but behind a hover
 * flyout. On a profile with no threads that icon was the only way forward,
 * and the list under it said nothing but "No threads yet." — so the empty
 * list now carries its own next step.
 *
 * Always last, in every lens, rather than only until the rows overflow: a
 * control that shows or hides with window height and list length would come
 * and go as threads land. Last in the list it sits right under the empty
 * state on day one and scrolls out of the way once there is history. It
 * leads (`lead`) only while no thread exists.
 *
 * Both run the flyout's own handlers ("New chat without a directory", "Add a
 * Project Directory…"), so there is one code path per action.
 */
export function SidebarStartActions(props: {
  /** No thread exists yet, so starting one is the next step, not a footer. */
  lead: boolean;
  creatingThread: boolean;
  addingProjectDirectory: boolean;
  onStartChat?: () => void;
  onAddProjectFolder?: () => void;
}): ReactElement {
  return (
    <div className={`sidebar-start-actions${props.lead ? " sidebar-start-actions--lead" : ""}`}>
      {props.onStartChat ? (
        <StartActionButton
          busy={props.creatingThread}
          className="sidebar-start-actions__button sidebar-start-actions__button--chat"
          icon={<NewThreadIcon size={14} />}
          label="Start Chat"
          onClick={props.onStartChat}
        />
      ) : null}
      {props.onAddProjectFolder ? (
        <StartActionButton
          busy={props.addingProjectDirectory}
          className="sidebar-start-actions__button"
          icon={<FolderPlusIcon size={14} />}
          // Matches the flyout's in-flight label: the picker closes before
          // the registration finishes, so the window is interactive while
          // this still runs.
          label={props.addingProjectDirectory ? "Adding Project Folder…" : "Add Project Folder"}
          onClick={props.onAddProjectFolder}
        />
      ) : null}
    </div>
  );
}

function StartActionButton(props: {
  busy: boolean;
  className: string;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      className={props.className}
      // `aria-disabled`, not `disabled`, for the reason `SidebarShowMore`
      // gives: disabling a focused control drops keyboard focus to <body>.
      aria-disabled={props.busy || undefined}
      onClick={() => {
        if (props.busy) return;
        props.onClick();
      }}
    >
      <span aria-hidden="true" className="sidebar-start-actions__icon">{props.icon}</span>
      {props.label}
    </button>
  );
}
