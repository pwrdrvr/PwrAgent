import { memo } from "react";
import { resolveIconSvgProps, type IconProps } from "./icon-types";

/** A filled square: stop a running turn. */
export const StopIcon = memo(function StopIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
    </svg>
  );
});
