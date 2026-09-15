import { memo } from "react";
import { resolveIconSvgProps, type IconProps } from "./icon-types";

/** `SearchIcon`'s magnifier with a plus in the lens — the conventional
 *  zoom-in glyph, drawn on the same circle so the pair reads as one set. */
export const ZoomInIcon = memo(function ZoomInIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
      <path d="M8 11h6" />
      <path d="M11 8v6" />
    </svg>
  );
});
