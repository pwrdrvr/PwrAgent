/**
 * Mid-turn, a composer's primary action queues behind the running turn and
 * the platform's primary accelerator + Enter steers into it instead: ⌘Enter
 * on macOS, Ctrl+Enter on Windows/Linux. Ctrl alone on macOS (and the
 * Windows key elsewhere) is not the chord — the strict check keeps it from
 * reading as one. Both composers share this so the chord and its tooltip
 * cannot drift apart.
 */
import { useCallback, useEffect, type ReactNode } from "react";
import {
  formatPrimaryAccel,
  isPlatformPrimaryAccel,
} from "../../lib/keyboard-accel";
import { useViewportTooltip } from "../../lib/useViewportTooltip";

export function isSteerShortcut(
  event: Pick<KeyboardEvent, "ctrlKey" | "metaKey">,
): boolean {
  return isPlatformPrimaryAccel(event);
}

/** Tooltip for a Queue button whose running turn can take a steer. */
export function formatQueueButtonTooltip(): string {
  return `Queue after this turn · ${formatPrimaryAccel("Enter")} to steer it in`;
}

/**
 * Names the steer chord on a Queue button while `enabled`. Spread
 * `buttonProps` on the button and render `tooltipNode` beside it. A turn
 * that ends under the pointer takes the hint down with it.
 */
export function useQueueSteerTooltip(enabled: boolean): {
  buttonProps: {
    "aria-describedby": string | undefined;
    onBlur: () => void;
    onFocus: (event: { currentTarget: HTMLElement }) => void;
    onMouseEnter: (event: { currentTarget: HTMLElement }) => void;
    onMouseLeave: () => void;
  };
  tooltipNode: ReactNode;
} {
  const { hide, show, tooltipId, tooltipNode, visible } = useViewportTooltip({
    className: "viewport-tooltip",
  });
  useEffect(() => {
    if (!enabled) hide();
  }, [enabled, hide]);
  const showHint = useCallback(
    (event: { currentTarget: HTMLElement }) => {
      if (enabled) show(event.currentTarget, formatQueueButtonTooltip());
    },
    [enabled, show],
  );
  return {
    buttonProps: {
      "aria-describedby": enabled && visible ? tooltipId : undefined,
      onBlur: hide,
      onFocus: showHint,
      onMouseEnter: showHint,
      onMouseLeave: hide,
    },
    tooltipNode,
  };
}
