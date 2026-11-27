import { memo } from "react";
import { resolveIconSvgProps, type IconProps } from "./icon-types";

export const MoreHorizontalIcon = memo(function MoreHorizontalIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
});
