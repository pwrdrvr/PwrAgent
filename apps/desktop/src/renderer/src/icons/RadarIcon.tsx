import { memo } from "react";
import { resolveIconSvgProps, type IconProps } from "./icon-types";

/** A radar sweep: a monitor checks on something until it changes. */
export const RadarIcon = memo(function RadarIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="4" />
      <path d="M12 12l5.5-5.5" />
    </svg>
  );
});
