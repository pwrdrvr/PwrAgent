import { memo } from "react";
import { resolveIconSvgProps, type IconProps } from "./icon-types";

/**
 * The lidded can with two slats — the "delete" glyph. The paths are
 * PwrSnap's `trash` (`PsIcon`, design T2) verbatim, so a delete reads the
 * same across the Pwr apps; keep the two in step. Used for row-level Delete
 * actions that sit in too little room for a text label.
 */
export const TrashIcon = memo(function TrashIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <path d="M3.5 6h17" />
      <path d="M8.5 6V4.5A1.5 1.5 0 0 1 10 3h4a1.5 1.5 0 0 1 1.5 1.5V6" />
      <path d="M5.5 6l.95 13.1A2 2 0 0 0 8.45 21h7.1a2 2 0 0 0 2-1.9L18.5 6" />
      <path d="M10 10.5v6M14 10.5v6" />
    </svg>
  );
});
