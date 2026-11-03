import { memo } from "react";
import { resolveIconSvgProps, type IconProps } from "./icon-types";

/** A clock face: something happens at a set time. */
export const ClockIcon = memo(function ClockIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  );
});
