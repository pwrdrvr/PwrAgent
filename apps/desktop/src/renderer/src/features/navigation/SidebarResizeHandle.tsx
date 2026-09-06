import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent,
  ReactElement,
} from "react";

type SidebarResizeHandleProps = {
  onResizeStart?: (event: PointerEvent<HTMLElement>) => void;
  onResizeByKeyboard?: (delta: number) => void;
  /**
   * Current sidebar width and clamp range, exposed as aria-valuenow /
   * aria-valuemin / aria-valuemax — required by axe-core for a focusable
   * role="separator".
   */
  sidebarWidth: number;
  sidebarMinWidth: number;
  sidebarMaxWidth: number;
};

/**
 * The drag seam between the sidebar and the main pane.
 *
 * Rendered as a sibling of `.sidebar` inside `.app-shell`, NOT inside the
 * sidebar: `.sidebar` is `overflow: hidden`, which clips at its padding box,
 * so a child can never paint on the sidebar's own border-right pixel, let
 * alone straddle it. Living in the shell lets the handle sit centered on the
 * seam (see `.sidebar__resize-handle` in app.css), which keeps its hit area
 * off the thread lane's scrollbar and lights up the border itself on hover.
 */
export function SidebarResizeHandle(
  props: SidebarResizeHandleProps,
): ReactElement {
  return (
    <div
      aria-label="Resize thread sidebar"
      aria-orientation="vertical"
      aria-valuenow={props.sidebarWidth}
      aria-valuemin={props.sidebarMinWidth}
      aria-valuemax={props.sidebarMaxWidth}
      className="sidebar__resize-handle"
      role="separator"
      tabIndex={0}
      onKeyDown={(event: ReactKeyboardEvent<HTMLElement>) => {
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          props.onResizeByKeyboard?.(-16);
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          props.onResizeByKeyboard?.(16);
        }
      }}
      onPointerDown={props.onResizeStart}
    />
  );
}
