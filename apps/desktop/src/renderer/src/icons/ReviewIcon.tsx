import { memo } from "react";
import { resolveIconSvgProps, type IconProps } from "./icon-types";

export const ReviewIcon = memo(function ReviewIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
});
