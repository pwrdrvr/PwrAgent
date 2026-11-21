import { memo } from "react";
import { resolveIconSvgProps, type IconProps } from "./icon-types";

/**
 * An activity trace: a log of what happened over time (the PR activity tab's
 * Auto-fix journal). `HistoryIcon` already means the Updated lens, Rewind,
 * and recurring wakes, so this tab does not reuse it.
 */
export const ActivityIcon = memo(function ActivityIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <path d="M2.5 12h4l3-7.5 5 15 3-7.5h4" />
    </svg>
  );
});
