import { memo } from "react";
import { resolveIconSvgProps, type IconProps } from "./icon-types";

/**
 * A calendar with a clock: scheduled runs. Shared by the title-bar
 * Automations button and the context rail's Automations tab. The clock keeps
 * it apart from the Created lens's calendar-plus.
 */
export const AutomationsIcon = memo(function AutomationsIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <path d="M21 9.5V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4.5" />
      <path d="M8 3v4" />
      <path d="M16 3v4" />
      <path d="M3 10h7" />
      <circle cx="16.5" cy="16.5" r="5" />
      <path d="M16.5 14.25v2.25l1.5 1" />
    </svg>
  );
});
