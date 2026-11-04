import { memo } from "react";
import { resolveIconSvgProps, type IconProps } from "./icon-types";

/** An hourglass: the thread is waiting for something to wake it. */
export const HourglassIcon = memo(function HourglassIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <path d="M6.5 3.5h11M6.5 20.5h11" />
      <path d="M7.5 3.5c0 4.5 9 4.5 9 8.5s-9 4-9 8.5" />
      <path d="M16.5 3.5c0 4.5-9 4.5-9 8.5s9 4 9 8.5" />
    </svg>
  );
});
