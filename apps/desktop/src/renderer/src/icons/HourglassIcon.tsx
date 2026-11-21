import { memo } from "react";
import { resolveIconSvgProps, type IconProps } from "./icon-types";

/** An hourglass with sand settled in the bottom bulb: the thread is waiting
 *  for something to wake it. */
export const HourglassIcon = memo(function HourglassIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <path d="M6 3h12" />
      <path d="M6 21h12" />
      <path d="M7.5 3v2.6a4 4 0 0 0 1.4 3.05L12 12l3.1-3.35a4 4 0 0 0 1.4-3.05V3" />
      <path d="M7.5 21v-2.6a4 4 0 0 1 1.4-3.05L12 12l3.1 3.35a4 4 0 0 1 1.4 3.05V21" />
      <path d="M9.5 18.5h5" />
    </svg>
  );
});
