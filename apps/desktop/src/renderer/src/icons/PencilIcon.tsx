import { memo } from "react";
import { resolveIconSvgProps, type IconProps } from "./icon-types";

/**
 * A pencil over a baseline — the "edit" glyph. The paths are PwrSnap's
 * `pen-line` (`FoIcons`) verbatim, so an edit reads the same across the Pwr
 * apps. Used for row-level Edit actions that sit in too little room for a
 * text label, such as a queued message's hover actions.
 */
export const PencilIcon = memo(function PencilIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
});
