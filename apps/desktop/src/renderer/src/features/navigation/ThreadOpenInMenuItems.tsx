import { ContextMenuCascade } from "./ContextMenuCascade";
import { OpenTargetIcon } from "./SidebarThreadCard";
import type { ThreadCardOpenTarget } from "./thread-card-open-targets";

/**
 * The thread menu's "Open in…", for the open icons past the four the thread
 * card's row holds. Only the card's ⋯ passes any.
 */
export function ThreadOpenInMenuItems(props: {
  targets: readonly ThreadCardOpenTarget[];
  run: (target: ThreadCardOpenTarget) => void;
  onDone: () => void;
}) {
  if (props.targets.length === 0) return null;
  return (
    <div className="thread-context-menu__section">
      <ContextMenuCascade label="Open in…" groupLabel="Open in">
        {props.targets.map((target) => (
          <button
            key={target.id}
            className="thread-context-menu__open-in"
            role="menuitem"
            type="button"
            onClick={() => {
              props.onDone();
              props.run(target);
            }}
          >
            <OpenTargetIcon target={target} />
            <span>{target.kind === "application" ? target.application.name : target.label}</span>
          </button>
        ))}
      </ContextMenuCascade>
    </div>
  );
}
