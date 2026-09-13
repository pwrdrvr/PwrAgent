import { memo } from "react";
import { resolveIconSvgProps, type IconProps } from "./icon-types";

export const MoreVerticalIcon = memo(function MoreVerticalIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <circle cx="12" cy="5" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="19" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
});
