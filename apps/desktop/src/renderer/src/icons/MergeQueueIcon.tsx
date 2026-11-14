import { memo } from "react";
import { resolveIconSvgProps, type IconProps } from "./icon-types";

/** Three stacked rows: a merge queue or merge train. */
export const MergeQueueIcon = memo(function MergeQueueIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <path d="M4 6h16" />
      <path d="M4 12h16" />
      <path d="M4 18h10" />
    </svg>
  );
});
