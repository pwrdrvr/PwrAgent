import { useId, type ReactElement } from "react";
import {
  describeFederationThreadTargetAvailability,
  type FederationThreadTarget,
  type FederationThreadTargetAvailability,
} from "./federation-thread-targets";

const AVAILABILITY_STATE_LABEL: Partial<
  Record<FederationThreadTargetAvailability, string>
> = {
  offline: "Offline",
  unsupported: "Unsupported",
};

/**
 * The "New chat on <machine>" group shared by the New Thread flyout and the
 * per-directory launchpad split button, so both surfaces read identically.
 *
 * The verb lives in the group label rather than on each row. Rows are
 * `text-overflow: ellipsis` inside a card capped at 320px, and repeating
 * "New chat on " per row spent about a quarter of that budget pushing the
 * machine label — including the ` / <profile>` suffix that exists precisely
 * to tell two entries apart — toward the clip.
 *
 * The label is a real `role="group"` with `aria-labelledby` rather than a
 * presentational div: without it a screen reader hears one undifferentiated
 * run of menu items and never learns that these ones start work on another
 * machine.
 */
export function FederationTargetMenuSection(props: {
  onSelect: (instanceId: string) => void;
  targets: readonly FederationThreadTarget[];
}): ReactElement {
  const labelId = useId();
  return (
    <div role="group" aria-labelledby={labelId}>
      <div className="new-thread-menu__section-label" id={labelId}>
        New chat on
      </div>
      {props.targets.map((target) => {
        const stateLabel = AVAILABILITY_STATE_LABEL[target.availability];
        const unavailable = target.availability !== "available";
        return (
          <button
            key={target.instanceId}
            type="button"
            role="menuitem"
            className="new-thread-menu__item new-thread-menu__item--target"
            // `aria-disabled`, not `disabled`: a disabled button leaves the tab
            // order, and this menu has no arrow-key navigation, so the real
            // `disabled` attribute would hide unreachable machines from
            // keyboard and screen-reader users entirely — the opposite of why
            // they are listed instead of filtered out.
            aria-disabled={unavailable || undefined}
            title={describeFederationThreadTargetAvailability(
              target.availability,
            )}
            onClick={() => {
              if (unavailable) {
                return;
              }
              props.onSelect(target.instanceId);
            }}
          >
            <span
              aria-hidden="true"
              className="new-thread-menu__target-dot"
              data-availability={target.availability}
            />
            <span className="new-thread-menu__target-name">{target.label}</span>
            {stateLabel ? (
              <span className="new-thread-menu__target-state">{stateLabel}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
