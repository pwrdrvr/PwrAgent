import type { ReactNode } from "react";
import { ArrowLeftToLineIcon } from "../../../icons";

export const SHOW_CONNECTIONS_ON_LAUNCHPAD_LABEL = "Show on new thread";

/**
 * The launchpad's connection cards after the operator moved them to the
 * rail. The cards are the same elements the launchpad renders, so every
 * control they had (switches, Connect, downloads) keeps working here.
 */
export function ConnectionsPanel(props: {
  children: ReactNode;
  /** `keyboard` is true when the button was activated from the keyboard. */
  onShowOnLaunchpad: (keyboard: boolean) => void;
}) {
  return (
    <section className="context-panel__section connections-panel">
      <header className="connections-panel__header">
        <h3>Connections</h3>
        <button
          aria-label={SHOW_CONNECTIONS_ON_LAUNCHPAD_LABEL}
          className="edits-panel__dock-toggle tooltip-target"
          data-tooltip={SHOW_CONNECTIONS_ON_LAUNCHPAD_LABEL}
          type="button"
          // A button activated from the keyboard reports a click with detail 0.
          onClick={(event) => props.onShowOnLaunchpad(event.detail === 0)}
        >
          <ArrowLeftToLineIcon size={14} aria-hidden="true" />
        </button>
      </header>
      <div className="pwrsuite-tiles connections-panel__tiles">{props.children}</div>
      {/* Hidden by CSS whenever a card rendered: a remote owner with nothing
          configured leaves every card null. */}
      <p className="context-empty connections-panel__empty">
        Nothing to connect for this thread’s machine.
      </p>
    </section>
  );
}
