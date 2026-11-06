import { memo } from "react";
import { resolveIconSvgProps, type IconProps } from "./icon-types";

/** A crescent: something put away for now, such as a hibernated checkout. */
export const MoonIcon = memo(function MoonIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />
    </svg>
  );
});
