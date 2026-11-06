import { memo } from "react";
import { resolveIconSvgProps, type IconProps } from "./icon-types";

/** Lucide `minimize-2`: send a dialog into the toast stack. */
export const MinimizeIcon = memo(function MinimizeIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <path d="m14 10 7-7" />
      <path d="M20 10h-6V4" />
      <path d="m3 21 7-7" />
      <path d="M4 14h6v6" />
    </svg>
  );
});
