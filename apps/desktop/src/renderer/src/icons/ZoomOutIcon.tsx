import { memo } from "react";
import { resolveIconSvgProps, type IconProps } from "./icon-types";

/** `ZoomInIcon` without the upright stroke. */
export const ZoomOutIcon = memo(function ZoomOutIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
      <path d="M8 11h6" />
    </svg>
  );
});
